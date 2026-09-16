#!/usr/bin/env bash
# stack-map.sh — read-only. Pin one PR's place in its stack.
#
# A stack here is the chain of open PRs joined by base branch: layer k+1's base
# is layer k's head. The script walks that chain from the given PR down to the
# trunk (the first base with no open PR of its own) and up through every open
# PR based on it, then asks GitHub whether the PR belongs to a registered Stack.
#
# Usage:   stack-map.sh <pr> [owner/repo]
# Output:  one JSON object on stdout:
#   {
#     "pr": 378, "trunk": "main", "trunk_is_default_branch": true,
#                                            # false = the chain bottoms out on a branch whose PR
#                                            #   is already merged/closed; the open stack is a tail
#     "in_stack": true,                      # false when the PR has no parent and no child
#     "layers": [ {number, head, base, title, is_draft, position}, ... ],   # bottom-to-top
#     "position": 17,                        # 1-based index of <pr> in layers
#     "parents":  [ {number, head}, ... ],   # below <pr>, nearest first
#     "children": [ {number, head}, ... ],   # above <pr>, nearest first, along the main line
#     "siblings": [ {number, head}, ... ],   # other open PRs sharing <pr>'s base
#     "tip":      {number, head},            # the top of the main line
#     "forks":    [ {at: <pr number>, branches: [{number, head}]} ],  # a layer with >1 child
#     "registered": { "stack_number": 12, "size": 19 } | null,
#     "fetched": true|false                  # did `git fetch origin` succeed (when run in a git repo)
#   }
# The main line above <pr> follows the child that most other open PRs are based
# on; a layer with more than one child is reported under "forks" so the caller
# can sweep every branch rather than trusting the pick.
set -euo pipefail

PR="${1:?usage: stack-map.sh <pr> [owner/repo]}"
REPO="${2:-}"
if [[ -z "$REPO" ]]; then
  REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
fi
OWNER="${REPO%%/*}"
NAME="${REPO##*/}"
DEFAULT_BRANCH="$(gh repo view "$REPO" --json defaultBranchRef -q .defaultBranchRef.name)"

# Every open PR, once. 300 is generous for one repo's open set; raise if a repo
# keeps more than that open.
PRS_JSON="$(gh pr list --repo "$REPO" --state open --limit 300 \
  --json number,headRefName,baseRefName,title,isDraft)"

# Registered-stack membership, from the PullRequest.stack field. `null` means
# the PR is not in a GitHub Stack; the field itself missing means the API is
# not enabled for this repo, which the script reports as null too.
STACK_JSON="$(gh api graphql -F owner="$OWNER" -F name="$NAME" -F pr="$PR" -f query='
query($owner:String!,$name:String!,$pr:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$pr){ stack{ number size } }
  }
}' 2>/dev/null || echo '{"data":{"repository":{"pullRequest":{"stack":null}}}}')"

# Refresh remote-tracking refs so the caller's sweep reads current code. Only
# when we are inside a git repo; a failure is reported, not fatal.
FETCHED=false
if git rev-parse --git-dir >/dev/null 2>&1; then
  if git fetch --quiet origin 2>/dev/null; then FETCHED=true; fi
fi

PR="$PR" FETCHED="$FETCHED" DEFAULT_BRANCH="$DEFAULT_BRANCH" python3 - "$PRS_JSON" "$STACK_JSON" <<'PY'
import json, os, sys

pr = int(os.environ["PR"])
fetched = os.environ["FETCHED"] == "true"
default_branch = os.environ["DEFAULT_BRANCH"]
prs = json.loads(sys.argv[1])
stack = (json.loads(sys.argv[2]).get("data") or {}).get("repository", {}).get("pullRequest") or {}
registered = stack.get("stack")

by_head = {p["headRefName"]: p for p in prs}
by_base = {}
for p in prs:
    by_base.setdefault(p["baseRefName"], []).append(p)

me = next((p for p in prs if p["number"] == pr), None)
if me is None:
    print(json.dumps({"error": f"PR #{pr} is not open in this repo"}), file=sys.stderr)
    sys.exit(1)

def brief(p):
    return {"number": p["number"], "head": p["headRefName"]}

# Down to the trunk.
parents, cur = [], me
seen = {me["number"]}
while cur["baseRefName"] in by_head:
    nxt = by_head[cur["baseRefName"]]
    if nxt["number"] in seen:
        break  # a cycle would be a broken repo; stop rather than loop
    seen.add(nxt["number"])
    parents.append(nxt)
    cur = nxt
trunk = cur["baseRefName"]

# Up along the main line. At a fork, follow the child with the deepest chain
# above it; report the fork so the caller sweeps the other branches too.
def depth(p, seen=()):
    kids = by_base.get(p["headRefName"], [])
    kids = [k for k in kids if k["number"] not in seen]
    if not kids:
        return 0
    return 1 + max(depth(k, seen + (p["number"],)) for k in kids)

children, forks, cur = [], [], me
while True:
    kids = by_base.get(cur["headRefName"], [])
    if not kids:
        break
    kids = sorted(kids, key=lambda k: (-depth(k), k["number"]))
    if len(kids) > 1:
        forks.append({"at": cur["number"], "branches": [brief(k) for k in kids]})
    children.append(kids[0])
    cur = kids[0]

siblings = [brief(p) for p in by_base.get(me["baseRefName"], []) if p["number"] != pr]

line = list(reversed(parents)) + [me] + children
layers = []
for i, p in enumerate(line, start=1):
    layers.append({
        "number": p["number"], "head": p["headRefName"], "base": p["baseRefName"],
        "title": p["title"], "is_draft": p["isDraft"], "position": i,
    })

out = {
    "pr": pr,
    "trunk": trunk,
    "trunk_is_default_branch": trunk == default_branch,
    "in_stack": bool(parents or children),
    "layers": layers,
    "position": len(parents) + 1,
    "parents": [brief(p) for p in parents],
    "children": [brief(p) for p in children],
    "siblings": siblings,
    "tip": brief(line[-1]),
    "forks": forks,
    "registered": ({"stack_number": registered["number"], "size": registered["size"]}
                   if registered else None),
    "fetched": fetched,
}
print(json.dumps(out, indent=2))
PY

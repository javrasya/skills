#!/usr/bin/env bash
# fetch-comments.sh — read-only. List in-scope PR review comments.
#
# In scope = the comment's review thread is unresolved AND that thread has no
# reply from the current gh user. By default comments from every reviewer
# (human or bot) are in scope; pass --author <login> to narrow to one reviewer.
#
# Usage:   fetch-comments.sh <pr> [--author <login>] [owner/repo]
# Output:  JSON array on stdout. Each element:
#          { comment_id, thread_id, path, line, diff_hunk, body, html_url, author }
#          Skipped threads are reported as a JSON object on stderr for logging.
set -euo pipefail

PR="${1:?usage: fetch-comments.sh <pr> [--author <login>] [owner/repo]}"
shift

AUTHOR=""
REPO=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --author) AUTHOR="${2:?--author needs a login}"; shift 2 ;;
    --author=*) AUTHOR="${1#--author=}"; shift ;;
    */*) REPO="$1"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$REPO" ]]; then
  REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
fi
OWNER="${REPO%%/*}"
NAME="${REPO##*/}"

ME="$(gh api user -q .login)"

# REST: all review comments (paginated). --paginate concatenates pages into one
# JSON array for array endpoints.
COMMENTS_JSON="$(gh api "repos/$OWNER/$NAME/pulls/$PR/comments" --paginate)"

# GraphQL: review threads with resolve state, thread node id, and per-thread comment authors.
THREADS_JSON="$(gh api graphql -F owner="$OWNER" -F name="$NAME" -F pr="$PR" -f query='
query($owner:String!,$name:String!,$pr:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$pr){
      reviewThreads(first:100){
        nodes{
          id
          isResolved
          comments(first:100){ nodes{ databaseId author{login} } }
        }
      }
    }
  }
}')"

# Join in Python: for each review comment, find its thread (by databaseId membership),
# keep only unresolved threads with no reply authored by $ME. If AUTHOR is set,
# keep only comments authored by that login.
ME="$ME" AUTHOR="$AUTHOR" python3 - "$COMMENTS_JSON" "$THREADS_JSON" <<'PY'
import json, os, sys

me = os.environ["ME"]
author = os.environ.get("AUTHOR") or None
comments = json.loads(sys.argv[1])
threads = json.loads(sys.argv[2])["data"]["repository"]["pullRequest"]["reviewThreads"]["nodes"]

# Map every comment databaseId -> its thread node.
db_to_thread = {}
for t in threads:
    for c in t["comments"]["nodes"]:
        db_to_thread[c["databaseId"]] = t

def thread_has_my_reply(t):
    return any((c.get("author") or {}).get("login") == me for c in t["comments"]["nodes"])

out, skipped = [], []
for c in comments:
    login = (c.get("user") or {}).get("login")
    if author is not None and login != author:
        continue
    # Never treat the current user's own comments as in-scope reviewer comments.
    if login == me:
        continue
    t = db_to_thread.get(c["id"])
    if t is None:
        skipped.append({"comment_id": c["id"], "reason": "no matching review thread"})
        continue
    if t["isResolved"]:
        skipped.append({"comment_id": c["id"], "reason": "thread already resolved"})
        continue
    if thread_has_my_reply(t):
        skipped.append({"comment_id": c["id"], "reason": f"thread already has reply from {me}"})
        continue
    out.append({
        "comment_id": c["id"],
        "thread_id": t["id"],
        "path": c.get("path"),
        "line": c.get("line") or c.get("original_line"),
        "diff_hunk": c.get("diff_hunk"),
        "body": c.get("body"),
        "html_url": c.get("html_url"),
        "author": login,
    })

if skipped:
    print(json.dumps({"skipped": skipped}, indent=2), file=sys.stderr)
print(json.dumps(out, indent=2))
PY

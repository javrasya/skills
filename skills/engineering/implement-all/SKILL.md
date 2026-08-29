---
name: implement-all
description: Chew through a map's tickets one at a time, unattended, until the frontier stops it. Each ticket lands as a green, stacked PR the operator merges by hand.
disable-model-invocation: true
argument-hint: "#<map> [count] [--dry]"
---

# Implement All

Chew through a map's tickets one at a time, unattended, until the frontier stops it.

Outer loop: **one map is consumed, ticket by ticket.** Inner loop: **one ticket becomes one green, stacked PR.** The operator merges to `main` themselves, one PR at a time, after verifying each.

This does **not** call `/implement-next`. The loop needs the frontier *before* claiming, skips where that skill asks, and replaces its implement step with a five-stage `Workflow` — almost nothing is left to reuse. What the two share is the definition of *takeable*, and that lives in the repo, not in either skill.

The loop is continuous *through tickets*, not through the operator's interventions. It dies on any pause condition and is re-armed with the same one-line command. **Dying is cheap by design** — a re-armed run derives everything from GitHub and holds no local state.

## Arguments

`/implement-all #<map> [count] [--dry]`

- **`#<map>`** — the parent issue whose sub-issues are the tickets. Required.
- **`count`** — bound the run to N tickets. Optional; **no ceiling by default**, because a cap contradicts the point of the loop. It is enforced at the top of the loop — [tick step 0](#the-tick).
- **`--dry`** — resolve, report the plan and the gate state, then stop. **Claim nothing, implement nothing.** Concretely: run arm steps 0–3, then resolve the frontier as in tick step 1 so the plan is real; stop there. **Never arm step 4** — a dry run does not create `.worktrees/chain` and does not write `.git`. **Never tick step 3** — no claim.

  **No arm check is a refusal under `--dry`.** Report what each one found — the sweep's hits in step 1, both greenlights on the tip in step 3 — and carry on to the frontier resolution, naming in the brief which pause row each *would* have fired. One rule for every arm step, because reporting the gate state is the whole point of a dry run and a stale claim at step 1 must not swallow the plan the operator asked for.

If the operator prefixes the run with a `+500k`-style budget directive, honour it and stop **between** ticks when it is nearly spent — never mid-tick. That check is also [tick step 0](#the-tick).

## Takeable

**Takeable is defined once, in the repo.** Read the frontier fragment named in the repo's `CLAUDE.md` under **Frontier query** — `docs/agents/frontier.md` — and use it verbatim. Do not restate it here and do not let it drift.

**Two things in that file bind, not one.** The query with its four conditions is the first. The second is its **"When the frontier is empty"** table: five distinct facts an empty frontier can be, with what each means and what to say. Those five are pause rows 2–6 of this skill, one for one, and they are the *only* place rows 2, 5 and 6 are given a discriminator. A halt names which fact it is — see [Skipping](#skipping).

One divergence, and it is the only one: `/implement-next` **asks** on `ready-for-human`; `/implement-all` **skips**.

## Shape

You are the driver. The `while` lives in this session; each ticket is one `Workflow` call, and this skill is the authorisation for that call — no `ultracode` keyword is needed at the prompt. Do not move the loop inside a Workflow script: scripts have no model in the driver's seat, so the per-ticket workflow could not be authored *from the ticket*, and `workflow()` nests only one level deep.

**Strictly serial.** One ticket in flight. Ticket N+1 branches from N, so parallelism is meaningless.

## The gate

Two greenlights, both required, before the next ticket starts:

1. **The previous ticket's issue is closed.**
2. **The previous ticket's PR build is green.**

**Merging to `main` is not a gate.** The operator merges by hand; the loop only pushes branches and opens PRs.

The tick is arranged so the two cannot disagree: **the close is held until CI is green**, so the loop never closes an issue whose PR is red. Re-arm still tests both independently — a human can close an issue by hand, and CI can be re-run and go red after the fact.

## Arm sequence

Once, before the first tick.

**0. Fetch, and resolve the run's constants.** `git fetch --prune origin` in the main checkout, before anything else. Tip derivation is from GitHub and yields a sha; `git worktree add` needs that object present locally, and the no-open-PR fallback reads `origin/main`, which is only ever as fresh as the last fetch.

Resolve three things **once, here**, and write each one out in full at every later use — shell state does not survive between tool calls, so nothing may be carried in a variable:

- **the repo root**, `git rev-parse --show-toplevel`. The chain worktree is `<repo-root>/.worktrees/chain`, and agents are given that path absolute.
- **the verify command and its environment prerequisites** — [Local toolchain](#local-toolchain). The same strings serve every pre-flight of the run and every agent prompt that builds or tests.
- **the CI ceiling** — [tick step 10](#the-tick). It is what pause row 10 fires on, so it is fixed here and never re-judged mid-run.

All three go in the brief, so a re-arm can be checked against what the last run used.

**1. Sweep for the operator's own claims.** `gh api --jq` has no `--arg`, so interpolate the login; `gh issue list --assignee @me` is repo-wide and would answer the wrong question.

```bash
ME=$(gh api user --jq .login)
gh api "repos/<owner>/<repo>/issues/<map>/sub_issues?per_page=100" --paginate \
  --jq ".[] | select(.state == \"open\" and ([.assignees[].login] | any(. == \"$ME\"))) | \"#\(.number)  \(.title)\""
```

Any hit means a previous run died mid-tick. **Die and say so**, naming the ticket and whether it has an open PR (`gh pr list --state open --limit 200 --json number,headRefName --jq '.[] | select(.headRefName | test("^worktree-<n>-"))'`), and offer to resume it by hand or to unassign it. Do not resume automatically — the loop cannot tell a finished branch from a half-written one, and guessing unattended is worse than asking.

**2. Derive the stack tip.** The rule is **the open PR whose head branch is not the base of any other open PR; no open PRs → the tip is `main`**, and the base for the first PR of the run is the branch name `main`.

**Candidates are this map's own stack** — the branches the loop itself creates, `worktree-<n>-<slug>` where `<n>` is a sub-issue of the map. That narrowing is not in the rule as stated and it is here for a measured reason: any unrelated open PR is also nobody's base, so the unnarrowed rule returns more than one row against this repo today and picking the wrong one cuts the whole run off a foreign branch. The sub-issue list is already the loop's scope everywhere else, so this costs no new dependency.

`--limit` matters: `gh pr list` defaults to 30 rows and the stack has **no depth cap**, so a truncated list would compute a wrong tip silently — which is corruption, not a pause condition.

```bash
STACK_RE="^worktree-($(gh api "repos/<owner>/<repo>/issues/<map>/sub_issues?per_page=100" \
  --paginate --jq '.[].number' | paste -sd'|' -))-"
gh pr list --state open --limit 200 --json number,headRefName,baseRefName,headRefOid \
  --jq "[.[] | select(.headRefName | test(\"$STACK_RE\"))] as \$stack
        | \$stack
        | map(select(.headRefName as \$h | (\$stack | map(.baseRefName) | index(\$h)) == null))
        | .[] | \"TIP #\(.number) head=\(.headRefName) base=\(.baseRefName) sha=\(.headRefOid)\""
```

`gh pr list --jq` has no `--arg`, hence the interpolated `$STACK_RE` and the escaped inner jq variables.

**No PR in the map's stack → the tip is `main`.** Otherwise the row names the tip PR: its **`headRefName`** is the base for the next PR and its **`headRefOid`** is the sha the worktree is cut onto. Both are in the emitted row, so nothing downstream has to guess where they came from.

The stack is linear by construction — each tick branches from the previous — so **exactly one head is nobody's base**. Two rows means that invariant is broken and the derivation has no answer; say so and stop rather than choosing one, because building on a guessed tip is corruption, not a pause condition.

**3. Check the tip's gate.** Both greenlights on the tip PR: **its ticket closed**, and **its build green**. Tip is `main` → the stack is empty, there is no gate to check, go to step 4.

The tip PR's ticket is the `<n>` in its own head branch, which is the same `<n>` as the `(#n)` its title ends with:

```bash
TIP_PR=<number from step 2>
TICKET=$(gh pr view "$TIP_PR" --json headRefName --jq '.headRefName | capture("^worktree-(?<n>[0-9]+)-") | .n')
gh issue view "$TICKET" --json number,state,title --jq '"#\(.number) \(.state) \(.title)"'
gh pr checks "$TIP_PR" --json name,state,bucket,link,workflow   # exit 0 all pass, 8 pending, 1 failing
```

- Ticket not `CLOSED` → **pause row 7**, naming what is unmet.
- Build not green → **pause row 8**. Green means every check reports `COMPLETED` with a `SUCCESS` conclusion. **An empty rollup, or "no checks reported", is pending — never green.** The same rule as tick step 10, and it binds here: arming on an unreported tip is building on an unverified tip.

  Row 8's fact is *the tip's build is not green*, and the brief must say **which kind of not-green**, because a pending tip has no failing job to name:
  - a check failed → **name the failing job**, as the row says.
  - pending, or no checks reported → say that **no check has concluded on the tip**, and name the run ([The run id](#the-run-id), with the tip's head branch). Never report a pending tip as a failing job that does not exist.
- Under `--dry` this is reported, not refused — see [Arguments](#arguments).

**4. Prepare the chain worktree.** See [The chain worktree](#the-chain-worktree). Skipped entirely under `--dry`.

## The tick

**0. Should there be another tick at all?** At the top of the loop, before resolving anything and long before the claim of step 3 — so neither stop can leave a claim behind.

- **`count`.** Keep a **completed-tick counter** for the run, starting at 0 and incremented once per tick that reaches green at step 10. `count` was given and the counter has reached it → stop cleanly with the brief. Brief item 1 then says the **bound was met**, not that the frontier ran out; those are different facts and the run must not report the wrong one.
- **A `+500k`-style budget directive.** Compare the remaining budget against it. Nearly spent → stop cleanly with the brief, **between** ticks. This is not the same check as step 2: step 2 asks *is there room for this whole tick*, step 0 asks *did the operator's directive already say stop*. Run both.

**1. Resolve the frontier** with the shared query. Take the **first in sub-issue order**, skipping picks that are not agent-takeable — [Skipping](#skipping) says what that means. Never re-rank. `--paginate` applies `--jq` per page, so take the first line of the emitted stream — never jq `first`, `sort_by`, or `.[0]`.

The query emits `#number [labels] title` and **no body**, and both skip filters need more than that, so **read each candidate before taking it**, one at a time, in sub-issue order, stopping at the first takeable one:

```bash
gh issue view <n> --json number,title,labels,body
```

- `ready-for-human` is in the **labels** — skip it.
- **Acceptance criteria are an `## Acceptance criteria` heading whose section carries at least one `- [ ]` item.** That is this repo's ticket shape. A missing heading, or the heading with an empty section, is *no criteria* — skip it, because the Verify fan-out **is** the criteria and a tick over such a ticket would have no definition of done.

**Record every skip the moment it happens** — number, title, and the reason **read from that ticket's own body**: for a `ready-for-human` pick, what its body says needs a human; for a criteria-less one, what its **What to build** was asking for. Nothing in GitHub records a skip, and brief item 3 has no other source; a skip you did not write down is a skip that silently rots.

**2. Check for room.** Not enough context budget to finish a whole tick → stop cleanly with the brief, before claiming. **A tick you cannot finish is worse than one you never started**, because it leaves a claim behind.

**3. Claim, then read the claim back.** The first write of the tick.

```bash
gh issue edit <n> --add-assignee @me
gh issue view <n> --json assignees --jq '[.assignees[].login] | join(",")'
```

`--add-assignee` **adds**; it exits 0 even when another login already holds the issue, so the exit code proves nothing. The read-back is the race detector: **any login other than your own in that list → the claim was lost. Die on pause row 13.**

**Write nothing else on the way out.** Not an unassign, not a comment. A lost race means the issue is someone else's now, and a loop that reaches into it on its way to dying is a loop that can strip a live claim off another session's ticket. Row 13's whole content is *someone else took it*.

**4. Switch the chain worktree** to a new branch off the tip. Every git command of the tick is anchored with `-C .worktrees/chain`.

**The tip moves every tick.** After a green tick the new tip is that tick's PR (step 10), so tick 2's base is tick 1's branch — not the arm-time tip. **Re-derive it here, from GitHub, with arm step 2's command unchanged**, and read `BASE` off the row it prints: *tip derivation is from GitHub, never remembered*, and shell state does not survive between tool calls in any case. No open PR → `BASE=main`. `BASE` is what step 9 opens the PR against.

The worktree is already standing on that tip and nothing is checked out here: arm step 4 detached it onto the tip sha, and every later tick left it on the branch it had just pushed. So `switch -c` from where it stands cuts off the tip by construction.

```bash
git -C .worktrees/chain status --porcelain          # any output → die naming the files
git -C .worktrees/chain switch -c worktree-<n>-<slug>
```

**The anchor is not optional.** This session's cwd is the main checkout: unanchored, the clean guard inspects the wrong tree, and `git switch -c` would cut the ticket branch off the main checkout's `main` and move the main checkout onto it — the wrong parent, and a direct violation of *never touch `main`*.

**5. Author the per-ticket workflow script** from the ticket body — fixed skeleton, dynamic knobs. Read [`WORKFLOW.md`](WORKFLOW.md) before writing a line of it; that file is the whole of stage design, the agent budget, and the reference script.

**6. Run it** via `Workflow`. It returns a structured verdict per acceptance criterion. Anything unmet feeds [Failure and repair](#failure-and-repair).

**7. Pre-flight locally**, in the chain worktree — run the repo's own verify command, resolved once at arm time per [Local toolchain](#local-toolchain). Any environment prerequisite goes in the **same tool call** as the commands; shell state does not survive between tool calls. **Absolute path, and inside a subshell** — never a bare relative `cd`:

```bash
(
  <the repo's environment prerequisites, if it has any>
  cd <repo-root>/.worktrees/chain || exit 1
  <the repo's verify command>
)
```

`<repo-root>` is the absolute path resolved at arm step 0. **Write it out** — a shell variable would be unset by the next tool call, and an unset one expands to nothing, which makes the `cd` land at `/.worktrees/chain` or, worse, succeed somewhere unintended.

**Both halves of that matter.** Bash cwd *persists between tool calls* in this session, so a relative `cd .worktrees/chain` works the first time and fails — or worse, lands somewhere else — the second, which is exactly what a repair round's second pre-flight does. And every git command of the tick is anchored `-C .worktrees/chain`, a path relative to the main checkout: a pre-flight that left the cwd inside the worktree would break step 8's commit. The subshell puts the cwd back.

**A red pre-flight is not a licence to fix until green.** It is the same kind of event as an unmet criterion and a red CI build, and it feeds the same machinery on the **same shared per-ticket budget** — [Failure and repair](#failure-and-repair). Two rounds for the ticket in total, however the reds arrive; out of rounds and still red → the ticket has failed and takes the failure path.

**8. Commit**, in the chain worktree. One commit, message = **the ticket title verbatim, ending `(#n)`**. Fixups are allowed where the work genuinely needed them. Run the [ADR collision guard](#adr-numbering) first.

```bash
git -C .worktrees/chain add -A
git -C .worktrees/chain commit -m "<ticket title verbatim> (#n)"
```

**9. Push and open a PR** with `base` = **the stack tip's head branch name** — see [PR convention](#pr-convention).

```bash
BASE=<the branch step 4 re-derived this tick: the tip PR's headRefName, or `main` when no PR was open>
git -C .worktrees/chain push -u origin worktree-<n>-<slug>
gh pr create --head worktree-<n>-<slug> --base "$BASE" \
  --title "<ticket title verbatim> (#n)" --body-file - <<'EOF'
<the PR body>
EOF
```

`--base` takes a **branch name**, never the tip PR's number. Pass `--head` explicitly and never rely on inference: this session's cwd is the main checkout, so an inferred head is the wrong branch, and an argless `--body` prompts interactively and hangs the unattended run.

**Every PR of the run is opened against the previous one's branch.** A base frozen at the arm-time tip would open a flat fan of PRs all rooted at the same commit — not a stack — and each would then carry every earlier ticket's diff. That is a silent corruption of the whole run's output, not a pause condition.

**10. Poll CI** until conclusion, ceiling **20 minutes** — or ~3× the repo's slowest observed run, whichever is larger. Fix it at arm time and say what it is; the ceiling is what pause row 10 fires on, so it must not be re-judged mid-run.

`gh pr checks` **returns immediately and does not wait**, and foreground `sleep` is blocked in this session, so the poll is a **`Monitor`** whose `timeout_ms` *is* the ceiling. The monitor's own kill is the clock — it is how row 10 fires, and it is the only clock available:

```
Monitor({
  description: 'CI on worktree-<n>-<slug> (PR #<pr>)',
  timeout_ms: 1200000,        // 20 minutes — the ceiling
  persistent: false,          // persistent: true would ignore the ceiling entirely
  command: `
    prev=""
    while true; do
      s=$(gh pr checks <pr> --json name,state,bucket,link,workflow 2>&1) \
        || { echo "poll error: $s"; sleep 30; continue; }
      cur=$(jq -r '.[] | select(.bucket != "pending") | "\\(.name): \\(.bucket)"' <<<"$s" | sort)
      comm -13 <(echo "$prev") <(echo "$cur")
      prev="$cur"
      if jq -e 'length > 0 and all(.[]; .bucket != "pending")' <<<"$s" >/dev/null; then
        echo "ALL CONCLUDED"; break
      fi
      sleep 30
    done`,
})
```

- **`length > 0` is load-bearing.** jq's `all` over an empty array is `true`, so without it the first poll of a PR whose workflows have not registered yet reports everything concluded and the loop closes an issue on nothing. **Empty rollup, or "no checks reported", is pending — never green.** "No failing checks" and "green" are the same JSON; only a `COMPLETED` state with a `SUCCESS` conclusion on every check is green.
- The monitor emits each check as it concludes and exits on `ALL CONCLUDED`. **Re-read the whole rollup once** with a plain `gh pr checks <pr> --json name,state,bucket,link,workflow` before deciding — the monitor reports transitions, the decision is made on the full set.
- **Timeout with no `ALL CONCLUDED`** → the run never concluded within the ceiling → die on **pause row 10**, naming the run ([The run id](#the-run-id)). **Do not re-arm the monitor for a second twenty minutes.** The ceiling is the ceiling.
- A `cancelled` conclusion on a run that **your own later push to the same branch** superseded is the workflow's `cancel-in-progress`, not a failure — re-read the new run. This buys no extra time: a re-push happens only inside a repair round, each repair round starts **one** fresh monitor with **one** fresh ceiling, and repair rounds are capped at two. A run cancelled with no superseding push of your own is red.
- **Green** → comment the outcome on the issue, close it, increment the completed-tick counter of step 0, advance to step 0. The new tip is this PR.
- **Red** → [flake check](#flake-handling), then treat as an unmet criterion and repair.

Closing on green is two calls, because `gh issue close` has no `--comment-file`:

```bash
gh issue comment <n> --body-file - <<'EOF'
<outcome + the criteria table>
EOF
gh issue close <n> --reason completed
```

Never omit the body — an argless `gh issue comment` prompts interactively and hangs the run.

### The run id

Every command in [Failure and repair](#failure-and-repair) and [Flake handling](#flake-handling) takes one, and pause rows 8 and 10 have to name one — but `gh pr checks` never prints it. Its `link` is a *job* URL, `.../actions/runs/<run-id>/job/<job-id>`. Derive it from the branch:

```bash
RUN=$(gh run list --branch worktree-<n>-<slug> --limit 1 \
  --json databaseId,status,conclusion,url --jq '.[0].databaseId')
```

`--limit 1` is the newest run on the branch, which is the one the current push started. It is equally recoverable from any `link` by taking the path segment after `/runs/`. Re-derive it per use — shell state does not survive between tool calls.

## Skipping

`ready-for-human` is a **takeability predicate**, not a priority signal — it means an agent cannot do this one. `/implement-next` turns that into "stop and ask" because a human is present. In an unattended loop there is nobody to ask, so it means what a blocker means: not takeable, move on.

**Skipping is not re-ranking.** The frontier query already drops blocked and assigned tickets and takes the first of what remains; this adds one more filter and preserves the order exactly.

Skip, and continue:

- `ready-for-human` picks.
- Tickets with **no acceptance criteria** — the Verify stage would have no fan-out, so the tick would have no definition of done.

**Halt** when nothing takeable remains — **and the halt has to name which fact it is.** "Nothing takeable remains" is five or six different situations wearing one face, and collapsing them is the failure this whole section exists to prevent. On an empty frontier, run the discriminators in `docs/agents/frontier.md`'s *When the frontier is empty* table over the map's open sub-issues:

- no open sub-issues at all → **row 2**. The map is finished; offer to close it.
- every open one is assigned → **row 5**. Name who holds them.
- open, unblocked, and carrying neither triage label → **row 6**. Triage gap; name them and offer to triage them.
- blocked, or gated by a human ticket → **rows 3 and 4**, which are one aggregation apart — see [Pause conditions](#pause-conditions).
- open, unblocked, unassigned, labelled, and **skipped by this run** → the fact is the skip reason, also in [Pause conditions](#pause-conditions).

When the cause is a human ticket gating the rest, the brief says **that** — "everything left is blocked by #34, which is `ready-for-human`" — never the generic "all open ones blocked". It falls out for free: skip the human pick, find no next takeable ticket, halt.

**Every skip is named in the brief, with the reason read from the ticket's own body**, so skipped tickets become the operator's to-do list rather than silently rotting.

## Failure and repair

Unmet acceptance criteria, a red pre-flight and red CI are the same kind of event and feed the same machinery: **up to 2 repair rounds**, each given the unmet criteria plus the refuters' or CI's specific evidence (`gh run view <run-id> --log-failed` — [The run id](#the-run-id)). Two rounds, because if two adversarially-verified attempts have not met a criterion, the ticket is more likely wrong than the code. A repair round is far cheaper than a re-arm — the understanding, the worktree and the evidence are all still to hand; a fresh session has none of it.

**One counter, per ticket, shared.** The budget is two rounds for the *ticket*, not two per kind of red. Hold the counter in this session with the ticket number beside it; **reset it only when a new ticket is claimed at step 3**, never on re-entry. So:

- an unmet criterion at step 6, a red pre-flight at step 7 and a red CI build at step 10 all decrement the **same** two.
- **re-entering the tick at step 7 does not restore a round.** The fresh 20-minute ceiling a repair round's CI poll gets is a fresh *clock*, never a fresh *round*.
- the counter is at 2 and something is still red → the ticket has failed. Do the four things below and die on **pause row 9**.

**When a repair round comes back clean**, re-enter the tick at **step 7** — pre-flight, commit, push, and a CI poll with a **fresh 20-minute ceiling** on a fresh `Monitor`. A repair round earns no shortcut through the gate; the issue closes only on the same two greenlights as any other tick. If the branch already has a PR, the push updates it (a `cancelled` conclusion on the superseded run is `cancel-in-progress`, not a failure); if it does not, step 9 opens it.

When a ticket finally fails, do all four and then die:

- **Push the branch and convert the PR to draft.** The work is real and must not evaporate with the session.
  - Failure at **step 10** (red CI): the commit, the branch and the PR all exist — `gh pr ready <pr> --undo`.
  - Failure at **step 6** (unmet criteria): steps 7–9 have never run, so there is no commit, no pushed branch and no PR to undraft. **Commit the work as it stands, push the branch, and open the PR as a draft** — the same step 9 invocation plus `--draft`. Skip the pre-flight; a failing tree is the point, and a red pre-flight must not swallow the evidence.
  - Always pass the PR number to `gh pr ready`; the argless form resolves from the current branch, and this session's cwd is the main checkout.
- **Comment the unmet criteria on the issue**, with evidence — refuter output, or the failing CI job and log excerpt.
- **Leave the issue open and still assigned.**
- Die with the brief.

That combination makes the gate self-enforcing: on re-arm the tip PR's ticket is open, so the loop refuses. The failed ticket blocks the chain instead of being silently skipped and built upon.

## Flake handling

**A named flake registry, checked before any re-run** — `docs/known-flakes.md` in the repo, one entry per flake: test path, the component it belongs to, the platform it fails on, one-line reason. Seeded by hand once when this loop is built.

**Read it from `origin/main`**, after arm step 0's fetch, and from the main checkout — not from the chain worktree. The registry is a repo-level document maintained by hand; the chain worktree sits on the stack tip, which was cut from whatever `main` held when the stack began and may well predate the registry landing:

```bash
git show origin/main:docs/known-flakes.md      # from the main checkout
```

**No such path on `origin/main` → there is no registry, and every red is real.** Never substitute a copy from an unmerged branch, and never write the file.

A loop that treats every red as a regression burns its repair rounds "fixing" timing tests. A loop that re-runs every red hands a genuine intermittent regression a free second roll — expensive at the bottom of a deep stack. So:

- On red: **if every failing test is in the registry *and* the branch touched none of the failing test's component**, then `gh run rerun <run-id> --failed`, **exactly once** ([The run id](#the-run-id)). Otherwise the red is real immediately.
- Read the failing tests from the **test-result lines** of `gh run view <run-id> --log-failed`, not from the step name — expired log archives report `UNKNOWN STEP`.
- The second half of the predicate has a command. Each registry entry names the **component** the flaky test belongs to; map that to its path in the repo and diff **this ticket's branch against the base it was cut from** — which from the second tick on is the *previous ticket's branch*, not the arm-time tip. Re-derive that base per tick, from GitHub and git, never from a remembered shell variable — shell state does not survive between tool calls, and an unset one expands to an empty base that makes the diff meaningless:

  ```bash
  BASE=$(gh pr view <pr> --json baseRefName --jq .baseRefName)   # this branch's own base
  git -C .worktrees/chain fetch origin "$BASE"
  git -C .worktrees/chain diff --name-only \
    "$(git -C .worktrees/chain merge-base FETCH_HEAD HEAD)"..HEAD
  ```

  **The arm-time tip is the wrong base and the error is not harmless.** Diffing from it folds every earlier ticket of the run into the answer, so one early ticket touching a component revokes that component's flake licence for every later ticket of the same run — which is precisely the "treats every red as a regression" failure the registry exists to prevent.

  **Any changed path under the failing test's component → no re-run.** Do not eyeball this: guessing it wrongly hands a genuine regression the free second roll the registry exists to prevent.
- The rerun reuses the same run id and increments the attempt, so the poll must re-read the run and must not treat the pre-rerun conclusion as final.
- Still red after that one re-run → real. Repair.
- **The re-run is always announced** — in the PR comment and in the brief. Never silent.

A registry that grows is a bill the operator can see — **so the loop never writes to it.** It is seeded by hand, once. A driver that appends an entry to make a red build go away has granted itself its own re-run licence; a red that is not *already* named is real.

## The chain worktree

**One worktree for the whole run**, not one per ticket: `.worktrees/chain`, cut off the stack tip when the loop arms. Each ticket does `git switch -c worktree-<n>-<slug>` inside it — legal, because each branch descends from the previous, so history is never jumped. A worktree per ticket pays a cold dependency install *and* a cold build cache every time; one worktree keeps both warm from ticket two onward.

**The worktree survives the run; re-arming reuses it and keeps the caches warm.** Re-arm is the normal case, not the exception — the loop is designed to die and be re-armed — so the command has two paths and always ends with the worktree sitting on the freshly derived tip:

```bash
TIP_SHA=<the sha= field of arm step 2's row>          # no open PR: git rev-parse origin/main
if [ -d .worktrees/chain ]; then
  git -C .worktrees/chain status --porcelain     # any output → die naming the files, do not clean
  git -C .worktrees/chain switch --detach "$TIP_SHA"
else
  git worktree add --detach .worktrees/chain "$TIP_SHA"
  (cd <repo-root>/.worktrees/chain && <the repo's clean-install command>)
fi
```

- **`git worktree add` fails outright when `.worktrees/chain` already exists.** The existence check is what makes the second and every later arm work; without it the warm-cache saving is unreachable.
- **A newly added worktree has no installed dependencies** — they are gitignored, so nothing copies them in — and the pre-flight dies on its first command without them. **Run the repo's clean-install command once, in the same call that creates the worktree.** This is the cost the "one worktree, not one per ticket" decision exists to pay exactly once; the existing-worktree path must *not* re-run it, or the saving evaporates. `TIP_SHA` comes from arm step 2's emitted row (`headRefOid`); re-read it with `gh pr view <tip-pr> --json headRefOid --jq .headRefOid` rather than carrying it in a variable, because shell state does not survive between tool calls.
- **`EnterWorktree` branches from `origin/main` and therefore cannot cut a stacked branch.** Use raw `git worktree add`.
- **`--detach`.** The tip branch is often already checked out elsewhere under `.claude/worktrees/`, and git refuses a second checkout of one branch.
- `git status --porcelain` must be clean before each switch, or the tick dies rather than carrying leftovers forward. **The guard is unconditional** — nothing is excluded from it, and pre-excluding a path so it stops firing is exactly the softening it exists to prevent.
- **The repo's environment prerequisites go on every tool call that runs the toolchain**, never as a one-shot export at arm time — shell state does not survive between tool calls, so a one-shot is inert by the next call. See [Local toolchain](#local-toolchain).

## Local toolchain

**The verify command belongs to the repo, not to this skill.** Resolve it **once, at arm time**, and reuse the same string for every pre-flight of the run and in every agent prompt that will build or test. Look, in order, at the repo's `CLAUDE.md`, its contributing docs, and its CI workflow — **the CI workflow is the authority**, because CI is what the gate actually measures, and a pre-flight that runs something weaker is an economy that buys nothing. **Name in the brief where you got it.**

Two things about it are this skill's business, and they are the reason this section exists at all:

**1. Environment prerequisites go in the same tool call as the command they serve.** Many repos need something set before their toolchain is usable — a version manager activated, a compiler toolchain put first on `PATH`, a build-output directory pinned away from a default another tool writes to. Shell state does not persist between tool calls, so a one-shot export at arm time is gone by the time the next call runs. Resolve those prerequisites at arm time alongside the command, carry them as **one literal block**, and paste that block into every tool call — the driver's and every agent's — that runs the toolchain.

**Without them, every local result is a lie** — including a TDD "red" that is really a broken build. And where the prerequisite pins a build-output directory, a run without it can leave artefacts that poison the tree for the pre-flight and for every later ticket of the run.

**2. The pre-flight is an economy, never an authority.** It is a cheap catch before a full CI cycle. Local green says nothing about the platforms CI covers and the driver does not have. **CI is the gate**; a green pre-flight never substitutes for it, and step 10 runs regardless.

## Branching and the stack

PRs **stack**. Each ticket branches from the previous ticket's branch, unmerged — not from `main`.

- **Tip derivation is from GitHub, never remembered.** Re-derive it at each arm **and at the top of each tick** — after a green tick the tip is that tick's own PR.
- **No depth cap.** The stack grows until a pause condition stops it.
- **Merge commits, not squash.** Squashing the bottom of a stack rewrites its commits and gives every child PR a phantom diff. GitHub auto-retargets a child to `main` when its base branch is deleted on merge, so bottom-up merging self-heals.
- **The loop never merges, never rebases, never touches `main`.** Not `main`, and **not a stacked branch either** — rebasing a child onto its parent rewrites the stack and produces the same phantom diff that squashing does. **Nothing the loop does ever rewrites published history**: `switch -c`, `commit` and `push` are the whole of what it writes to a branch, and there is no force-push. (`fetch`, `worktree add` and `switch --detach` are arm-time plumbing and write no history at all.) The operator merges, rebases, and owns `main`.

## ADR numbering

**Allocate from the chain worktree, never from `main`.** The worktree sits on the stack tip, which carries every ADR the stack has written, so `max(number in docs/adr/) + 1` is correct by construction and cannot collide within a run.

This is strictly better than allocating by hand. Mid-run, `main` shows only the ADRs that have been merged while the stack tip carries every one the run has written — the difference exists only on unmerged branches, invisible to anyone reading `main`. Allocating from `main` is how a repo comes to hold two ADRs with the same number.

**Guard before every commit**, in the chain worktree:

```bash
for d in $(ls .worktrees/chain/docs/adr | sed 's/-.*//' | sort | uniq -d); do
  ls .worktrees/chain/docs/adr | grep "^$d-"
done
```

The first command finds duplicated **numbers**; the second names the **files** behind each. Both are needed, because pause row 12 and the brief have to name files and the bare number the first prints is not enough on its own.

**Pre-existing duplicates are exempted by filename, never by number.** Run the guard once at arm time; whatever it finds is inherited from `main` and is not this run's doing. Record that set **as filenames**, and let a duplicate pass only when the files behind it are *exactly* that inherited set. A *third* file arriving at an already-duplicated number — the Record stage allocating straight into a pre-existing collision — is a new clash and dies like any other; an exemption keyed on the number alone would wave it through. **Any other duplicate: die, naming the clashing files.**

The guard has to be written this way. The worktree descends from `main`, so an inherited duplicate is present on the very first commit of the very first tick, and a guard that fired on it would mean the loop could never commit anything. The clash the guard is actually for is a *new* one — in particular, the number the Record stage just allocated already existing.

**Name any inherited duplicate once in the first brief and do not touch it** — a drive-by renumber inside a stacked PR would ripple through every ADR cross-reference in the stack.

## PR convention

Lifted from the repo's existing PRs, not invented.

- **Title** — the ticket title verbatim, ending `(#n)`.
- **Body opens** with one line of what landed, then: *"Stacked on `<base-branch>` (#n) — review that one first; the diff here is only X."* `<base-branch>` is the base passed to `gh pr create` and `(#n)` is the base PR's number. **When the base is `main` there is no base PR**, so the line reads *"Branches from `main` — this is the bottom of the stack."* Never emit an empty `(#)`.
- **`## What changed`** — bolded lead sentences, each naming the files it touches.
- **`## Acceptance criteria`** — a table of `#`, Criterion, Status, Evidence, where evidence names actual test names and file paths. Closes with a one-line statement of whether any criterion is unmet. This table is the Verify verdict, verbatim.
- ADRs recorded or amended are named in the body.
- Any flake re-run taken is named in a PR comment.

## The brief

The checkpoint is pushed right, all the way out of the run — **there is none inside the loop**. The brief is the only thing the operator reads, and everything the loop did arrives through it.

1. **Why it stopped** — one of the named pause facts, one sentence. With the run's constants from arm step 0: the verify command and where it came from, and the CI ceiling.
2. **The stack, bottom-up, in merge order** — PR #, ticket title, CI state, link. The morning's work queue.
3. **What needs the operator** — skipped tickets with the reason read from their own bodies; the failed ticket with its unmet criteria and evidence. A ticket whose **Record stage was skipped** belongs here too, with Understand's judgement that it was purely mechanical: an ADR that was never written is the operator's to know about. So does any inherited duplicate ADR number, named once, in the first brief.
4. **Flake re-runs taken**, named.
5. **The re-arm command.**

**Print it to the session *and* post it as a comment on the map issue** — durable, survives the dead session, readable on a phone, attached to the object it is about. A comment does not touch the map's body. **This is unconditional, `--dry` included**: a dry run's whole purpose is to report the plan and the gate state, and the brief is how a report reaches the operator. What `--dry` withholds is precisely named in [Arguments](#arguments) — the claim, the implementation, the worktree — and the brief is none of them.

```bash
gh issue comment <map> --body-file - <<'EOF'
<the brief>
EOF
```

## Pause conditions

All fatal. The loop dies with a brief.

| Condition | Brief says |
|---|---|
| A ticket is already claimed by the operator | A previous run died mid-tick. Name it, say whether it has an open PR, offer a hand resume or an unassign. |
| No open sub-issues | The map is finished. Offer to close it. |
| All open ones blocked | Name the blockers holding the most back. |
| Everything left gated by a `ready-for-human` ticket | Name that ticket and why its body says it needs a human. |
| All open ones assigned | Name who holds them. |
| Open, unblocked, unlabelled | Triage gap — name them, offer to triage them. |
| Stack tip's ticket still open | The previous tick did not finish. Name what is unmet. |
| Stack tip's build not green | Name the failing job — or, when the tip is pending or reports no checks, say that no check has concluded and name the run. |
| Ticket failed after 2 repair rounds | Name the unmet criteria with evidence. |
| CI never concluded in 20 min | Name the run. |
| Worktree dirty before a switch | Name the files. |
| ADR number collision | Name the clashing files. |
| Claim lost to another session | Someone else took it. |
| Out of room to finish a tick | Say so, before claiming anything. |

Fourteen different facts. They must never collapse into "nothing to do".

To name the blockers holding the most back, aggregate across the open sub-issues:

```bash
gh api "repos/<owner>/<repo>/issues/<n>/dependencies/blocked_by" \
  --jq '.[] | select(.state=="open") | "#\(.number) \(.title)"'
```

**Rows 3 and 4 are one aggregation apart, and they collapse unless you run it.** The frontier query has already dropped every blocked ticket, so an empty frontier tells you nothing about *what* holds the rest. Run the aggregation over the remaining open sub-issues, then take the **first** branch below that matches:

- **The aggregated open-blocker set is empty** — nothing at all is blocked, so row 3 is simply false and must not fire. What is left is what this run **skipped**, and the fact is the skip reason:
  - skipped for `ready-for-human` → **row 4**. "Everything left is blocked by #34, which is `ready-for-human`" — name it and why its body says it needs a human.
  - skipped for **no acceptance criteria** → say exactly that, naming those tickets: they are open, unblocked, unassigned and labelled, and a tick over them would have had no definition of done. They also go in brief item 3 as the operator's to-do — that is what makes the second skip reason visible rather than a silent rot.
  - both kinds present → name both, in sub-issue order.
- The aggregated open-blocker set is **exactly** the ticket(s) this run skipped for `ready-for-human` → **row 4**.
- Anything else → **row 3**. Name the blockers holding the most back.

**Never say "all open ones blocked" when nothing is blocked**, and never when a single human ticket is the whole obstruction.

## Rules

- **The loop never merges and never rebases — anything.** Not `main`, not a stacked branch. And it never pushes to `main`. The operator owns all of it.
- **Tip derivation is from GitHub, never remembered.** Fetch first, so the sha it names exists locally. **Re-derive it every tick**, not once at arm time — every PR of the run is based on the previous PR's branch, and a frozen base builds a fan instead of a stack.
- **`count` and the budget directive are checked at tick step 0**, before the frontier and before the claim. A bound nobody enforces is not a bound.
- **Claim before work, every time — and read the claim back.** `--add-assignee` exits 0 on a lost race. Lost race → die.
- **Die rather than resume a half-finished tick.** A live claim is a stop sign, not a starting point.
- **Never trim Verify.** The adversarial pass is the only thing between "an agent said it's done" and the gate closing an issue.
- **Every git command of a tick carries `-C .worktrees/chain`.** This session's cwd is the main checkout — and that path is relative to it, so **nothing may leave the cwd anywhere else.** Bash cwd persists between tool calls; any `cd` into the worktree goes in a subshell.
- **The verify command and its environment prerequisites are the repo's, resolved once at arm time** — CI workflow first — and both go in the **same tool call** as every command that builds or tests. A missing prerequisite makes every local result a lie.
- **Every agent prompt carries the absolute chain-worktree path *and* that environment block.** An agent that edits the main checkout corrupts the stack silently, and an agent running a TDD loop without the prerequisites reports lies. See [`WORKFLOW.md`](WORKFLOW.md).
- **Fourteen pause conditions are fourteen facts.** Say which. The five empty-frontier facts among them are discriminated in `docs/agents/frontier.md`, not here.

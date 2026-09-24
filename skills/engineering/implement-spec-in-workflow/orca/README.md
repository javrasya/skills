# The Orca runner

The second runner for `workflow.template.js` (ADR-0011): a Node script, launched in its own Orca terminal, that runs the rendered workflow script unchanged and starts each `agent()` as a supervised Orca worker the operator can watch and answer.

| file | what it is |
|---|---|
| `runner.mjs` | the runner: the four hooks, naming each `agent()` call, replay and the resume journal, `runner.log`, the retained worktrees |
| `registry.mjs` | the machine-wide run registry: its writer and the fold that reads each run's current state |
| `lifecycle.mjs` | one live agent's life: the run's Run, the live cap, its worker's start, liveness, nudges and session continuation, its result, its board status |
| `transcript.mjs` | where a Claude or pi session writes its transcript, found from its session id, and how big it is |
| `submit.mjs` | the worker's end of `agent()`: validates the payload, records it, sends `worker_done` |
| `orca-cli.mjs` | the one place anything talks to Orca |
| `fake-orca.mjs` | an in-memory Orca behind the same methods, for the offline tests |
| `schema.mjs` | the JSON Schema subset the template's schemas use |
| `settings.mjs` | every limit the runner enforces, in one table |

```
node runner.mjs <rendered-script.js> [--state-dir <dir>] [--resume] [--permission-mode <mode>]
```

The state dir defaults to `orca-run/` beside the rendered script, which is `<notes-dir>/orca-run` for a run the skill armed. When the runner exits it writes `summary.json` there — `{"runner": "orca", "ok": true, "result": …}`, or `"ok": false` with the `error` and `worktrees_kept`, every worktree the runner retained (below) — and that file, not the terminal's log, is what the arming session reads and reports. It is removed at start, so a file left by an earlier run never passes for this one's.

## What a run leaves on disk

Together, the journal and the log say what happened in a run, whether or not the runner's tab is still open.

- **`runner.log`** holds every line the runner printed, each prefixed with an ISO timestamp, including the result or the error it ended with. Each run appends to the log, so a resumed run follows the earlier one.
- **`journal.jsonl`** holds one JSON entry per line. Every entry has a `type` and `at`, an ISO timestamp. `JOURNAL_ENTRIES` in `runner.mjs` lists the fields each type always carries:

| type | written when | fields besides `type` and `at` |
|---|---|---|
| `started` | a worker started | `key`, `n`, `title`, `dispatchId`, `harness`, `sessionId`, `worktree` (the path it runs in), `terminal` (its handle) |
| `result` | a call returned a value | `key`, `n`, `title`, `result`, and `replayed: true` if it came from the journal |
| `failed` | a call returned null: its worker never started, died past the continuation cap, was blocked on a human too long, went over a limit, or left no valid result, or its Run could not be created | `key`, `n`, `title`, `reason` (human-readable; after retries, the last attempt's), `attempts` (starts or Run creations made), `continuations` if its session was continued, and `retained` if it left a worktree |
| `retained` | a resume carries forward a worktree an earlier run kept | `retained` |
| `retry` | a call starts another attempt at its worker's start, or at creating the Run | `key`, `n`, `title`, `attempt` (the one starting, from 2), `reason` (why the last one failed) |
| `warning` | something went wrong without failing the call: its worktree's display name or board status could not be set | `key`, `n`, `title`, `reason` |
| `nudge` | the runner typed a nudge to a worker | `key`, `n`, `title`, `dispatchId`, `reason`, `attempt` (the nudge's number since the session started or was last continued) |
| `continued` | a stuck or dead session was continued, in its own terminal or in a new one in its worktree | `key`, `n`, `title`, `dispatchId` and `terminal` (the ones it now runs under), `sessionId`, `reason`, `attempt` (1 to the cap), `reopened` (true when its tab was gone) |
| `reattached` | a resumed runner took up a worker an earlier one started | `key`, `n`, `title`, `dispatchId`, `sessionId`, `terminal`, `worktree` |

`reattached` is defined here, and the behaviour that produces it writes it; the other types are written today. A resume reads only `type`, `key`, `result` and `retained`, so a journal from before timestamps and launch fields were added still resumes.

### The run registry

Beyond its state dir, every run is recorded in **`~/.claude/orca-runs.jsonl`**, one append-only JSON-lines file for the whole machine (ADR-0012). An Orca Run knows no project, run directory, spec or outcome, and cannot be closed, so the registry holds them, keyed by Run id; it is the only list of runs, and runs from before it are not in it. Every entry has `type`, `runId` and `at`:

| type | written when | carries |
|---|---|---|
| `armed` | the runner creates the Run, at its first live `agent()` | `project` (the runner's working directory), `runDir` (the state dir), `spec` (the script's `meta.name`) |
| `runner` | a runner starts on the Run | `terminal`, the runner's own terminal |
| `ended` | the script settles | `outcome`: `ok`, `partial` if any `agent()` returned `null`, `failed` if the script threw |
| `reclaimed` | an agent or the whole run is reclaimed (not written by the runner) | `agent`, the worktree name `<runId>-<n>`; none for the whole run |

`readRegistry()` folds these into each run's current state: `running` until `ended`, then its outcome; where its runner was last seen; and whether the run, or which of its agents, was reclaimed. A torn last line is skipped. A run with no `ended` may still be live or its runner may have died: Orca's terminal list says which. A resume creates a Run of its own, so it is armed as a new run with the same `runDir`; a resume that replays every call creates no Run and records nothing. `runScript` writes the registry only when handed a path, so the offline tests never touch the real one.

The runner assigns each worker's session id. It generates the id and starts the harness with `--session-id`; both `claude` and `pi` accept that flag. Each attempt at a start gets a new one.

## Timeouts and retries

Every Orca call is bounded by `orcaCallMs` in `settings.mjs`, plus any wait the call asks Orca for (a `terminal wait --timeout-ms`). A call that has not answered by then is killed and fails as `call_timeout`, which is not Orca's own `timeout`: a tui-idle wait uses that one to mean busy.

A worker's start that fails, timed out or otherwise, is retried after each wait in `retryBackoffMs` (30s, 2 min, 5 min), so a call gets four attempts before `agent()` returns null. Each new attempt is journaled as `retry`, and the null as `failed` with the last attempt's reason. Creating the Run follows the same policy; calls that are waiting on it share one creation and its retries.

A start is safe to repeat. An isolated agent's child worktree is always named `<runId>-<n>`. Orca answers a second `worktree create --name` with a new `<name>-2` rather than an error, so a retry first looks its name up in `worktree list --limit 10000`. Orca pages that list at 200 rows across every repo on the machine by default, and the runner keeps every worktree until the operator reclaims it, so it asks for as many rows as Orca's own UI does:

- If the list still comes back `truncated`, the name cannot be ruled out, so that attempt fails and is retried. It is never read as "not found".
- If no worktree has that name, the retry creates it.
- If the worktree is clean and no agent runs in it, the retry takes it up.
- If an agent still runs in it (`terminal list`), only that attempt fails.
- If it has uncommitted changes (`git status --porcelain`), or commits no other branch holds, the start fails for good with that reason. The worktree is retained, like a dead agent's.

Every `worktree create`, first attempt or retry, is checked against the name it asked for. If Orca made `<name>-2` instead, a worktree of that name already exists that the start did not take up. The start fails for good with that reason, because a retry that missed it again would make a `-3`. Both worktrees are retained: the new one on the `failed` journal line, and the earlier one on a `retained` line.

## Liveness and session continuation

A worker is watched through two signals (ADR-0013): its session transcript growing (`transcript.mjs` finds the file from the session id) and its terminal changing between busy and idle. It is **stuck** only while neither moves. The limits are in `settings.mjs`:

- **No movement** for 20 minutes: nudged. For 40: its session is continued.
- **Idle or exited without submitting**, with neither signal moving for the grace: nudged twice, then continued. A transcript still growing behind an idle terminal is a worker at work.
- **A nudge's own echo** is not movement: the nudge lands in the transcript and turns the TUI busy even in a hung session. After a nudge, movement counts only when the look it is measured against was taken at least `nudgeEchoMs` after the nudge; an earlier baseline is just replaced. So a runner that looks late never mistakes the echo for the worker.
- **Gone**, its tab closed: continued at once, in a new terminal.
- **Blocked on a human**: logged loudly; after 30 minutes it fails and is kept, never continued, since continuing does not answer the question it waits on.

A **continuation** carries the same session on (decision D3 on #43). With the tab alive, the runner interrupts the stalled process, types `claude --resume <id>` (pi: `pi --session-id <id>`) with the worker's launch flags into the same terminal, and then a prompt telling the agent it was interrupted and must finish and submit; its dispatch is unchanged. With the tab gone, the resume runs in a new terminal in the same worktree, and `worker-start --terminal` adopts it with that prompt as its spec: Orca settles a dispatch only from its own pane, so the new pane gets a new dispatch, and the old one is stopped and released. Either way the worker is watched again, and a continued agent that submits returns its result.

At most 3 continuations per agent. The next death fails it with a reason naming the cap, and it is **kept**: its process is not stopped, its tab stays open, and its worktree is retained. An agent that never started has no session to continue.

Not yet confirmed against live Orca: that `worker-show` follows a dispatch whose agent was resumed in its pane, and that two concurrent interrupts stop a pi worker as they stop Claude.

## Two checks, and when each runs

- **Offline:** `node scripts/test-orca-runner.mjs`. Fast and free. It runs the runner against the fake Orca, so it proves the runner does what the fake says Orca does, and nothing about the Workflow runner.
- **The runner contract test:** `scripts/runner-contract.workflow.js`. Slow, and it spends tokens on six short agents per fresh run, so it runs by hand. It is the only check that the Orca runner gives a script what the Workflow runner gives it, and that is the promise the whole Orca runner rests on.

**It gates every Orca runner change.** A change to any file in this directory, or to the template's use of the hooks, is not done until the contract test returns the expected object under both runners, fresh and resumed. The offline tests do not replace it. A guarantee the script comes to rely on gets a case in the contract script first. The script has to stay byte-identical under both runners, and it must never use `Date.now()`, `Math.random()` or an argless `new Date()`.

## What the contract covers

| case | the script does | both runners must give |
|---|---|---|
| valid structured return | `contract:valid` returns an object against a schema | `valid: {count: 3, word: "hello"}` |
| bad first submit, repaired in-turn | `contract:repair` first returns a result missing a required field, reads the validation error, then returns it correctly | `repaired: {count: 3, first_attempt_rejected: true}` |
| the role table's options | `contract:options` passes `harness: 'claude'`, `model: 'sonnet'` and `piModel`, the options every template call spreads from its role table | `options: {count: 3, word: "hello"}`: the call is taken, not refused; the Workflow runner ignores `harness` and `piModel` |
| isolated worktree | `contract:here` and `contract:isolated` (`isolation: 'worktree'`) each return their `git rev-parse --show-toplevel` | `isolated: {own_worktree: true}`: the isolated agent's top level is not the run's |
| throwing `parallel` thunk | two thunks throw, one synchronously and one as a rejected promise, beside the agents above | `thrown: [null, null]`, and `parallel()` itself does not reject |
| killed worker | `contract:kill` runs a nine-minute wait, and you kill it during the wait. It is awaited outside `parallel()`, so an `agent()` that throws on a dead agent cannot hide behind the null | `killed: null` |
| resume replaying from cache | the same script, relaunched with the runner's resume handle | the same object, with the five `parallel` agents replayed, not re-run |

Every run must return exactly this:

```json
{"valid":{"count":3,"word":"hello"},"repaired":{"count":3,"first_attempt_rejected":true},"options":{"count":3,"word":"hello"},"isolated":{"own_worktree":true},"thrown":[null,null],"killed":null,"failures":[]}
```

The script checks itself as well. A non-empty `failures` names each case that broke, and the runner's log ends with `contract holds` or `N contract failure(s)`.

## How to run it

Run each runner from an Orca terminal on the repo. `<repo>` is the absolute path of the checkout, and `<dir>` is a scratch state dir outside it.

**Orca runner.** Launch it in its own terminal, so the Run binds to that terminal:

```
orca terminal create --title "runner contract (orca)" --command "node <repo>/skills/engineering/implement-spec-in-workflow/orca/runner.mjs <repo>/scripts/runner-contract.workflow.js --state-dir <dir>"
```

1. The runner starts the five `parallel` agents (`contract:valid`, `contract:repair`, `contract:options`, `contract:here`, `contract:isolated`). Once their results are in, it starts `contract:kill`. `contract:isolated` leaves a child worktree the runner does not remove; remove it by hand after the resume.
2. When the log shows `>> [Contract] contract:kill: started … in terminal <handle>`, kill that worker within nine minutes: close its tab, or run `orca terminal close --terminal <handle>`. The runner logs `agent() returns null` and prints `== Result`.
3. Resume. Run the same command with `--resume` added, against the same `--state-dir`. The five `parallel` agents log `replayed from the journal` and start no worker. `contract:kill` died, so it was journaled as failed and runs live again (see below): kill it the same way, and it prints the same result.

**Workflow runner.** Run it in a Claude Code session that has the `Workflow` tool, for example `claude "<prompt>"` in an Orca terminal. Word the prompt so the agents do their own tasks. The Workflow runner can hand each subagent the session's request, and an agent that sees only "run a workflow" goes looking for the Workflow tool first:

> Run a workflow: call the Workflow tool with scriptPath `<repo>/scripts/runner-contract.workflow.js` and no other input. When it completes, resume it exactly once: call the Workflow tool again with the same scriptPath and resumeFromRunId set to the runId the first call returned. This is the runner contract test, and every agent either run starts is part of it: each agent must do exactly what its own prompt says, nothing more. contract:repair returns a wrong result first on purpose, and contract:kill runs a nine-minute wait that I kill by hand, in both runs; neither needs the Workflow tool. Do not edit the script and do nothing else. After each run completes, print its runId and its returned value verbatim as one JSON block.

1. When `contract:kill` is the one agent still running, open `/workflows`, press Enter to reach the agent list, select `contract:kill`, and press `x`. It shows as `skipped`, and the run completes. If the nine minutes run out first, it returns `{done: true}`, `failures` names `killed`, and the run has to be done again.
2. On the resume, `contract:kill` runs live again, as it does under the Orca runner (see below). Kill it the same way.
3. The run record is in `~/.claude/projects/<project>/<session>/workflows/<runId>.json` (`result`). The journal, which shows what was replayed, is in `…/<session>/subagents/workflows/<runId>/journal.jsonl`.

Then compare the four results: Orca fresh, Orca resumed, Workflow fresh, Workflow resumed. All four must equal the object above.

The script must reach the Workflow tool with LF line endings. The tool refuses a script that holds a carriage return ("script contains control characters that would be hidden in the approval dialog"), which is what a Windows checkout with `core.autocrlf` produces. `.gitattributes` pins `*.workflow.js` to LF. A checkout made before that line was added needs the file checked out again.

Last pass: 2026-09-23, Orca 1.4.207 and Claude Code 2.1.280 on Windows 11, with the runner as of #30, whose entry point writes `summary.json`. All four results were equal to the expected object. The Orca fresh and resumed runs each left a `summary.json` with `"runner": "orca", "ok": true` and that object as `result`. The Orca resume started no worker. The Workflow resume replayed `contract:valid` and `contract:repair` and re-ran `contract:kill`.

Not yet re-run since the runner and this script changed on `spec/21-integration`: the script gained `contract:options` and the isolated-worktree case (so the object above is not yet confirmed on either runner), a dead agent is now journaled as failed (below), so the Orca resume re-runs `contract:kill` too, and custom launches into a child worktree now create it first. Since #45, every worker is a custom launch with a runner-assigned `--session-id`. Since #46, every Orca call has a timeout and a failed start is retried; the retry's `worktree list --limit 10000` lookup reads `path`, `branch` and `truncated`, as probed on Orca 1.4.209 (whose list defaults to 200 rows, and `--limit 3` returned 3 of 10 with `truncated: true`), but no retry has run against real Orca yet, nor has a create that answers `<name>-2`. Since #47, a stuck or dead session is continued before the agent is given up, so `contract:kill` is continued in a new terminal up to 3 times and has to be killed 4 times. The next pass must confirm both runners again.

## A dead agent on resume

Both runners journal an agent that returned `null` as failed, with no result: a worker that died by any of the runner's liveness limits, one whose worker never started, and one whose Run Orca could not create. A resume therefore runs that call live again, and every call after it, as it does for an edited call. A failed entry keeps its place among identical calls, so the k-th call with a key never replays a later call's result. In the contract test this means `contract:kill` has to be killed a second time on the resume, under either runner.

## Harness and model

Each template call spreads its role's row from the `ROLES` table: `harness` (`claude` or `pi`), `model`, always a Claude model name, and for a pi row `piModel`, a pi model pattern (`provider/id`). The runner starts a pi worker with `piModel` and never hands it `model`; the Workflow runner ignores `harness` and `piModel` and runs every role on Claude with `model`. So a row edited to pi keeps a Claude `model`, and the same rendered script runs on either runner.

## Worktrees and the board

An `agent()` with `isolation: 'worktree'` runs in a new Orca child worktree of the run's worktree. Every worker starts from its harness's own command line, carrying its session id, in a terminal the runner creates. `worker-start --terminal` then adopts that terminal, and `--agent` is never used. A process that is already running cannot be moved into another worktree, so the child is made first with `orca worktree create --parent-worktree current`. The worker's terminal opens there with `terminal create --worktree path:<child>`, and `worker-start --terminal` is told the same worktree.

The runner sets each child worktree's board status with `orca worktree set --workspace-status`: `in-progress` when its worker starts (`in-review` for an agent in the `Gate` phase), and `completed` when its agent reports a PR it published (a result with a `pr_url` and `published` not false). A reclaimed worktree leaves the board with its removal. A status or display name Orca refuses is logged and journaled as a `warning`, and the agent carries on. The run's own worktree is never touched.

The runner never removes a worktree. One whose agent died, or whose worker never started, is retained and named in the run's `worktrees_kept` with its reason, and in the log. It is journaled with the failed call, so a resume, which runs that call again in a new worktree, still names the old one. When the script throws, `summary.json` carries the same list beside the `error`.

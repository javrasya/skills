# The Orca runner

The second runner for `workflow.template.js` (ADR-0011): a Node script, launched in its own Orca terminal, that runs the rendered workflow script unchanged and starts each `agent()` as a supervised Orca worker the operator can watch and answer.

| file | what it is |
|---|---|
| `runner.mjs` | the runner: the four hooks, naming each `agent()` call, replay and the resume journal, `runner.log`, the retained worktrees |
| `journal.mjs` | the run's journal: its entry types, and the one fold of it that the resume, reclaim and the run view all read |
| `registry.mjs` | the machine-wide run registry: its writer and the fold that reads each run's current state |
| `reclaim.mjs` | reclaiming an agent or a whole run, by one set of rules; the run view reclaims through it |
| `lifecycle.mjs` | one live agent's life: the run's Run, the live cap, its worker's start, liveness, nudges and session continuation, its result, its board status |
| `run-view-model.mjs` | the run view's model, with no terminal: one run's tree (header, phase and agent rows, the bottom pane), every run in the registry for standalone mode, and what each key and click does |
| `run-view/` | the run view's terminal: `view.mjs`, the entry the runner starts in its tab and the `orca-runs` skill opens standalone, `draw.mjs`, the screen drawn from the model, and `package.json` for terminal-kit (below) |
| `transcript.mjs` | where a Claude or pi session writes its transcript, found from its session id, how big it is, and its context size and tokens |
| `submit.mjs` | the worker's end of `agent()`: validates the payload, records it, sends `worker_done` |
| `orca-cli.mjs` | the one place anything talks to Orca |
| `fake-orca.mjs` | an in-memory Orca behind the same methods, for the offline tests |
| `schema.mjs` | the JSON Schema subset the template's schemas use |
| `settings.mjs` | every limit the runner enforces, in one table |

```
node runner.mjs <rendered-script.js> [--state-dir <dir>] [--resume] [--permission-mode <mode>]
```

The state dir defaults to `orca-run/` beside the rendered script, which is `<notes-dir>/orca-run` for a run the skill armed. When the runner exits it writes `summary.json` there — `{"runner": "orca", "ok": true, "result": …}`, or `"ok": false` with the `error` and `worktrees_kept`, the worktrees retained because their agent died or never started (below) — and that file, not the terminal's log, is what the arming session reads and reports. The runner writes it when the script ends and asks nothing; it then stays in its tab until the operator quits the run view (below). So the arming session waits for the file to appear, not for the tab to exit: the tab stays open once the runner is done. What the operator reclaims, always from the run view, is in the run registry.

As it starts, the runner also writes **`runner.pid`**, its own process id. The tab outlives the runner, so an open tab says nothing about whether the runner is alive; a `runner.pid` naming a process that is gone, with no `summary.json`, means the runner died before writing one (killed, out of memory, crashed). The arming session checks it with `node -e "process.kill(+process.argv[1],0)" <pid>`, which sees Windows process ids.

The notes dir outlives a run, so a resume or a re-arm launches over the last run's `summary.json` and `runner.pid`. The runner removes the old `summary.json` and overwrites `runner.pid`, but only once node has loaded, after the arming session's wait has begun; so the arming session deletes both itself before launching (SKILL.md step 4), and the runner's removal is defence in depth.

## What a run leaves on disk

Together, the journal and the log say what happened in a run, whether or not the runner's tab is still open.

- **`runner.log`** holds every line the runner printed, each prefixed with an ISO timestamp, including the result or the error it ended with. Each run appends to the log, so a resumed run follows the earlier one.
- **`journal.jsonl`** holds one JSON entry per line. Every entry has a `type` and `at`, an ISO timestamp. `JOURNAL_ENTRIES` in `journal.mjs` lists the fields each type always carries:

| type | written when | fields besides `type` and `at` |
|---|---|---|
| `queued` | a call waits for a live slot, `MAX_LIVE` agents being live | `key`, `n`, `title` |
| `starting` | a call has its live slot, and its worker's start begins | `key`, `n`, `title`, `run` |
| `started` | a worker started | `key`, `n`, `title`, `dispatchId`, `harness`, `sessionId`, `worktree` (the path it runs in), `terminal` (its handle), `dir` (its agent's files, relative to the state dir, which its prompt names) |
| `result` | a call returned a value | `key`, `n`, `title`, `result`, and `replayed: true` if it came from the journal, with `origin` when the call it replays launched a worker |
| `failed` | a call returned null: its worker never started, died past the continuation cap, was blocked on a human too long, went over a limit, or left no valid result, or its Run could not be created | `key`, `n`, `title`, `reason` (human-readable; after retries, the last attempt's), `attempts` (starts or Run creations made), `continuations` if its session was continued, `retained` if it left a worktree, `workerOut: true` when a resume could not take its Run over and its worker is still out: the call stays unsettled, and the next resume takes that worker up, and `workerLeft: true` when its worker's process was left running (blocked on a human, or stalled past the continuation cap): only a reclaim that stops it first removes it |
| `retained` | a resume carries forward a worktree an earlier run kept | `retained` |
| `retry` | an attempt at a call's worker start, or at creating the Run, failed and another follows: journaled as it fails, before the backoff's wait, so the reason is on the journal through the wait | `key`, `n`, `title`, `attempt` (the next one, from 2), `reason` (why the last one failed), `nextAt` (when the next attempt begins) |
| `baseline` | the runner made a call's child worktree, before it opens the agent's terminal: what the worktree held before any agent touched it. A create that timed out, its worktree found by name after, has none | `key`, `n`, `title`, `worktree` (its path), `lines` (its `git status --porcelain` lines, `[]` when clean) |
| `warning` | something went wrong without failing the call: its worktree's display name or board status could not be set | `key`, `n`, `title`, `reason` |
| `nudge` | the runner typed a nudge to a worker | `key`, `n`, `title`, `dispatchId`, `reason`, `attempt` (the nudge's number since the session started or was last continued) |
| `blocked` | a worker is blocked on a human | `key`, `n`, `title`, `dispatchId`, `terminal` (the tab to answer it in), `waiting` (what Orca says it waits on) |
| `unblocked` | a blocked worker no longer waits, before it settles | `key`, `n`, `title`, `dispatchId` |
| `continued` | a stuck or dead session was continued, in its own terminal or in a new one in its worktree | `key`, `n`, `title`, `dispatchId` and `terminal` (the ones it now runs under), `sessionId`, `reason`, `attempt` (1 to the cap), `reopened` (true when its tab was gone) |
| `reattached` | a resumed runner takes up a worker an earlier one started, as soon as its call is made, before the Run is taken over; a `continued` line follows if it had died | `key`, `n`, `title`, `run`, `dispatchId`, `harness`, `sessionId`, `terminal`, `worktree`, `dir` (the files its prompt named, from the line it was taken up from, however many resumes ago it started), `origin` (the `n` of the call that started its worker, which names its `<runId>-<n>` worktree), and `continuations` if its session was already continued |
| `outstanding` | a resume carries forward, before any call, each worker the last run left out, so it stays journaled until a call takes it up | as `reattached`, with the `n` and `title` of the line it was carried from |
| `earlier` | a resume carries forward, before any call, every other agent of the Run an earlier runner made: one that settled, or whose worker never started but left a worktree. It is no call, and replays nothing; it keeps the agent named for reclaim and the run view | `n`, `title`, `run`, `dispatchId`, `harness`, `sessionId`, `terminal`, `worktree`, `origin`, `state` and `reason` (as the journal last had them), and `continuations` if its session was continued |
| `run` | the Run is created, or a resume takes it over; a resume also carries the last one forward first | `runId`, `terminal` (the runner's, which the Run is bound to), and on the carried-forward line `lastN`, the highest call number the Run has used |

The resume, reclaim and the run view all read the journal through one fold, `foldJournal` in `journal.mjs`. A resume reads `type`, `key`, `n`, `result` and `retained`, the worker fields of `started`, `reattached`, `outstanding` and `continued`, `workerOut`, and the last `run`. A `reattached` line replaces the `outstanding` line for the same dispatch, so a call has one worker; an `outstanding` line no call took up follows every call that run made under its key. A `started` line with no dispatch or session, as in a journal from before launch fields were added, is a call with no worker out, so such a journal still resumes; a worker line with no `dir` is read as named by its own `n` and title.

Reclaim and the run view read the same fold as one agent per `origin`: every agent of the Run, across every resume. A resume rewrites the journal from empty and numbers its calls on, so it carries each agent an earlier runner made forward (`earlier`, `outstanding`), and a line of the call that takes one up again (`reattached`, or a replayed `result` with its `origin`) is that same agent, shown once and reclaimed under its worktree's name, never as a new one. A worker line with no `origin`, as journaled before it carried one, is the agent whose dispatch it names.

### Resume from a new terminal

If the runner's tab dies, the run is paused, not lost: run the same command with `--resume` from any terminal, the old tab open or not. Orca refuses `worker-start` from any terminal but the Run's coordinator, so before it starts or continues any worker the resumed runner takes the journaled Run over with `orchestration run-use`, which binds the Run to its own terminal and fences the old one; the registry gains a `runner` line with the new terminal. It creates a Run only when the journal records none. A resume that replays every call touches no Orca at all.

Each call then gets what the last run left it, matched by key and occurrence as replay is:
- **finished**: replayed from the journal, as before; it starts no worker.
- **its worker still out**: taken up, never started again. The runner asks Orca how it is (`workerShow`). One Orca still shows live, or that settled meanwhile, is journaled `reattached` and watched as any worker, and its result is returned when it submits, to the files its prompt named, however many resumes it stayed out through. One whose tab closed, or whose agent exited, while no runner watched is continued in its own session and worktree (the session continuation below), in a new terminal if its tab is gone.
- **never started**: started now, with the start retry.

A worker still out is never dropped from the journal: the resume carries it forward as `outstanding` before any call, and journals `reattached` as soon as its call is made, so a runner that dies during the takeover's backoff, or while the call waits for a live slot, leaves it to the next resume. If the takeover fails for good, that call returns null and the run ends partial, but its `failed` line carries `workerOut: true`, its worktree is named in `worktrees_kept`, and the next resume takes the same worker up instead of starting a second one.
- **failed, changed or not in the journal**: runs live, and ends the replayed prefix.

A call the last run left unsettled gave the script nothing to depend on, so it does not end the prefix. The resumed run numbers its calls on from the last run's, so a live call's `<runId>-<n>` child worktree never takes a name the Run already holds.

### The run registry

Beyond its state dir, every run is recorded in **`~/.claude/orca-runs.jsonl`** (under `CLAUDE_CONFIG_DIR` instead of `~/.claude` when that is set, as Claude's transcripts are: `claudeDir` in `transcript.mjs` resolves both), one append-only JSON-lines file for the whole machine (ADR-0012). An Orca Run knows no project, run directory, spec or outcome, and cannot be closed, so the registry holds them, keyed by Run id; it is the only list of runs, and runs from before it are not in it. Every entry has `type`, `runId` and `at`:

| type | written when | carries |
|---|---|---|
| `armed` | the runner creates the Run, at its first live `agent()` | `project` (the runner's working directory), `runDir` (the state dir), `spec` (the script's `meta.name`), and `script` (the rendered script's path) and `permissionMode` when it has them, which a resume from the standalone view relaunches it with |
| `runner` | a runner starts on the Run | `terminal`, the runner's own terminal |
| `ended` | the script settles | `outcome`: `ok`, `partial` if any `agent()` returned `null`, `failed` if the script threw |
| `reclaimed` | an agent or the whole run is reclaimed (not written by the runner) | `agent`, the worktree name `<runId>-<n>`; none for the whole run |

`readRegistry()` folds these into each run's current state: `running` until `ended`, then its outcome; where its runner was last seen; and whether the run, or which of its agents, was reclaimed. A torn last line is skipped. A run with no `ended` may still be live or its runner may have died: Orca's terminal list says which. A resume takes the journaled Run over, so it records a `runner` line with its own terminal, and later `ended`, on that same run, never a second `armed`; a resume that replays every call takes nothing over and records nothing. `runScript` writes the registry only when handed a path, so the offline tests never touch the real one.

The runner assigns each worker's session id. It generates the id and starts the harness with `--session-id`; both `claude` and `pi` accept that flag. Each attempt at a start gets a new one.

## Timeouts and retries

Every Orca call is bounded by `orcaCallMs` in `settings.mjs`, plus any wait the call asks Orca for (a `terminal wait --timeout-ms`). A call that has not answered by then is killed and fails as `call_timeout`, which is not Orca's own `timeout`: a tui-idle wait uses that one to mean busy.

A worker's start that fails, timed out or otherwise, is retried after each wait in `retryBackoffMs` (30s, 2 min, 5 min), so a call gets four attempts before `agent()` returns null. Each failed attempt that another follows is journaled as `retry` before the wait, with its reason and `nextAt`, when the next attempt begins, and the null as `failed` with the last attempt's reason. Creating the Run follows the same policy; calls that are waiting on it share one creation and its retries.

A start is safe to repeat. An isolated agent's child worktree is always named `<runId>-<n>`. Orca answers a second `worktree create --name` with a new `<name>-2` rather than an error, so a retry first looks its name up in `worktree list --limit 10000`. Orca pages that list at 200 rows across every repo on the machine by default, and the runner keeps every worktree until the operator reclaims it, so it asks for as many rows as Orca's own UI does:

- If the list still comes back `truncated`, the name cannot be ruled out, so that attempt fails and is retried. It is never read as "not found".
- If no worktree has that name, the retry creates it.
- If an agent still runs in it (`terminal list`), only that attempt fails.
- If no earlier attempt sent its worker-start, no worker has been in it, and the retry takes it up whatever it holds.
- Once one did, the worktree is judged against its **baseline**: the `git status --porcelain` lines it held right after the runner made it, journaled as `baseline` before its agent's terminal opened. If its lines differ from the baseline (from none, for a create that timed out), or it has commits no other branch holds, the start fails for good with that reason, and the worktree is retained, like a dead agent's. Otherwise the retry takes it up.

An agent whose worktree was made with a baseline of any lines is told so in its prompt, under the Orca runner only: those files were there before it, it never stages or commits them, and it stages its own changes by path. With a baseline of none, or no baseline, the prompt has no such section.

Every `worktree create`, first attempt or retry, is checked against the name it asked for. If Orca made `<name>-2` instead, a worktree of that name already exists that the start did not take up. The start fails for good with that reason, because a retry that missed it again would make a `-3`. Both worktrees are retained: the new one on the `failed` journal line, and the earlier one on a `retained` line.

## Liveness and session continuation

A worker is watched through two signals (ADR-0013): its session transcript growing (`transcript.mjs` finds the file from the session id) and its terminal changing between busy and idle. It is **stuck** only while neither moves. The limits are in `settings.mjs`:

- **No movement** for 20 minutes: nudged. For 40: its session is continued.
- **Idle or exited without submitting**, with neither signal moving for the grace: nudged twice, then continued. A transcript still growing behind an idle terminal is a worker at work.
- **A nudge's own echo** is not movement: the nudge lands in the transcript and turns the TUI busy even in a hung session. After a nudge, movement counts only when the look it is measured against was taken at least `nudgeEchoMs` after the nudge; an earlier baseline is just replaced. So a runner that looks late never mistakes the echo for the worker.
- **Gone**, its tab closed: continued at once, in a new terminal. About 5 seconds after the close, Orca fails the dispatch itself (`dispatch.status: failed`, `stage: process_exited`, the terminal `orphaned`). `orca-cli.mjs` reads a failed dispatch on an orphaned terminal as gone, not settled, so a runner that looks only after that, or a resume that finds it so, still continues the session.
- **Blocked on a human**: logged loudly and journaled (`blocked`, then `unblocked` once answered), so the run view shows it as blocked, counts it in its header, lists it first in its phase's pane, and keeps it on its flash line until it is answered. After 30 minutes it fails and is kept, never continued, since continuing does not answer the question it waits on.

A **continuation** carries the same session on (decision D3 on #43). With the tab alive, the runner interrupts the stalled process, types `claude --resume <id>` (pi: `pi --session-id <id>`) with the worker's launch flags into the same terminal, and then a prompt telling the agent it was interrupted and must finish and submit; its dispatch is unchanged. With the tab gone, the resume runs in a new terminal in the same worktree, and `worker-start --terminal` adopts it with that prompt as its spec: Orca settles a dispatch only from its own pane, so the new pane gets a new dispatch, and the old one is stopped (never released during the run: a reclaim releases the dispatch of its last continuation). Either way the worker is watched again, and a continued agent that submits returns its result.

At most 3 continuations per agent. The next death fails it with a reason naming the cap, and it is **kept**: its process is not stopped, its tab stays open, and its worktree is retained. An agent that never started has no session to continue.

Not yet confirmed against live Orca: that `worker-show` follows a dispatch whose agent was resumed in its pane, and that two concurrent interrupts stop a pi worker as they stop Claude.

## Two checks, and when each runs

- **Offline:** `node scripts/test-orca-runner.mjs`. Fast and free. It runs the runner against the fake Orca, so it proves the runner does what the fake says Orca does, and nothing about the Workflow runner.
- **The runner contract test:** `scripts/runner-contract.workflow.js`. Slow, and it spends tokens on eight short agents per fresh run, so it runs by hand. It is the only check that the Orca runner gives a script what the Workflow runner gives it, and that is the promise the whole Orca runner rests on.
- **The Orca-only contract test:** `scripts/runner-contract-orca.workflow.js`, for the guarantees only the Orca runner makes. An agent runs it end to end with the Orca CLI, with no human and no `/workflows` UI (see [The Orca-only contract](#the-orca-only-contract)).

**It gates every Orca runner change.** A change to any file in this directory, or to the template's use of the hooks, is not done until the contract test returns the expected object under both runners, fresh and resumed. The offline tests do not replace it. A guarantee the script comes to rely on gets a case in the contract script first. The script has to stay byte-identical under both runners, and it must never use `Date.now()`, `Math.random()` or an argless `new Date()`.

## What the contract covers

| case | the script does | both runners must give |
|---|---|---|
| valid structured return | `contract:valid` returns an object against a schema | `valid: {count: 3, word: "hello"}` |
| bad first submit, repaired in-turn | `contract:repair` first returns a result missing a required field, reads the validation error, then returns it correctly | `repaired: {count: 3, first_attempt_rejected: true}` |
| the role table's options | `contract:options` passes `harness: 'claude'`, `model: 'sonnet'` and `piModel`, the options every template call spreads from its role table | `options: {count: 3, word: "hello"}`: the call is taken, not refused; the Workflow runner ignores `harness` and `piModel` |
| isolated worktree | `contract:here` and `contract:isolated` (`isolation: 'worktree'`) each return their `git rev-parse --show-toplevel` | `isolated: {own_worktree: true}`: the isolated agent's top level is not the run's |
| failed start, then success | `contract:retry` (`isolation: 'worktree'`) returns an object against a schema. Under the Orca runner its first worker start fails, injected by the preload the Orca leg is launched with (below), after its terminal and child worktree exist; the retry takes that worktree up. The Workflow runner has no start to fail, so there it is a plain call | `retried: {count: 3, word: "hello"}`: the same on both runners |
| throwing `parallel` thunk | two thunks throw, one synchronously and one as a rejected promise, beside the agents above | `thrown: [null, null]`, and `parallel()` itself does not reject |
| killed worker continued | `contract:continue` runs a nine-minute wait, and you kill it once, during the wait. Told it was interrupted and to carry on, it returns without waiting again | Orca runner: `continued: {done: true}`, its session continued in a new terminal. Workflow runner: `continued: null`, since it has no continuation |
| killed worker | `contract:kill` runs a nine-minute wait, and you kill it every time it runs: once under the Workflow runner, and under the Orca runner once and then after each of its 3 continuations, which rerun the wait. Both kill cases are awaited outside `parallel()`, so an `agent()` that throws on a dead agent cannot hide behind the null | `killed: null` |
| resume replaying from cache | the same script, relaunched with the runner's resume handle | the same object, with the six `parallel` agents replayed, not re-run |

The runners legitimately differ in one case, killed worker continued, and the expected object states it rather than shaping the case to hide it: a Workflow runner agent that is killed stays dead, and the Orca runner exists partly to continue it. Every other case returns the same value on both. The script cannot tell which runner runs it, so its own check (`RUNNER_OWN`) takes either value for `continued`; comparing the returned object with its runner's line below is what checks that the Orca runner continued the agent.

Every Orca runner run must return exactly this:

```json
{"valid":{"count":3,"word":"hello"},"repaired":{"count":3,"first_attempt_rejected":true},"options":{"count":3,"word":"hello"},"isolated":{"own_worktree":true},"retried":{"count":3,"word":"hello"},"thrown":[null,null],"continued":{"done":true},"killed":null,"failures":[]}
```

Every Workflow runner run must return exactly this:

```json
{"valid":{"count":3,"word":"hello"},"repaired":{"count":3,"first_attempt_rejected":true},"options":{"count":3,"word":"hello"},"isolated":{"own_worktree":true},"retried":{"count":3,"word":"hello"},"thrown":[null,null],"continued":null,"killed":null,"failures":[]}
```

The script checks itself as well. A non-empty `failures` names each case that broke, and the runner's log ends with `contract holds` or `N contract failure(s)`.

## How to run it

Run each runner from an Orca terminal on the repo. `<repo>` is the absolute path of the checkout, and `<dir>` is a scratch state dir outside it.

**Orca runner.** Launch it in its own terminal, so the Run binds to that terminal. `--require` preloads `scripts/runner-contract-orca-fault.cjs`, which fails `contract:retry`'s first `worker-start` as an Orca refusal would; the runner itself carries no test hook:

```
orca terminal create --title "runner contract (orca)" --command "node --require <repo>/scripts/runner-contract-orca-fault.cjs <repo>/skills/engineering/implement-spec-in-workflow/orca/runner.mjs <repo>/scripts/runner-contract.workflow.js --state-dir <dir>"
```

1. The runner starts the six `parallel` agents (`contract:valid`, `contract:repair`, `contract:options`, `contract:here`, `contract:isolated`, `contract:retry`). `contract:retry` logs `its worker did not start: … contract_fault …; trying again in 30s`, and its second attempt starts in the same `<runId>-<n>` worktree.
2. Once their results are in, it starts `contract:continue`. When the log shows `>> [Contract] contract:continue: started … in terminal <handle>`, kill that worker within nine minutes: close its tab, or run `orca terminal close --terminal <handle>`. The runner logs `continuing session … in a new terminal`, and the continued agent returns `{done: true}`. Kill it only once.
3. Then it starts `contract:kill`. Kill it the same way, and kill each new terminal it is continued in: four kills in all. A continued session first shows its earlier wait again, replayed from its transcript: kill it only once it has been told it was interrupted and has started the wait anew, or the kill lands before the continuation prompt does. The fourth logs `the cap of 3` and `agent() returns null`, and the runner prints `== Result` and writes `summary.json`. It asks nothing. In the run view press `r`, move the highlight, and press Esc: the flash line says `nothing reclaimed`, and the registry records no reclaim, so the resume and the checks below still find every agent. Then `q` quits the view, and the runner exits.
4. Resume from a new terminal: run the same command with `--resume` added, against the same `--state-dir`, in a new `orca terminal create`. The resumed runner logs taking the Run over (`run-use`), the six `parallel` agents and `contract:continue` log `replayed from the journal` and start no worker, and `contract:kill`, journaled as failed (see below), runs live again: kill it four times as before, and it prints the same result. Its run view names every agent of the Run, the fresh run's included, since the resume carries each forward in its journal; one the registry already records reclaimed shows as `reclaimed`.

The agents the fresh run kept, the failed ones the resume keeps, and the child worktrees `contract:isolated` and `contract:retry` leave all stay until reclaimed: reclaim them from the resumed run's view (`r`, then Reclaim All once the run has ended, even while its runner waits on the view), or reclaim the run with `r` on the standalone runs list, which names every agent of the Run, the fresh run's included; or close their tabs and remove the `<runId>-<n>` worktrees by hand (`orca worktree rm`).

**Workflow runner.** Run it in a Claude Code session that has the `Workflow` tool, for example `claude "<prompt>"` in an Orca terminal. Word the prompt so the agents do their own tasks. The Workflow runner can hand each subagent the session's request, and an agent that sees only "run a workflow" goes looking for the Workflow tool first:

> Run a workflow: call the Workflow tool with scriptPath `<repo>/scripts/runner-contract.workflow.js` and no other input. When it completes, resume it exactly once: call the Workflow tool again with the same scriptPath and resumeFromRunId set to the runId the first call returned. This is the runner contract test, and every agent either run starts is part of it: each agent must do exactly what its own prompt says, nothing more. contract:repair returns a wrong result first on purpose, and contract:continue and contract:kill each run a nine-minute wait that I kill by hand, in both runs; none of them needs the Workflow tool. Do not edit the script and do nothing else. After each run completes, print its runId and its returned value verbatim as one JSON block.

Type the prompt, or confirm it when asked: Claude Code 2.1.282 treats a prompt that arrives as pasted text alone as not the user's, and starts nothing until the user replies.

1. When `contract:continue` is the one agent still running, open `/workflows`, press Enter to reach the agent list, select `contract:continue`, and press `x`. It shows as `skipped`. Then `contract:kill` starts: kill it the same way, and the run completes. If the nine minutes run out first, the agent returns `{done: true}`, `failures` names it, and the run has to be done again.
2. On the resume, the six `parallel` agents are replayed, and `contract:continue` and `contract:kill`, which both returned null, run live again (see below). Kill each the same way.
3. The run record is in `~/.claude/projects/<project>/<session>/workflows/<runId>.json` (`result`). The journal, which shows what was replayed, is in `…/<session>/subagents/workflows/<runId>/journal.jsonl`.

Then compare the four results: Orca fresh, Orca resumed, Workflow fresh, Workflow resumed. Each must equal its runner's object above.

The script must reach the Workflow tool with LF line endings. The tool refuses a script that holds a carriage return ("script contains control characters that would be hidden in the approval dialog"), which is what a Windows checkout with `core.autocrlf` produces. `.gitattributes` pins `*.workflow.js` to LF. A checkout made before that line was added needs the file checked out again.

**For spec #43 the pass ran once, in #53, rather than per ticket** (decision D1 on #43). Its other tickets relied on the offline tests alone, and #53 ran the pass once the reliability work (#46, #47, #49, #50) had landed. Every other change still gates on its own pass.

That one pass does not cover all of #43, and the gate above is not met for what it misses:

- **#52**, the standalone run view, sits above #53 in the stack. It changed `runner.mjs`, `orca-cli.mjs` (`resumeRunner`, `resumeRunnerCommand`), `reclaim.mjs` and `registry.mjs`, and it added a new launch path, **R**'s resume from a new terminal typed by the view. No live pass has run the runner as #52 left it, and **R**'s launch has never been through one.
- **The review fixes on top of the stack** (the `spec/43-integration` branch) have not had a live pass either. They changed: the journal fold, and a resume re-journaling every earlier agent's worker; reclaim's liveness check, and the forced reclaim of a failed agent kept running; the `starting`, `blocked` and `unblocked` journal entries, and journaling `retry` before its wait; the reclaim outcome the runner recorded at a run's end (since removed, #71); runner liveness by `runner.pid` in both view modes; the registry fold reopening a resumed run; the view's short call bound and its refresh that survives an error; and the one bounded git helper in `orca-cli.mjs`.

Until a pass runs on the runner as it stands, these rest on the offline tests alone. The next change to this directory runs the pass for all of them.

Latest attempt: 2026-09-26 (#71), Orca 1.4.212 and Claude Code on macOS, with the runner as of #71, launched as above from `orca terminal create`, driven with `orca terminal` verbs only. **The contract did not hold, for reasons outside #71, so the gate is still unmet for this runner as it stands:**

- Run `run_de70cafc6b8b`, fresh: `contract:valid`, `contract:repair` and `contract:here` returned; `contract:isolated` and `contract:retry` failed (`orca terminal create: call_timeout: no answer within 120s`, then every retry refused with `worktree_held` on its own `<runId>-<n>` worktree), and `contract:options` sat blocked on a Claude permission hook for 35 minutes (the launch passed no `--permission-mode`). The run was stopped there, before `contract:continue`; the resume leg was not run. The create timeout and the reuse refusal are the worktree-create and timeout work of #67's other slices.
- **The reclaim dialog, in that run's attached view in its real Orca tab, while the runner was live:** `orca terminal send --text r` opened it (`▸ Reclaim Selected — every agent of Contract`, `Reclaim Successful Ones — the 3 done`, `Reclaim All — the runner is still live`); `--text $'\x1b[B'` moved the highlight to Reclaim Successful Ones; `--text $'\x1b'` closed it with `nothing reclaimed` on the flash line. The run registry recorded no `reclaimed` entry for the run and both of its child worktrees were still there. On a fixture run the same day, SGR mouse motion (`\x1b[<35;x;yM`) and presses sent the same way moved the highlight, and a press on the greyed-out Reclaim All did not. (Greyed there as `the runner is still live`, which was right while the script ran; that it stayed greyed once the run had ended was a bug, fixed since: see [the pass notes](#pass-notes).) The Orca-only contract, run on this runner once #69's worktree-create work was merged in, holds fresh and resumed, and the dialog check was repeated on that run: see [its pass notes](#pass-notes).

Last pass: 2026-09-25 (#53), Orca 1.4.209 and Claude Code 2.1.282 on Windows 11, with the runner as of #53. **The contract holds under both runners, fresh and resumed.**

- **Orca runner, fresh and resumed from a new terminal:** each returned the Orca object above exactly, with `failures: []` (Run `run_65b013436b27`: one fresh run and two resumes, each from its own new terminal):
  - `contract:continue` was killed once in its wait; the runner logged `its terminal is gone; continuing session … in a new terminal`, and the continued agent returned `{done: true}` without waiting again. `contract:kill` was killed four times, each continued session only once it had started the wait again, and failed at `the cap of 3`.
  - `contract:retry`'s first start failed on the injected `contract_fault`, and the retry 30s later started in the same `<runId>-6` worktree, found by `worktree list --limit 10000`; Orca made no `-6-2`.
  - Each resume took the Run over from its new terminal (a further `run` line with the same Run id and the new terminal), replayed the six `parallel` agents and `contract:continue`, and ran `contract:kill` live.
- **The first pass, and its fix:** an earlier pass that day, with the runner as of #50, returned `continued: null`. About 5 seconds after a worker's tab closes, Orca fails its dispatch itself (`dispatch.status: failed`, `stage: process_exited`, the terminal `orphaned`), and the runner read that as settled without a result, so it never continued the session, and `contract:kill` died at its first kill. `orca-cli.mjs` now reads a failed dispatch on an orphaned terminal as gone, and the fake Orca fails a closed tab's dispatch as real Orca does. A fresh run on that fix (Run `run_638e401fe2d7`) returned the Orca object exactly too; its resume killed `contract:kill` too late and got `{done: true}`, so it was run again as above.
- **Known risk, not exercised:** the contract has no stalled-session case. Both of its kills close the tab, so the pass exercised only the continuation in a new terminal. D3's primary path, continuing in the same tab (interrupt the stalled process, type `claude --resume <id>` into it, keep the same dispatch), is not yet confirmed against live Orca. Neither is interrupting a pi worker. See "Not yet confirmed against live Orca" above.
- **Release and retain:** nothing was released during any run. After the fresh run and both resumes, each ending with nothing reclaimed, all 20 dispatches of the Run were `terminalState: retained` with `releaseState: not_requested`: 7 `completed`, and 13 `failed`, one for each tab closed, which Orca failed on its own. Both child worktrees were still there. Each resume's reclaim named only `contract:kill`, the one agent it ran live.
- **Workflow runner, fresh and resumed:** each returned the Workflow object above exactly, with `failures: []` (run `wf_d37077df-c47`, Claude Code 2.1.282, the prompt above passed as `claude "<prompt>"`'s argument in an Orca terminal, which started it without asking for confirmation):
  - On the fresh run the six `parallel` agents returned in under 10 seconds. `contract:continue` and then `contract:kill` were each stopped with `x` in `/workflows` once in their wait, showed as `skipped`, and were journaled `failed`, so `continued` and `killed` came back `null`.
  - The resume kept the same runId and appended to the same journal: the six `parallel` agents logged no new `started` and were replayed (no tokens or time in `/workflows`), and `contract:continue` and `contract:kill` each started live again and were stopped the same way. The run record at `workflows/wf_d37077df-c47.json` holds the resume's result, which overwrote the fresh one; both equalled the object.
  - Neither run left a child worktree: the Workflow runner removed the unchanged worktrees of `contract:isolated` and `contract:retry` itself.

## The Orca-only contract

`scripts/runner-contract-orca.workflow.js` holds the guarantees the Orca runner makes and the Workflow runner does not. The two-runner script has to stay byte-identical under both runners, so such a case cannot go there. It is never run under the Workflow runner. Every Orca runner change runs it beside the two-runner test, fresh and resumed. A case is one key in the script's `EXPECTED`, one call, and one row below.

| case | the script does | the Orca runner must give |
|---|---|---|
| a result reaches the script | `orca-contract:returned` returns an object against a schema | `returned: {count: 3, word: "hello"}` |
| a create that times out, and the worktree it left dirty | `contract:dirty-retry` (`isolation: 'worktree'`) returns an object against a schema. The preload the run is launched with holds back its `worktree create`'s answer past the runner's create timeout (`worktreeCreateMs`, 10 minutes), after writing the untracked `contract-setup-output.txt` into the new worktree, as a setup hook's output would be. The runner logs `call_timeout … but Orca had made <path>, so it starts there`, and the agent starts in that worktree on its first attempt | `dirtyRetry: {count: 3, word: "hello"}` |

Every run, fresh or resumed, must return exactly this:

```json
{"returned":{"count":3,"word":"hello"},"dirtyRetry":{"count":3,"word":"hello"},"failures":[]}
```

### How an agent runs it

It uses only the Orca CLI and the state dir's files. The CLI is `orca`, or `/Applications/Orca.app/Contents/Resources/bin/orca` on macOS when it is not on PATH. `<repo>` is the absolute path of the checkout, and `<dir>` is a new, empty scratch dir outside it. `<worktree>` is an Orca worktree of a repo Orca knows (`orca worktree list --json`), and the runner's own agents work in it. A checkout Orca does not list, such as a git worktree made outside Orca, cannot be `<worktree>`: pass the main checkout, since the script paths can point anywhere.

Three rules hold for every case:

- **The runner runs in a new Orca terminal**, so its Run binds to that terminal and its view attaches there.
- **Every "kill" is `orca terminal close --terminal <handle>`.** The handle is on the worker's log line `>> [Contract] <label>: started … in terminal <handle>`, and on its `started` line in `<dir>/journal.jsonl` (`terminal`). A session continued in a new terminal has its new handle only on its `continued` journal line (`terminal`, `reopened: true`), never in the log.
- **Every "operator answer" is `orca terminal send --terminal <runner> --text <key>`**, with no `--enter`. The run view reads single keys, and Enter is an answer of its own.

The steps:

1. **Launch** and keep `result.terminal.handle` as `<runner>`:
   ```
   orca terminal create --worktree path:<worktree> --title "runner contract (orca only)" --command "node --require <repo>/scripts/runner-contract-orca-fault.cjs <repo>/skills/engineering/implement-spec-in-workflow/orca/runner.mjs <repo>/scripts/runner-contract-orca.workflow.js --state-dir <dir>" --json
   ```
   `--require` preloads the faults the cases need (`scripts/runner-contract-orca-fault.cjs`). A fresh run takes over ten minutes, most of it `contract:dirty-retry`'s held create.
2. **Wait for `<dir>/summary.json`.** Poll for the file. `<dir>/runner.pid` holding a pid that is no longer alive (`node -e "process.kill(+process.argv[1], 0)" <pid>` throws) and no `summary.json` means the runner died: the pass failed. Do each case's kills and answers from its row above as the log reaches them.
3. **Check the reclaim dialog, then quit the view.** The runner asks nothing at its end: it writes `summary.json` and stays in its tab on the ended run, keeping every agent, so the resume finds them. Open the dialog with `r`, move its highlight down with `--text $'\x1b[B'`, and close it with Esc, `--text $'\x1b'`. `orca terminal read --terminal <runner> --screen` shows the dialog while it is open, and `nothing reclaimed` on the flash line once Esc closed it. Nothing was reclaimed if the run registry (`~/.claude/orca-runs.jsonl`, or `$CLAUDE_CONFIG_DIR/orca-runs.jsonl`) holds no `reclaimed` line for the run, and `orca worktree list --json` still lists every `<runId>-<n>` child worktree. Then send `q`. The log shows `!! the run view was closed; the runner prints its log in this tab again`, and the runner exits. Check its pid is dead.
4. **Confirm the fresh run** (below). Copy `summary.json` aside, since the resume replaces it.
5. **Resume:** run the same command with `--resume` added, against the same `<dir>`, in a new `orca terminal create`, and keep its handle as the new `<runner>`. The agents that returned a value log `replayed from the journal` and start no worker. Wait, check the dialog and quit as in steps 2 and 3, then confirm again.
6. **Clean up:** close the kept worker tabs, named on the `!! kept …, tab <handle>` log lines, and the runner tabs with `orca terminal close`. Remove any `<runId>-<n>` child worktree, `contract:dirty-retry`'s included, with `orca worktree rm` (add `--force`: it holds the untracked file).

### How it confirms the result

Both checks must hold, on the fresh run and on the resume:

- **`summary.json`** is `{runner: "orca", ok: true, result}`, and `JSON.stringify(result)` equals the object above exactly. `ok: false` means the script threw, and `error` holds the stack.
- **The log's last line.** Every `runner.log` line is `<ISO time> <text>`, and the script's own `log()` lines are indented three spaces. The script's last line is `<time>    contract holds`, or `N contract failure(s)` after a `FAIL` line per broken case. It is not the file's last line: after it come `== Result`, the result and the view's quit line, and on a resume the fresh run's lines stand above it. Take the last line that matches `contract (holds|failure)`, which is the one just before the last `== Result`.

### Pass notes

Last pass: 2026-09-26 (#71), Orca 1.4.212 and Claude Code on macOS, with the runner as of #71 and #69's worktree-create work merged into it, driven by an agent with the steps above alone and `orca terminal` verbs only, launched with the preload from `orca terminal create`. **The Orca-only contract holds, fresh and resumed, and the reclaim dialog reclaims nothing on Esc in the run's real Orca tab** (Run `run_fc7b258ee87f`).

- **Fresh:** `orca-contract:returned` went idle once, was nudged, and submitted. `contract:dirty-retry`'s create was held back: the runner logged `orca worktree create: call_timeout: no answer within 600s, but Orca had made …/run_fc7b258ee87f-2, so it starts there`, 600 s after the create was sent (the host did not sleep), and started the agent there on its first attempt with no `retry` line; the worktree held `?? contract-setup-output.txt`. That agent too was nudged once and submitted. `summary.json` held `ok: true` and the object above exactly, and the last script line was `contract holds`. The runner asked nothing at its end and stayed in its tab.
- **The reclaim dialog, on the ended fresh run's attached view, in its real Orca tab:** `orca terminal send --text r` opened it over the tree: `▸ Reclaim Selected — every agent of Contract`, `Reclaim Successful Ones — the 2 done`, `Reclaim All — the runner is still live` (greyed: the runner stays live in its tab until the view quits). That greyed Reclaim All, on a run that had ended, was a bug, fixed since: the dialog then keyed Reclaim All to the runner's process being alive, not to the run's end. It now offers Reclaim All once the run has ended (the registry's `ended` with no resume after, or `summary.json` from the live runner), though the runner still waits on the view, and greys it out as `the run is still going` only while the script runs; the offline test covers an ended run with its runner still live. This pass has not been re-run on Orca since. `--text $'\x1b[B'` moved the highlight to Reclaim Successful Ones; `--text $'\x1b'` closed the dialog, and the flash line said `nothing reclaimed`. The registry held no `reclaimed` line for the run, the journal no reclaim, `run_fc7b258ee87f-2` was still in `orca worktree list`, and both worker tabs were still open. `q` then closed the view (`!! the run view was closed; …`), and the runner's pid was dead.
- **Resumed** from a new terminal: both agents logged `replayed from the journal` and started no worker; `summary.json` held the same object, and `contract holds` was the last script line. The same dialog check on the resumed view gave the same dialog; a second down arrow left the highlight on Reclaim Successful Ones, passing over the greyed Reclaim All (the same bug); Esc said `nothing reclaimed`, with no `reclaimed` registry line and the child worktree still listed. `q` ended it, and its pid was dead.
- Cleaned up afterwards with `orca terminal close` on the two worker tabs and both runner tabs, and `orca worktree rm --force` on `run_fc7b258ee87f-2`.

Earlier pass: 2026-09-26 (#70), Orca 1.4.212 on macOS, with the runner as of #70's baseline, driven by an agent with the steps above alone, launched with the preload. **The Orca-only contract holds, fresh and resumed** (Run `run_668258cc4973`).

- **Fresh:** `contract:dirty-retry`'s create was held back past its 600s bound, and the runner found `run_668258cc4973-2` by name and started the agent there on its first attempt, as under #69. A create that timed out has no baseline, so the journal holds no `baseline` line and the agent's prompt no baseline section; the contract has no case whose create is answered in time, so no pass has yet journaled a baseline from live Orca. Both agents submitted (`contract:dirty-retry` after one nudge); `summary.json` held `ok: true` and the object above exactly, and the log's script lines ended `contract holds`. `n` and `q` ended it, and the runner's pid was dead.
- **Resumed** from a new terminal: both agents logged `replayed from the journal` and started no worker; `summary.json` held the same object, and `contract holds` was the last script line.

Earlier pass: 2026-09-26 (#69), Orca 1.4.212 on macOS, with the runner as of #69, driven by an agent with the steps above alone, launched with the preload. **The Orca-only contract holds, fresh and resumed** (Run `run_6d1d57987103`).

- **Fresh:** `contract:dirty-retry`'s create was held back; its worktree `run_6d1d57987103-2` held `?? contract-setup-output.txt` (and the repo's setup hook ran `npm install` in it). The runner logged `orca worktree create: call_timeout: no answer within 600s, but Orca had made …/run_6d1d57987103-2, so it starts there`, journaled it as a `warning`, and started the agent in that worktree with no `retry` line. Both agents went idle once, were nudged, and submitted. `summary.json` held `ok: true` and the object above exactly; the log's script lines ended `contract holds`. `n` and `q` ended it, and the runner's pid was dead.
- **Resumed** from a new terminal: both agents logged `replayed from the journal` and started no worker; `summary.json` held the same object, and `contract holds` was the last script line.
- The host slept twice during the run (`pmset -g log`: 10:06:54Z to 10:22:33Z, and again after the result). The create's 600s bound, set at 10:06:20Z, fired at 10:22:38Z, five seconds after the wake: Node's timers count the time the host sleeps, and fire overdue on waking. See [a bound that fires on waking](#a-bound-that-fires-on-waking).

Earlier pass: 2026-09-26 (#68), Orca 1.4.212 on macOS, with the runner as of #68's lifecycle failure point, driven by an agent with the steps above alone. **The Orca-only contract holds, fresh and resumed** (Run `run_0ee4fd996340`).

- The skills checkout was not yet a repo in Orca, so it was added with `orca repo add`. The agent's own git worktree was not in `orca worktree list`, so `<worktree>` was the main checkout and the script paths pointed into the agent's worktree.
- **Fresh:** `orca-contract:returned` started in the main checkout, went idle without submitting after about two minutes, was nudged once, and then submitted. The log's script lines ended `orca-contract:returned returned {"value":{"word":"hello","count":3}}`, then `contract holds`. `summary.json` held `ok: true` and the object above exactly. `n` sent with `orca terminal send --text n` logged `chosen: none`, and `q` closed the view, after which the runner's pid was dead.
- **Resumed** from a new terminal: `orca-contract:returned` logged `replayed from the journal` and started no worker. The log's last script line was `contract holds`, and `summary.json` held the same object. With no agent to run live, the resume took no Run over: its journal's one `run` line names the fresh runner's terminal. `n` and `q` ended it as on the fresh run.
- No kill ran, since the one case has none. `orca terminal close` was used only to clean up the worker tab and the two runner tabs.

## A bound that fires on waking

Every bound the runner keeps (a call's timeout, the backoff, the liveness limits) is a Node timer, and on macOS Node's timers count the time the host sleeps: a timer due while the host sleeps fires as soon as it wakes, and Orca, asleep with it, never had the chance to answer. So a laptop that sleeps through a call fails that call as `call_timeout`, however little of its bound Orca had. `run_0476d67e2fed`'s 5m01s is this: `publish:#2`'s `worktree create` was sent at 00:26:17Z, in a dark wake; the host went to sleep at 00:26:18Z for 300 s, and woke at 00:31:18Z, the second the create's 120 s bound fired (`pmset -g log`). Orca finished the create on waking, which is how its setup hook's output got there. The create's own bound and the lookup after a timeout make that case cost no attempt; a sleeping host still stretches every other wait.

## A dead agent on resume

Both runners journal an agent that returned `null` as failed, with no result: a worker that died by any of the runner's liveness limits, one whose worker never started, and one whose Run Orca could not create. A resume therefore runs that call live again, and every call after it, as it does for an edited call. A failed entry keeps its place among identical calls, so the k-th call with a key never replays a later call's result. In the contract test this means `contract:kill` runs live again on the resume, under either runner, and has to be killed again as on the fresh run. Under the Workflow runner `contract:continue` returned null too, so it also runs live again and is killed once more; under the Orca runner it returned a value and is replayed.

## Harness and model

Each template call spreads its role's row from the `ROLES` table: `harness` (`claude` or `pi`), `model`, always a Claude model name, and for a pi row `piModel`, a pi model pattern (`provider/id`). The runner starts a pi worker with `piModel` and never hands it `model`; the Workflow runner ignores `harness` and `piModel` and runs every role on Claude with `model`. So a row edited to pi keeps a Claude `model`, and the same rendered script runs on either runner.

## Worktrees and the board

An `agent()` with `isolation: 'worktree'` runs in a new Orca child worktree of the run's worktree. Every worker starts from its harness's own command line, carrying its session id, in a terminal the runner creates. `worker-start --terminal` then adopts that terminal, and `--agent` is never used. A process that is already running cannot be moved into another worktree, so the child is made first with `orca worktree create --parent-worktree current`. The worker's terminal opens there with `terminal create --worktree path:<child>`, and `worker-start --terminal` is told the same worktree.

The runner sets each child worktree's board status with `orca worktree set --workspace-status`: `in-progress` when its worker starts (`in-review` for an agent in the `Gate` phase), and `completed` when its agent reports a PR it published (a result with a `pr_url` and `published` not false). A reclaimed worktree leaves the board with its removal. A status or display name Orca refuses is logged and journaled as a `warning`, and the agent carries on. The run's own worktree is never touched.

## What is kept, and reclaiming it

Nothing is reclaimed while a run runs (ADR-0012). No worker is released when it returns, no tab is closed, and no worktree is removed — not by the runner, and not by the script: under the Orca runner the template's reclaim steps hand no agent a path to remove. A worktree whose agent died, or whose worker never started, is also named in the run's `worktrees_kept`, retained because its agent died or never started, with its reason, and in the log. It is journaled with the failed call, so a resume, which runs that call again in a new worktree, still names the old one. When the script throws, `summary.json` carries the same list beside the `error`.

Nor at its end: once `summary.json` is written, the runner prints the result and asks nothing. The operator reclaims only from the run view, when they choose: on a run's tree, `r` opens the reclaim dialog (below); on the standalone runs list, `r` reclaims a whole run.

Reclaiming an agent releases its worker, closes its tab if Orca's terminal list still shows it, and removes its worktree through Orca. Every choice keeps the same rules. An agent still live is never touched. One that failed and was kept with its worker still running (Orca shows it live) is reclaimed only once `f` confirms stopping that worker, which is stopped before anything is removed; closing its tab and reclaiming it again works too. A worktree holding commits no remote-tracking ref contains is removed only once `f` confirms forcing it. An agent Orca refuses is kept, and named with the reason. A worktree not named `<runId>-<n>` is the operator's own and never touched. Each reclaim is appended to the run registry. The runner exits once the operator has quit the run view; the tab stays, holding what it printed.

## The run view in the runner's tab

Launched in a terminal, the runner starts the run view (ADR-0012; the design is `docs/design/orca-run-view-tree.md`) as its child, in its own tab: the run as a tree of phases and agents that updates in place. The view reads the run from the state dir, the run registry and Orca, never from the runner, so what it shows does not depend on the runner. Its keys: ↑↓ move; on a phase, a click, Enter or ←/→ folds it; on an agent, a click or Enter focuses its Orca tab and worktree; `r` opens the reclaim dialog (below); `l` opens `runner.log` in an Orca tab of its own that follows it as it grows, or brings that tab back while it is open (Orca's editor opens no file outside a worktree, and the run dir is outside every checkout); `q` quits the view, never the run.

The reclaim dialog takes every key and click while it is open; the tree keeps redrawing behind it but takes no input. Its options, in order:

| option | reclaims |
|---|---|
| Reclaim Selected | the agent under the cursor, or every agent of the phase under it |
| Reclaim Successful Ones | every agent whose state is done |
| Reclaim All | every agent, once the run has ended, even while its runner waits on the view; greyed out, with its reason, and not selectable while the run is still going (or nobody can say whether it has ended) |

↑↓ and the mouse, hovering or clicking, move the highlight; only Enter accepts, and Esc closes it having reclaimed nothing. The rules above then apply to each agent the choice names, one by one: a live one is kept and named, and each one holding unpushed commits, or failed with its worker left running, asks its own confirmation in turn — `f` confirms it, any other key keeps that agent and goes on to the next.

While the view is attached (decision D5 on #43):

- The view owns the tab's screen and keys. The runner writes only to `runner.log`, and the view's flash line shows its latest line. Ctrl-C in the view closes the view; a Ctrl-C that reaches the runner is ignored.
- A crash of the view never touches the run. The runner puts the tab back (main screen, cursor, no mouse reporting, no raw mode) and starts the view again after `viewRestartMs`. At the `viewCrashes`-th crash of a run, the runner stops restarting it and prints its log in the tab again, starting with the log's last 20 lines. Both limits are in `settings.mjs`.
- `q` ends the view for good: the runner prints its log in the tab again, and exits once the script has ended.
- With no terminal (stdout or stdin redirected, as in the offline tests) there is no view, and the runner prints as it always did.

The view exits 0 when the operator quits it and 3 when it cannot run here (`run-view/exit-codes.mjs`); the runner never restarts either. Anything else is a crash.

The view's one dependency, terminal-kit, is pinned in `run-view/package.json` with a committed lockfile. It is installed beside `view.mjs` on the view's first start (`npm ci`, its output in `runner.log`), because the installed skill may be a copy of the repo rather than a link to it, and the copy is where the view runs. This departs from ADR-0001's self-contained repo, and ADR-0012 records the departure: nothing is vendored, so the first view needs npm and the network. If the install fails, the view exits 3 and the runner prints its log in the tab. The offline tests import `draw.mjs` and the model, never terminal-kit, so they need no install.

To look at the view without a run, point it at a run dir: `node run-view/view.mjs --attached <state-dir> [--registry <registry file>]`. `--registry` is for a fixture run, whose header comes from a registry file of its own rather than the machine's.

## The run view standalone

`node run-view/view.mjs --standalone [--registry <registry file>]`, which the [`orca-runs`](../../orca-runs/SKILL.md) skill opens in a new Orca tab (D8 on #43), lists every run in the run registry, grouped by project, the project of the latest run first. No runner needs to be going. Each run shows its spec, its outcome (`ok`, `partial` or `failed`, or none while no `ended` is recorded), whether its runner is alive, how many agents it keeps (those its journal names that no `reclaimed` entry has taken), and its age since it was armed. A runner is alive by the one rule attached mode's header uses too (`runnerAlive` in `run-view-model.mjs`): the process `<runDir>/runner.pid` names is alive. Its tab says nothing, since the tab outlives the runner. The one exception is the tab **R** opened, which counts as the runner while Orca lists it, until the new runner has written its own `runner.pid`. When a `runner.pid` cannot be read or probed, the view says it does not know. A run the registry records ended or reclaimed, then resumed, is running and open again: the resume's `runner` entry reopens it. Two runs in one repo are two rows, keyed by Run id.

Its keys, on the list:

- **Enter** or a click opens the run into the same tree attached mode shows, with the same keys, which the runs list hands on to it. **q** or Escape goes back to the list; **q** on the list closes the view.
- **r** reclaims the whole run: every agent it keeps, one by one, under the reclaim rules above. A live agent, or one whose worktree holds unpushed commits, is kept and named with why; forcing one is done inside the run, with `r`, Reclaim Selected, then `f`. Each reclaimed agent is appended to the registry. Once none of the run's agents is left, the run is recorded reclaimed, but only when its runner is known dead, whether or not the run has ended: no entry undoes that record, and a live runner may start more agents, which it keeps as evidence (ADR-0012). A dead runner starts none, and **R** refuses a reclaimed run. While the runner is alive, or nobody can say, **r** reclaims what the rules allow and the run stays open, and says why.
- **R** resumes a run whose runner is dead: a new Orca terminal in the run's worktree (its `project`), brought to the front, running `node runner.mjs <script> --state-dir <runDir> --resume [--permission-mode <mode>]`, which takes the Run over as a resume from a new terminal does (above). A run armed before the registry recorded its script resumes `workflow.js` beside its state dir, as the skill lays them out. **R** is not offered, and does nothing, on a run recorded reclaimed, whose agents are gone; nor while the runner is alive, or while nobody can say; the terminal it opened counts as the run's runner at once, so a second **R** opens nothing. **R**'s resume launch has not been through a live contract pass (below). Inside an opened run, **R** resumes that run.

Only the registry's runs are listed, and a worktree is shown, and touched, only when it is named `<runId>-<n>`: an agent that ran in the run's own checkout shows no worktree, and a worktree the operator made is never listed or removed. Reading, stopping and releasing a worker are not fenced to the Run's coordinator (live, Orca 1.4.209), so the view reclaims any run without taking it over. With no terminal the standalone view exits 3 and says so; npm's output, on its first start, goes to `orca-runs-view.log` beside the registry.

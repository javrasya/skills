# The Orca runner

The second runner for `workflow.template.js` (ADR-0011): a Node script, launched in its own Orca terminal, that runs the rendered workflow script unchanged and starts each `agent()` as a supervised Orca worker the operator can watch and answer.

| file | what it is |
|---|---|
| `runner.mjs` | the runner: the four hooks, the live cap, liveness, the resume journal |
| `submit.mjs` | the worker's end of `agent()`: validates the payload, records it, sends `worker_done` |
| `orca-cli.mjs` | the one place anything talks to Orca |
| `fake-orca.mjs` | an in-memory Orca behind the same methods, for the offline tests |
| `schema.mjs` | the JSON Schema subset the template's schemas use |
| `settings.mjs` | every limit the runner enforces, in one table |

```
node runner.mjs <rendered-script.js> [--state-dir <dir>] [--resume] [--permission-mode <mode>]
```

The state dir defaults to `orca-run/` beside the rendered script, which is `<notes-dir>/orca-run` for a run the skill armed. When the runner exits it writes `summary.json` there — `{"runner": "orca", "ok": true, "result": …}`, or `"ok": false` with the `error` — and that file, not the terminal's log, is what the arming session reads and reports. It is removed at start, so a file left by an earlier run never passes for this one's.

## Two checks, and when each runs

- **Offline:** `node scripts/test-orca-runner.mjs`. Fast and free. It runs the runner against the fake Orca, so it proves the runner does what the fake says Orca does, and nothing about the Workflow runner.
- **The runner contract test:** `scripts/runner-contract.workflow.js`. Slow, and it spends tokens on three short agents per fresh run, so it runs by hand. It is the only check that the Orca runner gives a script what the Workflow runner gives it, and that is the promise the whole Orca runner rests on.

**It gates every Orca runner change.** A change to any file in this directory, or to the template's use of the hooks, is not done until the contract test returns the expected object under both runners, fresh and resumed. The offline tests do not replace it. A guarantee the script comes to rely on gets a case in the contract script first. The script has to stay byte-identical under both runners, and it must never use `Date.now()`, `Math.random()` or an argless `new Date()`.

## What the contract covers

| case | the script does | both runners must give |
|---|---|---|
| valid structured return | `contract:valid` returns an object against a schema | `valid: {count: 3, word: "hello"}` |
| bad first submit, repaired in-turn | `contract:repair` first returns a result missing a required field, reads the validation error, then returns it correctly | `repaired: {count: 3, first_attempt_rejected: true}` |
| throwing `parallel` thunk | two thunks throw, one synchronously and one as a rejected promise, beside the two agents above | `thrown: [null, null]`, and `parallel()` itself does not reject |
| killed worker | `contract:kill` runs a nine-minute wait, and you kill it during the wait. It is awaited outside `parallel()`, so an `agent()` that throws on a dead agent cannot hide behind the null | `killed: null` |
| resume replaying from cache | the same script, relaunched with the runner's resume handle | the same object, with `contract:valid` and `contract:repair` replayed, not re-run |

Every run must return exactly this:

```json
{"valid":{"count":3,"word":"hello"},"repaired":{"count":3,"first_attempt_rejected":true},"thrown":[null,null],"killed":null,"failures":[]}
```

The script checks itself as well. A non-empty `failures` names each case that broke, and the runner's log ends with `contract holds` or `N contract failure(s)`.

## How to run it

Run each runner from an Orca terminal on the repo. `<repo>` is the absolute path of the checkout, and `<dir>` is a scratch state dir outside it.

**Orca runner.** Launch it in its own terminal, so the Run binds to that terminal:

```
orca terminal create --title "runner contract (orca)" --command "node <repo>/skills/engineering/implement-spec-in-workflow/orca/runner.mjs <repo>/scripts/runner-contract.workflow.js --state-dir <dir>"
```

1. The runner starts `contract:valid` and `contract:repair`. Once both results are in, it starts `contract:kill`.
2. When the log shows `>> [Contract] contract:kill: started … in terminal <handle>`, kill that worker within nine minutes: close its tab, or run `orca terminal close --terminal <handle>`. The runner logs `agent() returns null` and prints `== Result`.
3. Resume. Run the same command with `--resume` added, against the same `--state-dir`. All three calls log `replayed from the journal`, no worker starts, and it prints the same result.

**Workflow runner.** Run it in a Claude Code session that has the `Workflow` tool, for example `claude "<prompt>"` in an Orca terminal. Word the prompt so the agents do their own tasks. The Workflow runner can hand each subagent the session's request, and an agent that sees only "run a workflow" goes looking for the Workflow tool first:

> Run a workflow: call the Workflow tool with scriptPath `<repo>/scripts/runner-contract.workflow.js` and no other input. When it completes, resume it exactly once: call the Workflow tool again with the same scriptPath and resumeFromRunId set to the runId the first call returned. This is the runner contract test, and every agent either run starts is part of it: each agent must do exactly what its own prompt says, nothing more. contract:repair returns a wrong result first on purpose, and contract:kill runs a nine-minute wait that I kill by hand, in both runs; neither needs the Workflow tool. Do not edit the script and do nothing else. After each run completes, print its runId and its returned value verbatim as one JSON block.

1. When `contract:kill` is the one agent still running, open `/workflows`, press Enter to reach the agent list, select `contract:kill`, and press `x`. It shows as `skipped`, and the run completes. If the nine minutes run out first, it returns `{done: true}`, `failures` names `killed`, and the run has to be done again.
2. On the resume, `contract:kill` runs live again (see below). Kill it the same way.
3. The run record is in `~/.claude/projects/<project>/<session>/workflows/<runId>.json` (`result`). The journal, which shows what was replayed, is in `…/<session>/subagents/workflows/<runId>/journal.jsonl`.

Then compare the four results: Orca fresh, Orca resumed, Workflow fresh, Workflow resumed. All four must equal the object above.

The script must reach the Workflow tool with LF line endings. The tool refuses a script that holds a carriage return ("script contains control characters that would be hidden in the approval dialog"), which is what a Windows checkout with `core.autocrlf` produces. `.gitattributes` pins `*.workflow.js` to LF. A checkout made before that line was added needs the file checked out again.

Last pass: 2026-09-23, Orca 1.4.207 and Claude Code 2.1.280 on Windows 11, with the runner as of #30, whose entry point writes `summary.json`. All four results were equal to the expected object. The Orca fresh and resumed runs each left a `summary.json` with `"runner": "orca", "ok": true` and that object as `result`. The Orca resume started no worker. The Workflow resume replayed `contract:valid` and `contract:repair` and re-ran `contract:kill`.

## Known difference: a killed agent on resume

The two runners return the same object, but they journal a killed agent differently:

- The **Workflow runner** journals a skipped agent as `failed`, with no result. A resume therefore runs that call live again, and it has to be killed a second time.
- The **Orca runner** journals the `null` as a result. A resume replays it, and nothing is started.

Both give `killed: null`, but only because the operator repeats the kill on the Workflow runner. The difference matters to a real run. After a failure, the Workflow runner retries an agent that died, while the Orca runner replays that agent's `null` until someone edits the call. It is recorded here rather than fixed, because it belongs to the resume journal's owner (#27).

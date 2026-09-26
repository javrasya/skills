# ADR-0014: A failed agent gets a doctor before it returns null, and its dependents wait while it works

## Status

Accepted — 2026-09-26. Extends ADR-0012 and ADR-0013. Applies to the **Orca runner only**; the Workflow runner, and the shared workflow script, are unchanged.

## Context

Under ADR-0013 an agent that fails is null at once. That happens when its session dies past the continuation cap, its start fails after every retry, or it waits on a human past the blocked limit. The script then carries on without it, and everything built on that agent is lost with it. Often the failure has a cause another agent could name by reading the failed session: a sandbox that refuses a command, a wrong assumption repeated in each continuation, a login that expired. A continuation carries the same session on with the same blind spot. A restart repeats it.

Orca workers are real sessions with transcripts, a journal names every line of their life, and the runner log holds what the operator saw. So a second agent can read all of that and say what went wrong, while the first is kept as it stands (ADR-0012).

The question is what the script sees while that happens. There were three options:

- **Return null now and repair later.** The script's dependents would already have moved on, so a repair would have nothing to feed into.
- **Throw from `agent()`.** This breaks the promise both runners make to the shared script: `agent()` resolves to a value or null.
- **Keep the call pending.** The script waits on the patient exactly as it waits on any long agent.

## Decision

**A failed agent is a patient, and the runner starts a doctor for it before its `agent()` returns null.** The first failure kind covered is a session dead past its continuation cap. The others follow in #75.

- **The patient's promise stays pending.** Nothing is journaled as `failed` for it yet. A `doctor` line records the round instead. Whatever awaits the patient waits. Every agent that does not depend on it carries on, since the script's own `parallel` and `await` structure decides dependency, not the runner.
- **The patient frees its live slot** before its doctor starts. A doctor needs a slot too, and a patient holding one while it waits on its own doctor would starve the run, or deadlock it at a cap of one.
- **The doctor is an agent like any other.** It is a supervised Orca worker started through the same lifecycle, with the same journal, live cap, start retries and liveness. Its worktree is `<runId>-<n>`, named from the run's next agent number, and it is created with Orca's setup hook skipped (`--setup skip`), so no setup output, dirty tree or slow create can fail the doctor itself. It is titled `[<patient's phase>] recover -> <patient label>`, and it runs on the `recover` row of the template's role table.
- **The doctor changes nothing.** Its prompt hands it the patient's title, prompt, failure reason, journal entries, runner log lines, transcript path, its worktree path if it has one, and which round it is of three. Its only output is a note. When a human is needed, it states the situation and what the human must do or decide, without questioning them.
- **At most three rounds, and a doctor is never doctored.** A doctor that ends without a remedy spends its round. That covers both a doctor that gives up (`worker_done --outcome failed`) and one that fails itself after its own start retries and continuations. After the third round the patient's call returns null, and it is failed and kept, as before.

## Consequences

- **Dependents can wait a long time.** The cost is that a failure no doctor can mend holds its dependents up for three doctor rounds before they learn it is null. The run as a whole never stalls on it, because independent work goes on. And a result that comes late is better than a null at once for work that is built on it.
- **The doctor is visible like any agent.** It has its own tab, worktree, journal lines and `<runId>-<n>`, so the operator can watch it, and reclaim finds it. The journal links it to its patient: the patient's `doctor` line names the doctor's n, the fold gives each patient its `doctors` and `round`, and it gives each doctor its `patient`.
- **A doctor's failure is not the run's failure.** Its lines carry `key: null`, since it is no `agent()` call. Its `failed` line names its patient and is not counted towards a partial run. Only the patient's final `failed` counts.
- **The runner has to read the role table.** A doctor is started by the runner, not by an `agent()` call with a role row spread into it. So the template hands its table over as `meta.roles`, under the Orca runner only.
- **No remedy is applied yet.** Handing the note back to the patient, whose session is then continued with it, comes with the mail protocol in later tickets. Until then every round ends without a remedy, and the patient ends null after three.

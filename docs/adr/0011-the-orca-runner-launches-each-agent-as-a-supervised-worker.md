# ADR-0011: The Orca runner launches each agent as a supervised Orca worker, and names its tab

## Status

Accepted — 2026-09-23. Settled by the spike in #22, for spec #21. Amends ADR-0002's consequence "It needs a harness with a workflow primitive": a run needs a **runner** — the host's workflow primitive, or Orca. ADR-0002's decision (one script, deterministic scheduling) stands unchanged; the script is the same under either runner.

## Context

Spec #21 gives `implement-spec-in-workflow` a second runner. The rendered workflow script depends only on its hooks (`agent()`, `parallel()`, `phase()`, `log()`) and the options an agent call takes, so whatever supplies them can run it. The **Workflow runner** is today's path, the host's workflow primitive, whose agents are hidden behind its own screen. The **Orca runner** is a Node script launched in its own Orca terminal, and its whole reason to exist is that every agent it starts is a live session the operator can watch, type into and answer.

That rests on one assumption Orca's own documentation declines to make: *"Not every worker has a terminal … `orca terminal` verbs do not accept every worker handle."* Two launch paths were open:

1. **Supervised worker** — `orca orchestration worker-start --spec … --agent …` into a Run the runner owns. Orca creates the task, the dispatch and the agent, injects the worker contract, and settles the dispatch on `worker_done`; inspection, mail and release come with it.
2. **Fallback** — `orca terminal create --command "claude …"` (or `pi …`) in an Orca worktree, with completion detected by the agent's result file plus `orca terminal wait --for tui-idle`. Always a terminal by construction, and the only path that can pass a permission mode, or a model and effort to pi; but the runner would own every lifecycle step Orca's orchestration already provides.

The spike ran path 1 once on the operator's machine (Orca 1.4.207, Windows 11) and recorded what came back:

- **Desktop use works, and better than expected.** `orca computer list-apps` lists Orca; `get-app-state` captures a screenshot of its window. The accessibility tree was *not* empty, as the ticket expected: it held 115 elements, and every tab appears as a `sortable` named by its tab title. A tab can be found, and clicked, by title.
- **An orchestration mutation must come from the terminal it names.** `run-create --from <another handle>` was refused with `consumer_fenced` ("This terminal is attested as … and cannot act as …"). The Run was created by typing the command into a throwaway coordinator terminal instead.
- **The worker got a terminal.** `worker-start` exited 0 with `state: ready`, `mode: {mode: "terminal", reason: "user_default"}` — "the default for new agent tabs in your settings" — and a `terminal` effect with `surface: visible`. `worker-show` named it as `worker.agentTerminalHandle`, with its `tabId`; `terminal show` accepted the handle.
- **The agent titles its own tab, and ignores `--task-title`.** Claude Code set the tab title from its prompt ("Ticket 22 spike"). `orca terminal rename` set the tab to `[Spike] spike-22 worker-tab probe`, which the screenshot and the accessibility tree both showed — while `terminal show` went on reporting the agent's own title in `title`.
- **Permission mode came from the operator's setting.** The worker ran with bypass permissions on; `worker-start` has no flag for it, as documented.
- **Release is one verb; a Run cannot be deleted.** `worker_done` settled the dispatch in 13 seconds, and `worker-release` closed the agent terminal and archived its transcript. No verb removes a Run (`reset --all` wipes every Run on the machine), so the spike's Run stays in `run-list` as an empty namespace.

## Decision

**The Orca runner launches every agent as a supervised Orca worker.** The fallback is not taken: the spike found the terminal the fallback exists to guarantee, and the supervised path brings settlement, inspection, mail and release that the fallback would have to rebuild.

**The runner is its own coordinator.** It runs `run-create` itself from its own terminal, so the Run is bound to the runner and every later call is made from the terminal Orca attests. Nothing calls with `--from` for another terminal; Orca refuses it.

**Every worker runs in a terminal the runner made** (amended by #45, decision D2 on #43). The runner no longer lets `worker-start --agent` launch the agent. For every worker, with or without a permission mode, Claude or pi, it creates the agent's terminal with the harness's own command line, waits for its TUI to go idle, and hands that terminal to `worker-start --terminal`. The command carries `--session-id`, an id the runner generates, so each worker's session is known from its launch and never has to be discovered from transcript file names afterwards. So a worker is always watchable, whatever the operator's new-agent-tab setting says. As first decided, the terminal came from that setting: the runner read `mode.mode` from the start receipt and reported a worker without a terminal.

**The runner names each worker's tab.** After start it renames the worker's terminal to the agent's `[Phase] label` title, because the agent will not keep `--task-title`. The tab label is what the operator reads; the `title` field `terminal show` returns is the agent's own title and is never used to find a tab.

## Consequences

- **Every agent is a tab the operator can watch, type into and answer**, found by the title the runner gave it, in the worktree it runs in.
- **Watchability no longer depends on an operator setting.** Every worker's terminal is one the runner created.
- **Everything the worker starts with comes in on the agent's own command line, and the worker is still supervised.** `worker-start` has no permission-mode or session-id flag, and `--model`/`--effort` reach Claude, Codex and Cursor only, so a pi worker's model, effort and trust could not be passed through `--agent`. That is why the custom route was first used for a Claude worker given the orchestrator's permission mode and for every pi worker, started with `--approve` (#28). Since #45 every worker takes it, so that every worker can carry its session id. The route is Orca's documented one for custom argv: the runner creates the agent's terminal with that command, waits for its TUI to go idle, and hands the terminal to `worker-start --terminal`, which supervises it like any other worker. Orca's release retains a terminal the worker did not create, so the runner closes it after release. A Claude worker given no permission mode starts in Claude's own default mode.
- **Runs accumulate.** Each Orca-runner run leaves its Run in `run-list` after its workers are released. That is Orca's model, not a leak the runner can fix; it releases every worker it started, and the Run is an empty namespace once it has.
- **The spike's proof is re-checkable by tree as well as by pixels.** Because tabs are exposed in the accessibility tree by title, a later check that a worker's tab exists does not need a screenshot to be read by eye.

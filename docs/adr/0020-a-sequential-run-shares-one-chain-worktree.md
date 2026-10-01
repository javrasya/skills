# ADR-0020: A sequential run shares one chain worktree, and the run console resumes on r

## Status

Accepted — 2026-10-01 (spec #120). Amends ADR-0012's ownership by name, its reclaim and its keys, ADR-0015's and ADR-0016's `R`, and ADR-0017's worktrees and its `crew view`.

## Context

Every code agent of an implement-spec-in-workflow run gets a worktree of its own (ADR-0017: `<repo>.crew/<runId>-<n>`), and its setup hook runs there. On a repo whose setup is a cold dependency install and a cold build, every slice, gate fixer and publisher pays that again, and a parallel run pays it many times over at once. Some operators would rather wait for one ticket at a time than pay it, and some specs are a straight line anyway: each ticket blocked by the one before.

implement-all already works this way, with one `.worktrees/chain` kept across its ticks. The session runner had no equivalent: its host makes a worktree per agent, reclaim knows a worktree as one agent's by its `<runId>-<n>` name (ADR-0012), and a resume carries a halted agent on in the worktree it had (ADR-0016).

## Decision

**A run has a run order. In sequential order its code agents share one chain worktree, `<runId>-chain`, which belongs to the run, not to any agent.**

- **Run order.** `crew start` has a Run order row (`--run-order`), rendered into the script as `RUN_ORDER`. **Parallel**, the default, is the run as before: the whole frontier at once, an agent per worktree. **Sequential** takes one ticket at a time, the takeable one first in the spec's own map (the graph's `map_position`, which only a sequential run asks for), then the lowest number, and publishes it before the next is dispatched. The tip never moves under a ticket, so its publisher never rebases, and the script refuses a publish whose tip moved. Sequential is offered on the session runner only, on either host; the script throws if rendered sequential for the Workflow runner, which cannot point two agents at one folder. Flag-only `crew start` without `--run-order` arms parallel, never the remembered order, so a script written before the row existed runs as it did.
- **One chain worktree.** The script gives every code agent `isolation: 'chain'` in sequential order. The session host makes `<runId>-chain` (`chainWorktree`) the first time a chained call asks, from the run's base, the run worktree's HEAD, runs its setup hook then only, and the runner journals its baseline with a `chain` entry whenever the host made it. A chained call makes no worktree and starts in it. A doctor never runs there: it keeps a `<runId>-<n>` worktree of its own, setup skipped. An agent's identity stays its `<runId>-<n>`, from the call that started it, never read off the worktree its agents share.
- **The leftover check.** Before a chain agent's `agent()` returns, and so before the next one starts, the runner compares the chain's `git status --porcelain` lines with its baseline and every earlier leftover. Anything more is typed once into the agent's own session, asking it to commit or remove those files (`followUp`). It gets `followUpMs` (10 minutes) for that turn; one still busy then is stopped (`workerStop`), so it never runs beside the next agent, and its files are read as they stand. Whatever remains is journaled as `leftover` and named to every later chain agent as files never to commit, beside the setup's own. With no baseline (the host could not read one, or answered too late) the check is skipped with a warning, since an agent's files cannot be told from its setup's. A failed agent gets no follow-up.
- **Remake on resume.** A halted chained node is carried on in the chain, asked of the host afresh. If the operator reclaimed it while the run was halted, every host makes it again from the run's base, as it made the first, never from a ref an agent left it on; its setup hook runs again and a new baseline is journaled. The halted agent is told its worktree was remade, that what it left uncommitted is gone, and to switch back to its work's ref first. Crew adds the remake detached at the run's HEAD, leaving the `<runId>-chain` branch where reclaim kept it; Orca creates it with `--parent-worktree current`.
- **Reclaim leaves the chain to the whole run.** Reclaiming any of a run's agents never removes the chain. Only reclaiming the whole run, the run view's Reclaim All or the runs list's whole-run reclaim, removes it, last, and only when no agent of the run was kept and no agent the journal ran in it is live there now, reclaimed or not, since a resume may have carried a node on in a remade chain under a name already recorded reclaimed. Unpushed commits keep it unless forced, as for any worktree. Its reclaim is recorded in the run registry under `<runId>-chain`. A chain kept is named with why, and keeps the run open as a kept agent does. A worktree is the run's by its name, `<runId>-<n>` or `<runId>-chain`; any other is still the operator's own.
- **r resumes, Ctrl+R reclaims.** In the run console's runs list and a run's tree, `r` now does what `R` did (resume a halted node or run, probe a paused host, start a new runner for a dead one) and `Ctrl+R` does what `r` did (open the reclaim dialog on a tree, reclaim a whole run on the list). `R` is unbound. Reclaim removes worktrees and cannot be undone, so it takes a chord no stray keystroke sends; resume, the act a halted run waits on, takes the plain key.
- **`crew view` starts the daemon before its own checks**, as `crew run` does, so a view that refuses (no terminal, a usage error, no such run) still leaves the daemon up. Bare `crew view` became the runs list, so its daemon test could no longer use the old usage error to prove the daemon starts first. This shipped inside #121 and #122 rather than a ticket of its own; it is recorded here instead of being split out, since those tickets are published.

## Considered options

- **Reuse each agent's own worktree across tickets.** Rejected: an agent's worktree is its evidence (ADR-0012), and a worktree named for one agent but holding another's work breaks reclaim's ownership by name.
- **Rebase in the lane as parallel runs do.** Rejected: with one ticket in flight the tip cannot move, so a rebase could only hide a bug; a moved tip is refused instead.
- **Remake a reclaimed chain at the halted node's ref.** Rejected: the host's `chainWorktree` knows only the run id, and one start point for every host is simpler to keep true; the agent switches back to its ref itself.
- **Commit or drop leftovers for the agent.** Rejected: the runner cannot tell build output from forgotten work, and a file removed for an agent is lost. The agent decides once, and what stays is named.
- **Remove the chain with the last agent reclaimed.** Rejected: a halted run's next resume carries its agents on in the chain, and the operator reclaiming agents one at a time does not mean the run is over.

## Consequences

- **A sequential run is slower and cheaper**: one setup, one warm build cache, no rebases, and no two code agents in flight at once outside Explore.
- **One stray file can follow every later agent.** A leftover is never committed, but it is in every later agent's tree and prompt until the operator removes it.
- **Reclaiming a sequential run's agents frees little disk** until Reclaim All, since most of its disk is the chain.
- **Orca's chain is an ordinary child worktree** to Orca, named `<runId>-chain`; nothing Orca shows marks it as shared.

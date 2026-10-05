# Preflight audits

Six read-only audits. Each sub-agent gets the spec, the ticket list in order with bodies and edges, and **only its own section**. Every finding carries: the ticket(s) it touches, the evidence (quote, file, command output), and a tag — **fact**, **decision** for the operator, or **blocker** with a check command that shows it cleared.

## Order

Your one job is the dependency graph. For each ticket, walk its acceptance criteria as an end-to-end test would: launch, navigate, act, assert. List everything that path needs to already exist — a screen to reach it from, a logged-in session, seeded data, a schema, a config flag. Then find which ticket delivers each.

Report:

- **Missing edge** — ticket A's e2e path needs what ticket B delivers, and A is not `blocked_by` B. Example: the home page can't be verified without login, so home is blocked by login.
- **Inverted order** — B sits after A in sub-issue order but A needs it.
- **Missing ticket** — a prerequisite no ticket delivers (a test harness, a fixture, a mock server, a seed script).
- **Cycle** — any loop in the resulting graph.

Return the proposed graph: every ticket with its full blocker set, in a valid order that keeps the operator's existing order wherever no edge forces a move.

## Coverage

Compare the spec against the union of the tickets.

- **Gap** — a user story, implementation decision or testing decision in the spec that no ticket's acceptance criteria deliver. Quote the spec line.
- **Contradiction** — a ticket that says something the spec, another ticket, or an ADR contradicts. Quote both sides.
- **Overreach** — a ticket delivering what the spec puts out of scope.

## Open decisions

Read each ticket as the implementer who will pick it up with nobody to ask. List every point where they would have to choose: an unspecified behaviour, an edge case with two plausible answers, a library or pattern not named, an error path not described, a UI state not defined, a number not given (limits, timeouts, sizes), a naming choice that reaches the glossary.

For each, give the question, the plausible answers, and the one the codebase or spec leans toward, with evidence. Skip choices any competent implementer makes the same way.

## External dependencies

Find every call that leaves the process: HTTP and gRPC clients, SDKs for hosted services, databases and queues, auth and identity providers, payment, email and SMS, file or object storage, OS services, hardware, other local apps. Search the code the tickets touch **and** the code they will add, judged from the ticket bodies.

For each: where it's called, the endpoint or host it reaches today (production, sandbox, local), whether that target is configurable (env var, config file, injected client), what credentials it needs, and whether the repo already has a mock, fake, recorder or sandbox for it.

## Elevation

Find every action the app, its installer, its tests or its build performs that may need a human to approve: admin or root rights, UAC, `sudo`, keychain or credential-store access, OS privacy permissions (camera, microphone, screen recording, accessibility, files and folders), firewall or network-extension prompts, driver or service installation, code signing and notarization, certificate trust, system-wide config writes.

For each: what triggers it, on which OS, which ticket reaches it, and the smallest harmless action that would trigger the same prompt — the drill.

## Validation

Find how an implementation agent proves its work today: test runners and their per-file or per-package forms, e2e harnesses, component and visual tests, linters, formatters, type checkers, build steps, and the CI jobs that gate a PR. Read the repo's agent docs for any stated "how to validate".

Report:

- Every command, with its scope (one file, one package, everything), the CI job it mirrors, and its last known wall time if CI records one.
- Each **absent kind** (formatter, linter, type checker, unit, component, end-to-end) as its own finding, with the cheapest tool that fits the repo's language and dependency stance, so the main agent can measure its baseline.
- Every **repo gate**: a rule in the repo's docs that names what must run before a change is done, with where it is written and what it costs.
- How each tool **narrows**: changed-files mode, per-file or per-package targets, affected-test selection, test filters and tags, a single e2e spec, incremental or cached runs, parallel workers. These narrowed forms land in each ticket's `### Run per change`.
- The **broadest** suite of each kind. These land in each ticket's `### Run at review`, run once on the stack tip, never per change.
- Whether the repo can drive the app end to end today, and for a UI, which toolkit it uses and which driving tools fit it.
- Component-level test support for each surface (UI, backend, CLI): present, partial, absent.
- Any validation that needs a credential, a running service or a device.

Run nothing long; the main agent times the commands in its drill step.

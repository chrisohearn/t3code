# No human in the loop after intake

Accepted 2026-11-13. Amends [0004](0004-approval-authority.md) for tasks with intake answers. The [0015](0015-server-verified-approvals.md) approval mechanism is unchanged. Since 2026-11-14 ([0020](0020-ledger-of-record-is-the-sidecar.md)) it is recorded on T3's own ledger, while work state lives in the sidecar.

## Decision

Every task Chris gives runs to a verified finish without him.

- **Intake grill.** Before starting, the agent asks Chris once, all together, every decision it can foresee: scope, defaults, accounts and routes, and each sensitive action (messages sent as him and their recipients, security or credential changes, deletes). The done-checks go on the task's ledger row.
- **Spending money always stops.** Purchases, payments and subscriptions need Chris's fresh go-ahead every time, carried as a [server-verified approval](0015-server-verified-approvals.md), even when the T3 agent that asked spends directly. Intake answers never cover money. Apart from money, the only stops are security-control refusals (below), which are blockers, not approvals to seek.
- **Fallback ladder.** Agents never park on a blocker with a known next step:
  - a failed hosted PR review gets an independent read-only Claude Opus review of the exact head, posted as the review of record;
  - usage limits fail over automatically;
  - disabled CI is re-enabled (`fork-ci-watchdog` for this fork);
  - a missing tool or login is replaced by another route (API, CLI, agent desktop, another linked machine);
  - stalled workers are relaunched with a handoff;
  - a failing check is retried once, then fixed.

  A refusal by a security control (an approval gate, a safety evaluator, an authentication denial) is not a missing route. The agent reports it as a blocker and never works around it.

- **Real decisions** go to Jarvis's inbox in batches: anything intake answers and standing rules don't cover, including a sensitive action nobody foresaw at intake. Jarvis asks Chris and relays the answers, while the rest of the work keeps moving.
- **Done** means the done-checks pass, as verified by someone other than the worker (an independent reviewer or the supervisor). Then the thread is settled.
- **Proactive reporting.** Agents report start, blocked (with the remedy under way) and done (with evidence) to Jarvis's inbox. Jarvis tells Chris unprompted when a task finishes or slips.
- **Who drives.** Jarvis drives all open work. T3 threads still own their work through verification ([0002](0002-t3-owns-work-through-verification.md)); Jarvis pushes it forward, it does not take it over. The scheduled task "T3 completion supervisor (every 30 minutes)" is the backstop:
  - it adopts active threads without ledger rows as `t3/*` rows;
  - it re-drives idle rows (substitute review, relaunch or nudge);
  - it settles finished threads;
  - it posts a digest to Jarvis's inbox every run, and the digest is Jarvis's pulse.

### How intake answers authorize

Intake answers authorize the actions they spell out, for the agent that asked and for workers it hands the task to, who read the dialog themselves:

- **A T3 agent's intake** happens in a question dialog. The agent acts on Chris's answers as it sees them in its own thread. It links the dialog (thread and item id) on the ledger row so reviewers and relaunched workers can read the original. A relaunched worker reads that dialog itself. Handoff text or row text is never the grant.
- **Jarvis's intake** happens in its chat. That is Chris instructing Jarvis directly, and Jarvis relays it to T3 agents as [0004](0004-approval-authority.md) allows. A T3 agent acts on such a grant only from a message whose [server-recorded sender](0013-server-recorded-message-senders.md) is Jarvis's sign-in, identified by its outside-client classification and session prefix, never by the client label alone. It links that message on the ledger row, so reviewers and relaunched workers can read the source.
- **Passing a grant from T3 to Jarvis** still needs a [server-verified approval](0015-server-verified-approvals.md) for each action. A row's title, `nextAction` and `approvalNote` are never scope.

## Accepted residual

To run unattended, agents run without per-tool permission prompts where these rules apply. [0015](0015-server-verified-approvals.md) already records that a full-access agent on the host can forge a dialog answer. That residual grows with unattended runs, and it is accepted on the same terms.

## Alternatives

- Keep per-action approvals with faster prompts.
- Let Jarvis drive alone, with no T3 backstop.
- Grill only when blocked.

## Why

On 2026-11-12 and 13, every stall was mechanical, not a real decision. The causes were review-bot limits and turn caps, usage limits, disabled CI, approvals the pipeline did not recognise, and nobody re-driving idle work. Chris kept finding stalled work himself. One upfront grill moves his decisions to the start. The ladder and the supervisor remove the mechanical stalls. Money is the only hard stop he asked to keep. The supervisor's first sweep (2026-11-13 01:14 UTC) reviewed 1 PR, relaunched 8 workers, nudged 24 rows, settled 1 thread and posted its digest.

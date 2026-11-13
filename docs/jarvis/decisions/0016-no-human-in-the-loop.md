# No human in the loop after intake

Accepted 2026-11-13. Amends [0004](0004-approval-authority.md) for tasks with intake answers.

## Decision

Every task Chris gives runs to a verified finish without him.

- **Intake grill.** Before starting, the agent asks Chris once, all together, every decision it can foresee: scope, defaults, accounts and routes, and each sensitive action (messages sent as him and their recipients, security or credential changes, deletes). Jarvis asks in its chat; T3 agents use a question dialog. The answers and verifiable done-checks go on the task's ledger row. For that task they are the explicit authorization, in place of per-action approval rules. Without an intake grant, those rules apply as written.
- **Only spending money stops.** Purchases, payments and subscriptions need Chris's fresh go-ahead every time. A [server-verified approval](0015-server-verified-approvals.md) remains the way to carry one.
- **Fallback ladder.** Agents never park on a blocker with a known next step:
  - a failed hosted PR review gets an independent read-only Claude Opus review of the exact head, posted as the review of record;
  - usage limits fail over automatically;
  - disabled CI is re-enabled (`fork-ci-watchdog` for this fork);
  - a missing route is replaced by another (API, CLI, agent desktop, another linked machine);
  - stalled workers are relaunched with a handoff;
  - a failing check is retried once, then fixed.
- **Real decisions** that intake answers and standing rules don't cover are batched to Jarvis's inbox. Jarvis asks Chris and relays the answers, while the rest of the work keeps moving.
- **Done** means the done-checks pass, as verified by someone other than the worker (an independent reviewer or the supervisor). Then the thread is settled.
- **Proactive reporting.** Agents report start, blocked (with the remedy under way) and done (with evidence) to Jarvis's inbox. Jarvis tells Chris unprompted when a task finishes or slips.
- **Who drives.** Jarvis drives all open work. The scheduled task "T3 completion supervisor (every 30 minutes)" is the backstop. It adopts active threads without ledger rows as `t3/*` rows. It re-drives idle rows (substitute review, relaunch or nudge), settles finished threads and posts a digest to Jarvis's inbox every run. The digest is Jarvis's pulse.

The rules live in the global agent instructions on Omarchy, the MacBook Pro and REVO-VM-008, and in Jarvis's custom instructions (v6). Claude Code runs with `bypassPermissions` and Codex with `approval_policy = "never"` on Omarchy and the Pro. The Windows VM's permission settings wait for a working agent there, because Aorka refuses to disable safety settings remotely.

## Alternatives

- Keep per-action approvals with faster prompts.
- Let Jarvis alone drive, with no T3 backstop.
- Grill only when blocked.

## Why

On 2026-11-12 and 13 every stall was mechanical, not a real decision. The causes were review-bot limits and turn caps, usage limits, disabled CI, approvals the pipeline did not recognise, and nobody re-driving idle work. Chris kept finding stalled work himself. One upfront grill moves his decisions to the start. The ladder and the supervisor remove the mechanical stalls, and money is the only hard stop he asked to keep. The supervisor's first sweep (01:14 UTC) reviewed 1 PR, relaunched 8 workers, nudged 24 rows, settled 1 thread and posted its digest.

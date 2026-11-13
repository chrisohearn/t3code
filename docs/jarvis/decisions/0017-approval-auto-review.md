# Opt-in runtime approval review

## Decision

A thread may delegate individual runtime approvals to an isolated model call.
The configured reviewer receives a fixed policy, the pending request and up to
twelve recent user/assistant messages from its run, including recorded authorship.
It can allow once, decline once, or escalate. It cannot grant session-wide access,
raise a runtime mode, answer a question, or act through tools. Missing context,
oversized evidence, unsupported reviewers and errors leave the request pending.
Only direct web/mobile messages recorded as user-created, without an MCP sender
or sender thread, are marked as authority. A `user` role alone is insufficient:
agent, relay and unattributed messages provide context, not new grants. Text
addressing the reviewer is grounds to escalate. Replies must be one complete
JSON object; prose, fences or multiple objects fail closed.

This narrows the unattended execution residual in
[0016](0016-no-human-in-the-loop.md): a primary agent can remain
approval-required instead of running full-access. It is not an authenticated
owner or an alternative to [0015](0015-server-verified-approvals.md).
Human questions, including user-input-shaped approvals and ledger dialogs, always
remain on the human/Jarvis path. No reviewer result supplies `approvedBy: user`
or a server-verified ledger approval. Those checks are unchanged.

The default is off. A full-access MCP caller can set a thread's `autoReview`
selection through `t3_thread_configure`; null disables it even when the server
default is enabled, and `inherit` restores inheritance. The server setting
`approvalAutoReview` is null or a model selection. Enabling this delegates actual
execution authority and consumes the selected model's allowance; an API-backed
reviewer may incur charges. It is not a way around an existing denial.

## Codex and isolation

Codex natively offers `approvals_reviewer = "auto_review"`; T3's existing Auto
runtime mode already uses it. That mode does not expose T3's selected reviewer
model, money precheck or approval-log attribution. It remains unchanged. This
feature reviews requests emitted to T3, including approval-required Codex threads,
using the same path as other primary providers.

Reviewer selections support Codex, Claude and configured text generators. CLI
reviewers run outside the checkout with tools disabled, no MCP tools and no
permission bypass. Failed Codex MCP discovery or a Claude managed MCP config that
prevents isolation escalates. Other reviewer drivers are unsupported and escalate.
There is no fallback to another account or model without changing configuration.
Each CLI review gets a temporary auth-only home. Codex receives a new `CODEX_HOME`
and `HOME` without `AGENTS.md`, `config.toml` or user skills in `.agents/skills`,
with project instructions disabled; only
`auth.json` is copied for an unmanaged sign-in. Managed instances retain their
server-owned token helper. Custom unmanaged launch settings are refused.
Claude receives a new `CLAUDE_CONFIG_DIR` containing only a copied credentials
file, if present, and empty `--setting-sources`. Its existing environment and
keychain access remain available; instruction/settings files are not copied.
Temporary homes are private and removed on completion, failure or interruption.

## Spending heuristic and residual risk

Before calling a model, T3 normalizes only the request, not conversation context,
with NFKC, splits
snake-case, dotted, hyphenated and camelCase identifiers, and checks for purchase,
payment, booking, order, checkout, charge, billing, invoice, subscription, renewal,
spending, donation, transfer, wire, payout, sponsor, price, fee and refund language,
cart/add-to-cart, sending money, repayment, prepayment, autopay, rebooking,
deposits, tips, credit cards, common currency codes, Bitcoin/crypto and currency symbols.
Stripe, PayPal, Square, LetsFG, Shopify and QuickBooks server prefixes escalate
regardless of their tool's action. Non-ASCII letters anywhere in an approval
item also escalate, including tool names and commands. A match escalates even when the
requested decision would be decline. The model policy separately requires
escalation for money, hidden commands and uncertainty.

This deliberately overmatches: shell dollar signs and payment-related code can
require human review. Conversation-only mentions do not trigger this heuristic.
It cannot prove
that arbitrary code has no financial effects, recognize every language or decode
concealed intent. Auto-review is a delegated judgment aid, not a financial sandbox.
Every actual money go-ahead still requires the fresh owner approval in 0015/0016.

## Failure and audit

A durable claim admits one attempt per request, including across restart. A crash
after claiming leaves it for the existing human path rather than retrying a model
decision. Reviews time out after sixty seconds. Changed context, configuration,
request details, deletion or archival stop application; an already-answered
request cannot be answered twice. Approve/decline and their model/reason metadata
commit together through the existing orchestrator. Escalations are recorded as
non-answers in the same log; `t3_approval_log` distinguishes them by decision.
Escalations retain the request kind and sanitized prompt. Stored reasons are
credential-redacted and capped at 2,000 characters, including error causes that
distinguish timeouts and parse failures. The event subscription uses the existing
live-stream budget of 1,000 items and 8 MiB. Overflow or an unexpected stream end
logs a warning and resubscribes after one second from the last fully processed
sequence. Durable claims prevent a second model attempt; an interrupted review
stays on the human path. `bridge_status.autoReview` latches a degraded status,
failure count and sanitized last cause until server restart, even after recovery,
so an enabled but interrupted worker cannot look healthy. No unbounded event
buffer is retained.
The short check-to-dispatch interval is not a transaction with settings changes;
disabling review is not a rollback of an action already dispatched.

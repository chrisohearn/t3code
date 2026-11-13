# Opt-in runtime approval review

## Decision

A thread may delegate individual runtime approvals to an isolated model call.
The configured reviewer receives a fixed policy, the pending request and up to
twelve recent user/assistant messages from its run, including recorded authorship.
It can allow once, decline once, or escalate. It cannot grant session-wide access,
raise a runtime mode, answer a question, or act through tools. Missing context,
oversized evidence, unsupported reviewers and errors leave the request pending.

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

## Spending heuristic and residual risk

Before calling a model, T3 normalizes the request and context with NFKC and checks
for purchase/payment/checkout/charge/billing/invoice/subscription/renewal/spending/
donation/transfer language, credit cards, Stripe/PayPal, common currency codes,
Bitcoin/crypto and currency symbols. A match always escalates, even when the
requested decision would be decline. The model policy separately requires
escalation for money, hidden commands and uncertainty.

This deliberately overmatches: shell dollar signs, payment-related code and a
prior discussion of subscriptions can all require human review. It cannot prove
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
The short check-to-dispatch interval is not a transaction with settings changes;
disabling review is not a rollback of an action already dispatched.

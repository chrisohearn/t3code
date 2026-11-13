# Outside agents

Agents that T3 Code did not start can work with an environment through its MCP
server. They can read projects and threads, start and message threads, and
check which providers and models are available. This covers Claude Code or
Codex in your own terminal, ChatGPT, and bots that support MCP. Each agent signs
in once, and you choose what it may do.

## Add T3 Code to an assistant app

Open the command palette (`Cmd/Ctrl+K`) and choose **Use T3 Code in another
app (MCP)**, or use the button in **Settings → Sharing & access**. Pick the
app and follow the step for that app. Assistants like
Poke and Claude run in the cloud, so the wizard first asks you to sign in to T3
Connect and turn it on for the environment. To reach your other machines through
the same connection, turn on **Linked environments** in Labs and
[link them](./remote-access.md#link-another-environment).

When the app opens the sign-in page, choose what it may do and approve with your
T3 Connect account. On an older environment, the wizard asks for the level and
gives you a code to paste instead. A code works once, for 5 minutes, and
approves only that level.

For an app that is not listed, choose **Something else…**, add a remote MCP
server with OAuth in that app, and paste the URL. Apps that require their own
client ID cannot connect.

## Get the MCP URL

In **Settings → Environments**, open a saved environment's menu and choose
**Copy MCP URL**. The URL is the environment's address followed by `/mcp`, for
example:

```text
https://<environment-address>/mcp
```

When T3 Connect serves the environment, the copied URL is its T3 Connect
address, which agents can reach from anywhere. Otherwise it uses the route this
device is connected over, so an agent on the same device can reach it.

- **An agent on your own computers** can use `localhost` on the host, T3
  Connect, or any `https` address, such as
  [Tailscale HTTPS](./remote-access.md#tailscale-https). Signing in sends the
  agent's credentials to the environment, and agents only do that over `https`
  or to `localhost`. A plain-`http` LAN or Tailscale address, like
  `http://100.x.y.z:3773`, lets an agent find the environment but not finish
  signing in.
- **A hosted agent**, such as ChatGPT or a bot running in the cloud, must reach
  the environment from the internet. Use the T3 Connect address. A Tailscale
  address only works from your own tailnet.

## Approve a sign-in

The first time an agent connects, it opens a sign-in page. When the agent
reaches the environment through T3 Connect, the page opens on the T3 Code web
app: sign in with the T3 Connect account the environment is linked to and
approve there, without a code. Otherwise the page opens on the environment.
Either page names the agent and where its access goes:

- For an agent on your computer, approval returns to a `localhost` address on
  the computer that opened the page.
- For a hosted agent, approval goes to that service, such as `chatgpt.com`.
  Anyone who runs that service gets the access.

Only approve a sign-in you just started. On the environment's own page, enter a
code from **Use T3 Code in another app (MCP)**, **Settings → Sharing & access**,
or `t3 auth pairing create` on the host. A browser already signed in to the
environment with permission to manage access can approve without a code. On the
web app, **Use a sign-in code instead** opens the environment's own page.

A code from **Use T3 Code in another app (MCP)** already carries the level you
picked there. With another code, choose what the agent may do here: **Auto** is
selected by default, or the closest lower mode allowed by your organization’s
policy. Approving without a code starts at **Read only**:

- **Read only** lets the agent read projects and threads and see
  the available providers and models. It cannot change projects or threads.
- **Supervised** through **Full access** also let it start, message and stop
  threads in every project. A thread it starts or steers cannot run with more
  permissions than the mode you chose.

## What outside agents can call

Some tools only work for an agent running inside a T3 thread, because they act
as that thread: subagents, secret requests, rendered HTML, the browser preview,
devices, and worktree handoff. They still appear in an outside agent's tool
list, but calling one returns an error saying it needs an agent running inside
T3 Code.

- To hand off work, start a thread with `t3_thread_launch`, then follow it with
  `t3_thread_wait` or `t3_thread_read`, instead of `create_threads` or
  `delegate_task`.
- Tools that default to the caller's own project or thread need an explicit
  `projectId` or `threadId`.
- To list threads across projects, call `t3_thread_list` with
  `allProjects: true`, or use `t3_thread_search`.
- To reduce a stopped thread's permissions, call `t3_thread_configure` with
  `runtimeMode` alone. It cannot raise permissions or change them during an active
  run, and the thread must be within the calling agent's permission limits. The
  change and caller appear in thread activity.
- To change a busy thread's model or options, such as an inbox thread's effort,
  call `t3_thread_configure` with `modelSelection` and `applyAt: "next_turn"`.
  Messages already queued start with it, and so do later agent messages. A
  later message sent from the T3 app carries the composer's model instead.
  Reading the configuration shows the pending change; scheduling the current
  model cancels it. Switching to another provider instance still needs an idle
  thread.
- When `t3_thread_send` queues behind a busy run, its `queue` result gives the
  message's position, the messages ahead of it, and how long the active run has
  been going.
- A snoozed thread stays snoozed. `t3_thread_send` holds the message until the
  snooze ends or someone wakes the thread, and `t3_thread_post` only records it.
  Both return `snoozedUntil` and a warning. Pass `respectSnooze: false` to wake
  the thread now. Messages sent from the T3 app still wake it.

## Claude Code

```sh
claude mcp add --transport http t3 https://<environment-address>/mcp
claude mcp login t3
```

`claude mcp login` opens the sign-in page in your browser. On a machine
without a browser, add `--no-browser`, open the printed URL elsewhere, and
paste the final URL back when asked. `claude mcp list` shows `t3` as connected
once you approve.

## Codex

```sh
codex mcp add t3 --url https://<environment-address>/mcp
codex mcp login t3
```

`codex mcp login --no-browser` prints the sign-in URL instead of opening it.
`codex mcp list` shows `t3` with OAuth once you approve.

## ChatGPT

Add the environment as a custom MCP app in ChatGPT's apps settings:

1. Create a new app or plugin with a custom MCP server.
2. Set the server URL to `https://<environment-address>/mcp`, using the T3
   Connect address.
3. Choose **OAuth** for authentication. ChatGPT discovers the rest; you do not
   need a client ID or secret.
4. Create the app, then approve the sign-in page that opens.

### Check results and decisions

Use `t3_thread_result` for a thread's latest run, or pass `runId` for a specific
run. `threadId` also accepts a thread link, including the hosted links T3 returns. It returns status, the last assistant reply, pending request IDs, linked
pull requests, and a revision. `latestMessage` also returns the thread’s most recent
message, including inbox posts without a run. Replies default to 4,000 characters. Increase
`maxChars` up to 50,000 when `truncated` is true. This read does not acknowledge
a delegated child's result.

Messages sent or posted by signed-in MCP clients include `senderClient`: the
client label, the first eight characters of the sign-in session ID, its access
tier, and whether it is an outside client or a linked T3 agent. The server records these fields;
message text and tool arguments cannot supply them. Local T3 agents retain their
`senderThreadId`. Older messages may have no sender record.

For history, use `t3_thread_read`. Save its `revision` and pass it as
`sinceRevision` on the next read. An unchanged thread returns an empty first
page; reads with `afterPosition` or `itemId` still return items.
`t3_pending_request` lists questions and approvals with a `kind` field. Read an
approval by its `requestId` before answering. An outside sign-in approved for
**Full access** can answer on any thread with `action: "respond"` and
`decision: "accept"` to allow once, or `decision: "decline"` to deny. Other
sign-ins and agents running inside T3 threads cannot answer approvals over MCP.
Standing grants and permission-mode changes stay in the app. Answer through a direct
Full-access sign-in to the server that owns the thread. Forwarded answers are refused;
a link to another environment does not authorize an answer there. Each target server
needs a fork release that supports MCP approval answers.

Every answer records the session, client label, thread, request, requested action,
decision, and time. An optional `note` records the caller's statement of what the
user said. The thread timeline identifies the MCP client that answered. A
full-access caller can read the records with `t3_approval_log`; use `threadId`
to filter and `cursor` and `limit` to page through them. The log also records refused
forwarded attempts, including the attempted decision and any origin attested by the
authenticated link. A refusal leaves the approval pending so a direct sign-in can
answer it.

`t3_thread_list` includes `launchedBy` and `pendingRequestCount`. Pass
`launchedByMe: true` to find threads launched through this sign-in session.
Token refresh keeps this sign-in's launch history and event subscriptions.
After signing in again, the new session has a separate launch history. The
filter works on the environment you signed in to, not through a linked one.

`t3_thread_wait` returns when a run ends, asks a question, or raises an
approval during the wait. An approval that was already pending does not end a
new wait. Use `t3_pending_request` to inspect existing pending approvals.
Pass either `threadId` or `threadIds` to wait for the first ready thread.
A specific `runId` works with a single thread. Prefer event notifications for
ongoing monitoring.

### Track work across agents

Use `ledger_upsert` with a stable `key` to create or update a work item. New
items need `title`, `ownerKind` (`jarvis`, `vision`, `t3`, or `human`), and
`ownerName`. Later calls can update individual fields. Omit a field to keep it,
or pass `null` to clear a nullable field. Read-only sign-ins can query the
ledger. Writing requires operate access and also works for agents inside T3.

Use `status` to track `open`, `blocked`, `waiting_on_human`, `done`, or
`cancelled` work. Record a blocker, next action, approval context, links, and an
optional owning thread. An `approvalNote` records context and grants no approval.
Set `waitReason` to `external`, `natural`, or `decision` to distinguish a dependency,
a real-world event, and a question for Chris. Use `nextCheckAt` for the next due check.

To record your approval on an item, an agent asks you in a question dialog that
says what it will do and has `Ledger key: <key>` on a line of its own. It then passes
`approval: { source: { threadId, itemId, questionId? } }` naming that dialog. T3
checks that you answered it from one of your paired devices in the last day, and
stores a quote of the question and your answer with the item. An approval is used
once: marking the item done or cancelled retires it, and so does changing the
item's title, next action, owner, blocker, links or approval note, or
`approval: null`.

`ledger_query` filters by `status`, `ownerKind`, `ownerName`, `waitReason`, `due`,
`approved`, or `updatedSince` (inclusive). It returns up to 25 rows by default, ordered by key.
Pass `nextCursor` as `cursor` for the next page, or set `limit` up to 100.
Read an item's changes with `ledger_history`, or check open work and its owners'
latest activity with `portfolio_status`. A due check or a completed agent run does
not mark the work done.

Open **Settings → Work ledger** and choose an environment to read its items or
open an owner's thread. The panel is read-only. Owner threads belong to the
selected environment; references to other environments remain links.

Use `bridge_status` to check this sign-in's remaining lifetime, subscription
state, tunnel reachability, service start time, last successful webhook delivery,
and exhausted retries. Tool call,
error, and response byte counters reset when the server restarts. Delivery
counters survive restarts. Callback secrets are never returned.

### Monitor thread updates

Clients that support MCP Events can monitor a specific thread for run results,
pending decisions, failures, and provider resource release. Ask the client what
to monitor after approving its OAuth sign-in. Read-only access is sufficient.

Notifications contain identifiers, native status, and a link to the source thread.
Read that thread for the full result or decision. A finished run or helper does
not establish that the requested work has been accepted.

Subscriptions last one day by default. Each acknowledged delivery renews an explicit
subscription for its granted lifetime, up to the current sign-in expiry. Failed
deliveries do not extend it. A quiet subscription still expires, so an inbox that
must stay available needs activity before its lifetime ends. Client refreshes and
signing-secret rotation remain supported. Existing watches adopt rolling renewal;
legacy notify-only watches retain their existing grants. New `notify` calls use inbox relays. Updates
can replay after a server restart, although older history may no longer be
available. When T3 Connect is enabled, T3 holds startup notifications until its
public address is reachable, for up to three minutes, so clients can call back. Delivery stops after eight failed attempts or a permanent callback
failure. Once the callback is working again, explicitly resubscribe to reactivate
delivery from the acknowledged cursor. Refreshing an active subscription does not
reset its retry budget. After signing in again, subscribe through the new connection
to resume monitoring. Explicitly stopping monitoring removes its delivery backlog. A later cursorless
subscription starts at current events; provide a saved cursor to request replay. A plain
subscription made after a run ends does not replay that run's completion event.
Check the thread once after subscribing to catch a result that arrived earlier.

To receive notifications for a launch or send, first pin a writable inbox thread
with `event_inbox_set: { threadId: "<thread-id>" }`. Then include `notify: {}` in
`t3_thread_launch` or `t3_thread_send`. T3 queues a message to that inbox when the
source run produces a matching event. This creates no event subscription or
ChatGPT watch. Your existing inbox watch receives the inbox run's normal event.
Keep the inbox's run-per-message acknowledger enabled.

The response reports `bound` with the inbox thread id, or `unavailable` or `failed`
with a reason. Without a pin it reports `no_pinned_inbox`; the launch or send still
succeeds. Clear the pin with `event_inbox_set: { threadId: null }`. A pin belongs to
one sign-in. A changed or cleared pin prevents pending deliveries to the old inbox.

The default events are `thread.run.result`, `thread.needs-decision`, and
`thread.blocker`; `notify.events` chooses a subset. Each source run outcome
produces at most one inbox message. Messages include the source thread, run,
request key, a bounded result excerpt, and PR links. Relay messages cannot relay
their own inbox run. Read the source thread if setup or delivery fails.

`event_subscriptions` lists your inbox pin, native subscription ids, threads,
events, expiry, and callback groups. `notifyDerived` identifies legacy notify
copies using creation order within each callback group. Remove a duplicate with
`event_unsubscribe` and its native id; repeating a removal is safe.
`bridge_status.watches` groups active subscriptions by callback and reports each
watch's soonest expiry. `inboxThreadId`, `relayFailures`, `relayPending`, and
`relayLastError` show relay state separately from webhook acknowledgements.
Callback paths, queries, and secrets stay private.

Exhausted webhook deliveries produce one inbox alert per subscription per day.
Exhausted relay jobs also produce a daily inbox alert; alert failures do not create
more alerts. Dispatch rechecks the sign-in, inbox, and permission limits. Revoked
or insufficient authority stops delivery. Use `event_deliveries_replay` with a
subscription id to copy up to 256 exhausted webhook deliveries into your pinned
inbox. Repeating the call continues with remaining events and does not duplicate
already queued messages. It does not reactivate the original callback.

For direct protocol clients, the T3 extension `events/subscriptions/list` lists
this sign-in's subscriptions: event/thread, active/stopped/expired status, expiry,
acknowledged cursor and callback **origin**. It never returns signing secrets or
callback paths/queries. Revoke one with `events/unsubscribe` and `{ "id": "<subscription-id>" }`;
the standard name/arguments/delivery form also works. Other sign-ins cannot list or
revoke these subscriptions. Each sign-in can retain up to 512 subscriptions, with
4096 total on the server; stopped subscriptions count until explicitly removed.
Transport state belonging to expired or revoked sign-ins is reclaimed when new
subscriptions are saved. A new sign-in still needs an explicit subscription and a
saved consumed cursor to replay; subscriptions never transfer between sign-ins.

Callback verification fails fast when busy: up to 16 challenges per sign-in and
64 globally can be pending. Each sign-in can attempt 512 challenges per minute,
with 2048 globally. Failed challenges count too; retry later using the same
subscription inputs. These limits apply to callback verification, not T3 threads
or model execution. Callback addresses belonging to the server itself are refused.

Ask the client to stop monitoring, or revoke its sign-in in
**Settings → Sharing & access** to stop all of that connection's subscriptions.

## Other agents and bots

Any agent that supports remote MCP servers over HTTP with OAuth can connect. Give
it the MCP URL and choose OAuth, and the agent finds the sign-in settings itself.
Agents without OAuth support cannot connect.

## Scripts on the host

On the machine that runs the environment, `t3 thread` uses the same tools
without a sign-in:

```sh
id=$(t3 thread start . "Find why the tests are slow")
t3 thread send "$id" "Now fix it" --wait
t3 thread show "$id"
t3 thread list
```

`.` means the project that contains the current folder, or a git worktree of
its repository; a project id also works. A new thread uses the project's
default model and permission mode, and runs in the project folder unless you
pass `--worktree <base-branch>`. `send` never interrupts: a busy thread gets
the message as its next turn. Pass `-` as the message to read it from stdin.

`--wait` prints the agent's reply. It exits 1 when the run fails or stops, and
2 when the agent waits for an answer you give in the app. Add `--json` for a
result that always includes the thread id.

## Remove an agent

Approved agents appear under **Settings → Sharing & access** like other clients.
Revoke one there to cut off its access immediately. New sign-ins renew with use
and expire after 30 days without use. Clients receive a renewal token, which is
replaced each time they use it. Duplicate renewal requests within 90 seconds return
the same replacement tokens while the replacement is still current, including after
a server restart. This window starts
at the first renewal and retries do not extend it. Reusing a replaced token after
that window cuts off the sign-in.
Sign-ins created before rolling renewal keep their original expiry.

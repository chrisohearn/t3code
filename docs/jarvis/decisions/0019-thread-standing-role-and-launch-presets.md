# Thread standing role and launch presets

Accepted 2026-11-13.

## Decision

- **A thread carries a standing role** of up to 4,000 characters. T3 sends it ahead of the user's text, not only when a session starts: with the first turn, after a change, in a new native session, after a compaction, and every 25 runs in case the provider compacted it away itself. Set it with `t3_thread_configure` (`standingRole`, alone; empty text clears), with `t3_thread_launch` or `delegate_task`, or through a preset. `t3_thread_configure` and the first page of `t3_thread_read` show it, with who set it and when.
- **Changing a role needs full access.** A role is instructions for another agent, and for an agent's own thread a way to drop its own rules. Setting or clearing one through `t3_thread_configure` posts a note in the thread naming the setter, with the sender record of [0013](0013-server-recorded-message-senders.md), and the role keeps its setter as the first 8 characters of a session and its label, or a thread id. A launch or delegation sets the role of the thread it creates, within the caller's own modes.
- **Launch presets** are named, server-side bundles of model, runtime mode, standing role, checkout kind (`root` or `worktree`) and an optional done-message format. `t3_preset` lists, reads, saves and deletes them. `t3_thread_launch` and `delegate_task` take `preset: "<name>"`. Explicit fields override the preset.
- **The done format is stored text.** It is appended to the role as "Your final message must follow this format:". T3 does not check the reply.
- **A preset never raises authority.** Its runtime mode is held to the caller's own mode like an explicit one, and is refused when above it. Saving or deleting one needs full access, because a thread with broader modes later starts with its text, which `t3_thread_send` would refuse a narrower caller. Listing and reading are open.
- **Presets are named by the environment that runs the thread.** A launch or delegation to a linked environment forwards the name, and that environment resolves it; `t3_preset` has no `environmentId`, so a remote preset is made there. A linked build that predates this change ignores `preset` and `standingRole`. A preset's model then does not apply to `delegate_task` there (name `target.model`), and its checkout kind never applies: a remote task runs in that project's checkout. A local `delegate_task` maps a `worktree` preset to `isolation: "worktree"`, branching from the parent's commit, not the preset's `baseRef`.

## Why

On 2026-11-13 the Jarvis inbox thread's Codex agent ignored its role file for hours. Providers read `AGENTS.md` only when a session starts, and the file was written after the session began. In the same round the coordinator pasted the same rules into nine worker briefs, and one worker woke snoozed threads because its brief lacked a rule. A role that T3 sends each turn cannot be missed by a running session, and a preset keeps a rule set in one place.

## Constraints

- **Inline prefix, not a provider field.** The turn input has no per-turn instruction field for every provider. `appContext` reaches only Codex, and Claude takes a system prompt only at session start. The role is a prefix on the user text, like the restart note and side-chat context in `ProviderTurnStartService`. A 4,000-character role is about 1,000 tokens, and each copy stays in the session history, so it is sent only when due. Delivery is recorded after the provider accepts the turn; the table keeps the revision, native session and run it reached. Native commands (`/compact`, `/review`, `/goal`) go without it and are not counted as delivery.
- **Stored outside thread events.** The role and presets live in fork tables (`thread_standing_roles`, `launch_presets`), read at each turn start. Changing a role takes effect on the next turn, and a deleted thread loses its role. A launch or delegation that fails before its thread exists removes the role it stored; one that fails after keeps it.
- **Stored before the thread starts.** A launch or delegation writes the role first, under the thread id it derives, because the first turn begins when the command commits.
- **Not the handoff's `standingItemId`.** That names the first user message in a provider-switch handoff. It is unrelated and unchanged.
- **Context budget.** `t3_preset` and three optional fields grow the advertised tool list by about 1 KB. The preset tool checks `modelSelection` on save instead of advertising its full schema.

## Alternatives

- Write the role into `AGENTS.md` and restart sessions. It still depends on a restart.
- Add the role to thread events and projections. That edits upstream-owned tables and the wire contract for a fork-only need.
- Check the done message against its format. It adds machinery; a reviewer already checks it.

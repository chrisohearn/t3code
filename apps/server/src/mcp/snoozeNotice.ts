import * as DateTime from "effect/DateTime";

export type SnoozeOutcome = "held" | "posted" | "steered" | "delivered" | "woke";

/** What a sender learns about a target's snooze; nothing when the thread was awake. */
export function snoozeNotice(
  snoozedUntil: DateTime.Utc | null | undefined,
  nowMs: number,
  outcome: SnoozeOutcome,
): { readonly snoozedUntil: string; readonly warning: string } | Record<string, never> {
  if (snoozedUntil == null || DateTime.toEpochMillis(snoozedUntil) <= nowMs) return {};
  const until = DateTime.formatIso(snoozedUntil);
  const prefix = `Thread is snoozed until ${until}.`;
  const warning = {
    held: `${prefix} The message waits, held, until it wakes. Pass respectSnooze: false to wake it now.`,
    posted: `${prefix} The message was recorded and the thread stays snoozed.`,
    steered: `${prefix} The message joined its running turn, and the thread stays snoozed.`,
    delivered: `${prefix} It counts as awake for now (it never ran, or a request, guest message or error woke it), so the message went ahead as usual: started or queued. The snooze stays.`,
    woke: `${prefix} This message ended the snooze.`,
  }[outcome];
  return { snoozedUntil: until, warning };
}

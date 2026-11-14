import { ModelSelection, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerSettings from "../serverSettings.ts";

export const AutoReviewOverride = Schema.Union([
  Schema.Literal("inherit"),
  Schema.Null,
  ModelSelection,
]);
const storedSelection = Schema.fromJsonString(Schema.NullOr(ModelSelection));
const decodeSelection = Schema.decodeEffect(storedSelection);
const encodeSelection = Schema.encodeEffect(storedSelection);

export const read = Effect.fn("ApprovalAutoReviewConfig.read")(function* (threadId: ThreadId) {
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* ServerSettings.ServerSettingsService;
  const rows = yield* sql<{ selection_json: string }>`SELECT selection_json
    FROM thread_approval_auto_review WHERE thread_id = ${threadId}`;
  const override =
    rows[0] === undefined ? ("inherit" as const) : yield* decodeSelection(rows[0].selection_json);
  const effective =
    override === "inherit" ? (yield* settings.getSettings).approvalAutoReview : override;
  return { override, effective };
});

export const write = Effect.fn("ApprovalAutoReviewConfig.write")(function* (
  threadId: ThreadId,
  override: typeof AutoReviewOverride.Type,
) {
  const sql = yield* SqlClient.SqlClient;
  if (override === "inherit") {
    yield* sql`DELETE FROM thread_approval_auto_review WHERE thread_id = ${threadId}`;
  } else {
    const json = yield* encodeSelection(override);
    yield* sql`INSERT INTO thread_approval_auto_review (thread_id, selection_json)
      VALUES (${threadId}, ${json}) ON CONFLICT (thread_id)
      DO UPDATE SET selection_json = excluded.selection_json`;
  }
  return yield* read(threadId);
});

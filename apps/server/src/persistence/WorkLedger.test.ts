import { ThreadId, TurnItemId, WorkLedgerUpsertInput } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import LedgerMigration from "./ForkMigrations/010_WorkLedgerPortfolio.ts";
import BaseLedgerMigration from "./ForkMigrations/002_WorkLedger.ts";
import * as TestClock from "effect/testing/TestClock";
import * as Sqlite from "./Sqlite.ts";
import * as WorkLedger from "./WorkLedger.ts";

const decodeUpsert = Schema.decodeUnknownSync(WorkLedgerUpsertInput);

it.effect(
  "upserts by stable key, preserves omitted fields, clears values and pages filtered rows",
  () =>
    Effect.gen(function* () {
      const ledger = yield* WorkLedger.WorkLedger;
      yield* TestClock.setTime(0);
      expect((yield* ledger.upsert({ key: "missing" }, "session-a").pipe(Effect.flip)).code).toBe(
        "invalid_request",
      );
      const first = yield* ledger.upsert(
        {
          key: "a",
          title: "Ship batch",
          ownerKind: "jarvis",
          ownerName: "chief",
          blocker: "CI",
          links: ["https://example.com/pr/1"],
        },
        "session-a",
      );
      yield* TestClock.setTime(1000);
      const { warnings, ...updated } = yield* ledger.upsert(
        { key: "a", status: "done", blocker: null },
        "thread-b",
      );
      expect(warnings).toEqual([]);
      expect(updated).toMatchObject({
        title: first.title,
        ownerKind: first.ownerKind,
        ownerName: first.ownerName,
        status: "done",
        blocker: null,
        links: first.links,
        createdAt: first.createdAt,
        updatedBy: "thread-b",
      });
      expect(updated.updatedAt).not.toBe(first.updatedAt);
      yield* ledger.upsert({ key: "a", ownerThreadId: ThreadId.make("coordinator") }, "session-a");
      expect(yield* ledger.forThread("coordinator")).toEqual([]);
      yield* ledger.upsert({ key: "a", status: "open" }, "session-a");
      expect((yield* ledger.forThread("coordinator")).map((row) => row.key)).toEqual(["a"]);
      expect(yield* ledger.forThread("other")).toEqual([]);
      yield* ledger.upsert({ key: "a", status: "done", ownerThreadId: null }, "thread-b");
      yield* ledger.upsert(
        { key: "b", title: "Other", ownerKind: "human", ownerName: "Chris" },
        "session-b",
      );
      const page = yield* ledger.query({ limit: 1 });
      expect(page.items.map((item) => item.key)).toEqual(["a"]);
      expect(page.nextCursor).toBe("a");
      expect(
        (yield* ledger.query({ cursor: page.nextCursor!, limit: 1 })).items.map((item) => item.key),
      ).toEqual(["b"]);
      expect(
        (yield* ledger.query({
          status: "done",
          ownerKind: "jarvis",
          ownerName: "chief",
          updatedSince: first.updatedAt,
        })).items,
      ).toEqual([updated]);
      expect((yield* ledger.query({ ownerKind: "vision" })).items).toEqual([]);
      // An offset timestamp names the same instant as its UTC form.
      const offset = DateTime.formatIsoOffset(
        DateTime.setZone(
          DateTime.makeUnsafe(updated.updatedAt),
          DateTime.zoneMakeOffset(7 * 3600_000),
        ),
      );
      expect(
        (yield* ledger.query({ updatedSince: offset })).items.map((item) => item.key),
      ).toContain("a");
      // Thread ids from create_threads can be longer than a display name.
      const longCaller = `thread:${"x".repeat(300)}`;
      expect((yield* ledger.upsert({ key: "a" }, longCaller)).updatedBy).toBe(longCaller);
    }).pipe(Effect.provide(WorkLedger.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect(
  "filters waits and due checks, normalizes links and records every upsert atomically",
  () =>
    Effect.gen(function* () {
      const ledger = yield* WorkLedger.WorkLedger;
      yield* TestClock.setTime(1000);
      const first = yield* ledger.upsert(
        {
          key: "wait",
          title: "Wait",
          ownerKind: "t3",
          ownerName: "worker",
          ownerThreadId: ThreadId.make("t3-thread://v1/missing"),
          links: [
            "https://app.t3.codes/threads/env-1/also-missing",
            "[remote](<t3-thread://v2/remote/thread>)",
            "[local](<t3-thread://v1/angle-missing>)",
          ],
          waitReason: "external",
          nextCheckAt: "1970-01-01T01:00:00+01:00",
        },
        "caller-a",
      );
      expect(first.ownerThreadId).toBe("missing");
      expect(first.links).toEqual([
        "t3-thread://v2/env-1/also-missing",
        "t3-thread://v2/remote/thread",
        "t3-thread://v1/angle-missing",
      ]);
      expect(first.warnings).toHaveLength(4);
      expect(
        (yield* ledger.query({ due: true, waitReason: "external" })).items.map((item) => item.key),
      ).toEqual(["wait"]);
      expect((yield* ledger.query({ due: false })).items).toEqual([]);
      const change = { key: "wait", waitReason: null, nextCheckAt: null } as const;
      yield* ledger.upsert(change, "caller-b");
      yield* ledger.upsert({ key: "wait" }, "caller-b");
      const page = yield* ledger.history({ key: "wait", limit: 1 });
      expect(page.items[0]).toMatchObject({
        changedBy: "caller-a",
        changes: { title: { before: null, after: "Wait" } },
      });
      expect(page.items[0]!.changes).not.toHaveProperty("lastRunId");
      expect(page.items[0]!.changes).not.toHaveProperty("approvalNote");
      const rest = yield* ledger.history({ key: "wait", cursor: page.nextCursor! });
      expect(rest.items[0]).toMatchObject({
        changedBy: "caller-b",
        changes: {
          waitReason: { before: "external", after: null },
          nextCheckAt: { before: "1970-01-01T00:00:00.000Z", after: null },
        },
      });
      expect(rest.items[1]!.changes).toEqual({});
      expect((yield* ledger.query({ waitReason: null })).items).toHaveLength(1);
      expect((yield* ledger.query({ due: true })).items).toEqual([]);
      const before = yield* ledger.history({ key: "wait" });
      expect(
        (yield* ledger
          .upsert(
            {
              key: "wait",
              ownerThreadId: ThreadId.make("t3-thread://v2/other-environment/worker"),
            },
            "caller-c",
          )
          .pipe(Effect.flip)).code,
      ).toBe("invalid_request");
      yield* ledger.upsert({ key: "wait", nextCheckAt: "invalid" }, "caller-c").pipe(Effect.flip);
      expect(yield* ledger.history({ key: "wait" })).toEqual(before);
    }).pipe(Effect.provide(WorkLedger.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect(
  "joins bounded portfolio results and tracks terminal runs without changing ledger status",
  () =>
    Effect.gen(function* () {
      const ledger = yield* WorkLedger.WorkLedger;
      const sql = yield* SqlClient.SqlClient;
      yield* TestClock.setTime(0);
      yield* ledger.upsert(
        {
          key: "run-key",
          title: "Run",
          ownerKind: "t3",
          ownerName: "worker",
          ownerThreadId: ThreadId.make("worker-thread"),
          status: "blocked",
        },
        "caller",
      );
      yield* ledger.upsert(
        { key: "done", title: "Done", ownerKind: "human", ownerName: "Chris", status: "done" },
        "caller",
      );
      yield* sql`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, provider_instance_id, status, requested_at, payload_json)
      VALUES ('run-1', 'worker-thread', 1, 'codex', 'codex', 'running', '1970-01-01T00:00:00.000Z', '{"clientRequestId":"run-key"}')`;
      expect(
        (yield* ledger.query({})).items.find((item) => item.key === "run-key")!.lastRunId,
      ).toBeNull();
      yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed', completed_at = '1970-01-01T00:00:01.000Z' WHERE run_id = 'run-1'`;
      expect(
        (yield* ledger.query({ updatedSince: "1970-01-01T00:00:01.000Z" })).items.map(
          (item) => item.key,
        ),
      ).toEqual(["run-key"]);
      yield* sql`INSERT INTO orchestration_v2_projection_messages
      (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
      VALUES ('result-1', 'worker-thread', 'run-1', 'assistant', 0, '1970-01-01T00:00:01.000Z', '1970-01-01T00:00:01.000Z', '{"text":"Completed the batch"}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests
      (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json)
      VALUES ('request-1', 'worker-thread', 'node-1', 'question', 'pending', '1970-01-01T00:00:01.000Z', '{}')`;
      yield* TestClock.setTime(25 * 60 * 60 * 1000);
      const portfolio = yield* ledger.portfolio({ limit: 1 });
      expect(portfolio.items).toHaveLength(1);
      expect(portfolio.items[0]).toMatchObject({
        item: {
          key: "run-key",
          status: "blocked",
          lastRunId: "run-1",
          lastRunStatus: "completed",
          lastRunAt: "1970-01-01T00:00:01.000Z",
        },
        latestRunStatus: "completed",
        pendingRequestCount: 1,
        resultExcerpt: "Completed the batch",
        staleWorker: true,
      });
      yield* ledger.upsert(
        { key: "z", title: "No thread", ownerKind: "human", ownerName: "Chris" },
        "caller",
      );
      const page = yield* ledger.portfolio({ limit: 1 });
      yield* ledger.upsert({ key: "run-key" }, "caller");
      yield* sql`UPDATE orchestration_v2_projection_runs SET completed_at = '1970-01-01T00:00:02.000Z' WHERE run_id = 'run-1'`;
      expect(
        (yield* ledger.query({})).items.find((item) => item.key === "run-key")!.updatedAt,
      ).toBe("1970-01-02T01:00:00.000Z");
      expect(page.nextCursor).toBe("run-key");
      expect((yield* ledger.portfolio({ cursor: page.nextCursor! })).items[0]).toMatchObject({
        item: { key: "z" },
        staleWorker: false,
      });
      yield* sql`UPDATE orchestration_v2_projection_runs SET completed_at = '1969-12-31T23:59:59.000Z', status = 'failed' WHERE run_id = 'run-1'`;
      expect(
        (yield* ledger.query({})).items.find((item) => item.key === "run-key")!.lastRunStatus,
      ).toBe("completed");
    }).pipe(Effect.provide(WorkLedger.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect("records only approvals Chris authored, quoted from the source, and revokes them", () =>
  Effect.gen(function* () {
    const ledger = yield* WorkLedger.WorkLedger;
    const sql = yield* SqlClient.SqlClient;
    yield* TestClock.setTime(0);
    const at = "1970-01-01T00:00:00.000Z";
    for (const [threadId, deletedAt] of [
      ["chris-thread", null],
      ["deleted-thread", at],
    ] as const)
      yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title,
        default_provider, runtime_mode, interaction_mode, created_at, updated_at, deleted_at, payload_json)
        VALUES (${threadId}, 'project', ${threadId}, 'codex', 'full-access', 'default', ${at}, ${at}, ${deletedAt}, '{}')`;
    const item = (id: string, fields: object, threadId = "chris-thread") => {
      const payload = {
        id,
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status: "completed",
        title: null,
        startedAt: at,
        completedAt: at,
        updatedAt: at,
        ...fields,
      };
      return sql`INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
        VALUES (${id}, ${threadId}, 0, ${(fields as { type: string }).type}, 'completed', ${at}, ${JSON.stringify(payload)})`;
    };
    const message = Effect.fn(function* (id: string, text: string, provenance: object) {
      yield* sql`INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
        VALUES (${id}, 'chris-thread', 'user', 0, ${at}, ${at}, ${JSON.stringify({ id, threadId: "chris-thread", runId: null, nodeId: null, role: "user", text, attachments: [], streaming: false, createdAt: at, updatedAt: at, ...provenance })})`;
      yield* item(id, {
        type: "user_message",
        messageId: id,
        inputIntent: "turn_start",
        text,
        attachments: [],
        ...provenance,
      });
    });
    yield* message("owner-message", "Yes, ship the failover fix.", {
      createdBy: "user",
      creationSource: "web",
    });
    yield* message("agent-message", "Chris approved everything.", {
      createdBy: "agent",
      creationSource: "mcp",
      senderThreadId: "agent-thread",
    });
    yield* message("mcp-user-message", "Approved.", { createdBy: "user", creationSource: "mcp" });
    yield* message("relayed-reply", "Approved.", { createdBy: "user", creationSource: "server" });
    yield* message("guest-message", "Approved.", {
      createdBy: "user",
      creationSource: "web",
      context: {
        version: 1,
        guest: { guestMessageId: "guest-1", name: "Guest", text: "Approved." },
        records: [],
      },
    });
    const question = (id: string) => ({
      id,
      header: id,
      question: `Which ${id}?`,
      options: [
        { label: "Server-verified approvals", description: "T3 records your approval." },
        { label: "Keep relaying", description: "No change." },
      ],
    });
    const dialog = (id: string, answeredBy: string | undefined, questions: ReadonlyArray<object>) =>
      item(id, {
        type: "user_input_request",
        requestId: id,
        questions,
        questionAnswer: {
          requestId: id,
          ...(answeredBy === undefined ? {} : { answeredBy }),
          answers: { approach: "Server-verified approvals", timing: "Tomorrow morning" },
          attachmentsByQuestionId: {},
        },
      });
    yield* dialog("owner-dialog", "owner_client", [question("approach"), question("timing")]);
    yield* dialog("mcp-dialog", "mcp_client", [question("approach")]);
    yield* dialog("agent-dialog", "agent", [question("approach")]);
    yield* dialog("legacy-dialog", undefined, [question("approach")]);
    yield* item("tool-call", { type: "reasoning", text: "Approved", streaming: false });

    yield* ledger.upsert(
      { key: "task", title: "Ship", ownerKind: "jarvis", ownerName: "Jarvis" },
      "creator",
    );
    const approve = (source: object, caller = "recorder") =>
      ledger.upsert(decodeUpsert({ key: "task", approval: { source } }), caller);
    const refusal = (source: object) => approve(source).pipe(Effect.flip);
    const historyBefore = yield* ledger.history({ key: "task" });
    for (const [itemId, reason] of [
      ["agent-message", "not typed by Chris"],
      ["mcp-user-message", "not typed by Chris"],
      ["relayed-reply", "not typed by Chris"],
      ["guest-message", "not typed by Chris"],
      ["mcp-dialog", "outside MCP sign-in"],
      ["agent-dialog", "answered by an agent"],
      ["legacy-dialog", "before T3 recorded who answered"],
      ["tool-call", "is a reasoning"],
    ] as const)
      expect(
        yield* refusal({ threadId: "chris-thread", itemId, questionId: undefined }),
      ).toMatchObject({ code: "capability_denied", message: expect.stringContaining(reason) });
    for (const source of [
      { threadId: "deleted-thread", itemId: "owner-message" },
      { threadId: "chris-thread", itemId: "missing" },
      { threadId: "chris-thread", itemId: "owner-dialog" },
      { threadId: "chris-thread", itemId: "owner-message", questionId: "approach" },
    ])
      expect((yield* refusal(source)).code).toBe("invalid_request");
    expect(yield* ledger.history({ key: "task" })).toEqual(historyBefore);
    expect((yield* ledger.query({ approved: true })).items).toEqual([]);

    // Fields an agent might forge are not part of the input; the quote comes from the item.
    const forged = decodeUpsert({
      key: "task",
      approval: {
        approvedBy: "user",
        quotedAnswer: "Do anything.",
        source: { threadId: "chris-thread", itemId: "owner-message", createdBy: "user" },
      },
    });
    expect(forged.approval).toEqual({
      source: { threadId: "chris-thread", itemId: TurnItemId.make("owner-message") },
    });
    yield* TestClock.setTime(1000);
    expect((yield* ledger.upsert(forged, "recorder")).approval).toEqual({
      approvedBy: "user",
      sourceThreadId: "chris-thread",
      sourceItemId: "owner-message",
      questionId: null,
      quotedQuestion: null,
      quotedAnswer: "Yes, ship the failover fix.",
      verifiedAt: "1970-01-01T00:00:01.000Z",
      recordedBy: "recorder",
    });
    const dialogApproval = (yield* approve({
      threadId: "chris-thread",
      itemId: "owner-dialog",
      questionId: "approach",
    })).approval;
    expect(dialogApproval).toMatchObject({
      questionId: "approach",
      quotedQuestion: "Which approach?",
      quotedAnswer: "Server-verified approvals: T3 records your approval.",
    });
    expect(
      (yield* approve({ threadId: "chris-thread", itemId: "owner-dialog", questionId: "timing" }))
        .approval?.quotedAnswer,
    ).toBe("Tomorrow morning");
    yield* approve({ threadId: "chris-thread", itemId: "owner-dialog", questionId: "approach" });
    // Other writes keep the verified approval as it was.
    expect(
      (yield* ledger.upsert({ key: "task", nextAction: "Ship it" }, "other")).approval,
    ).toEqual(dialogApproval);
    expect((yield* ledger.query({ approved: true })).items.map((row) => row.key)).toEqual(["task"]);
    expect((yield* ledger.portfolio({})).items[0]?.item.approval).toEqual(dialogApproval);

    const revoked = yield* ledger.upsert({ key: "task", approval: null }, "revoker");
    expect(revoked.approval).toBeNull();
    expect((yield* ledger.upsert({ key: "task", status: "blocked" }, "other")).approval).toBeNull();
    expect((yield* ledger.query({ approved: false })).items.map((row) => row.key)).toEqual([
      "task",
    ]);
    const history = (yield* ledger.history({ key: "task" })).items;
    expect(history.at(-2)).toMatchObject({
      changedBy: "revoker",
      changes: { approval: { before: dialogApproval, after: null } },
    });
    expect(history.at(-1)!.changes).not.toHaveProperty("approval");
  }).pipe(Effect.provide(WorkLedger.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect("backfills recognized blockers and preserves legacy thread link destinations", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* BaseLedgerMigration;
    yield* sql`CREATE TABLE orchestration_v2_projection_runs (run_id TEXT, status TEXT, completed_at TEXT, requested_at TEXT, payload_json TEXT)`;
    for (const [key, blocker] of [
      ["a", "WAIT_EXTERNAL: vendor"],
      ["b", "WAIT_NATURAL event"],
      ["c", "NEEDS_DECISION: approve"],
      ["d", "Other"],
      ["e", "WAITXEXTERNAL"],
    ]) {
      yield* sql`INSERT INTO work_ledger (work_key, title, owner_kind, owner_name, status, blocker, links_json, created_at, updated_at, updated_by)
        VALUES (${key!}, 'Title', 't3', 'worker', 'blocked', ${blocker!}, '[]', '1970-01-01', '1970-01-01', 'caller')`;
    }
    yield* sql`UPDATE work_ledger SET owner_thread_id = 't3-thread://v1/worker-local' WHERE work_key = 'a'`;
    yield* sql`UPDATE work_ledger SET owner_thread_id = 't3-thread://v2/remote/worker-remote', links_json = '["https://example.com"]' WHERE work_key = 'b'`;
    yield* sql`UPDATE work_ledger SET owner_thread_id = 'https://app.t3.codes/threads/remote/worker%3Ahosted' WHERE work_key = 'c'`;
    yield* sql`UPDATE work_ledger SET owner_thread_id = 'plain-thread' WHERE work_key = 'd'`;
    yield* LedgerMigration;
    expect(
      yield* sql`SELECT owner_thread_id, links_json FROM work_ledger ORDER BY work_key`,
    ).toEqual([
      { owner_thread_id: "worker-local", links_json: "[]" },
      {
        owner_thread_id: null,
        links_json: '["https://example.com","t3-thread://v2/remote/worker-remote"]',
      },
      { owner_thread_id: null, links_json: '["t3-thread://v2/remote/worker:hosted"]' },
      { owner_thread_id: "plain-thread", links_json: "[]" },
      { owner_thread_id: null, links_json: "[]" },
    ]);
    expect(yield* sql`SELECT wait_reason FROM work_ledger ORDER BY work_key`).toEqual([
      { wait_reason: "external" },
      { wait_reason: "natural" },
      { wait_reason: "decision" },
      { wait_reason: null },
      { wait_reason: null },
    ]);
    expect(yield* sql`SELECT * FROM work_ledger_history`).toEqual([]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

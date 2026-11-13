import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { decodeJsonReply, fromRunner } from "./textGenerationOperations.ts";
import { ApprovalReviewOutput } from "./approvalReview.ts";

it.effect("requires one complete JSON object for approval reviews", () =>
  Effect.gen(function* () {
    const valid = '{"decision":"approve","reason":"Authorized tests"}';
    for (const text of [
      `Here is the answer: ${valid}`,
      `${valid}${valid}`,
      `\x60\x60\x60json\n${valid}\n\x60\x60\x60`,
      `${valid} trailing`,
    ]) {
      const error = yield* Effect.flip(
        decodeJsonReply(
          { operation: "reviewApproval", outputSchema: ApprovalReviewOutput },
          "reviewer",
          text,
        ),
      );
      assert.instanceOf(error, TextGenerationError);
    }
    assert.deepEqual(
      yield* decodeJsonReply(
        { operation: "reviewApproval", outputSchema: ApprovalReviewOutput },
        "reviewer",
        ` \n${valid}\n `,
      ),
      { decision: "approve", reason: "Authorized tests" },
    );
  }),
);

// regression: #23726 a reply that echoes the schema key replaced the seed title with "title"
it.effect("fails a thread title reply that is only the schema key", () =>
  Effect.gen(function* () {
    const textGeneration = fromRunner("Stub", (request) =>
      decodeJsonReply(request, "Stub", '{"title":"title","needsRefinement":false}'),
    );

    const outcome = yield* textGeneration
      .generateThreadTitle({
        cwd: process.cwd(),
        message: "$implement Issue #140",
        modelSelection: {
          instanceId: ProviderInstanceId.make("pi"),
          model: "anthropic/claude-haiku-4-5",
        },
      })
      .pipe(Effect.match({ onFailure: (error) => error, onSuccess: (result) => result }));

    assert.instanceOf(outcome, TextGenerationError);
    assert.strictEqual(outcome.operation, "generateThreadTitle");
  }),
);

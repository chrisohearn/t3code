// @effect-diagnostics-next-line nodeBuiltinImport:off -- Verify the wire signature with an independent HMAC implementation.
import * as NodeCrypto from "node:crypto";
import * as EffectNodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as Webhook from "./McpEventsWebhook.ts";

const secret = Redacted.make(`whsec_${Buffer.alloc(32, 7).toString("base64")}`);
const replacement = Redacted.make(`whsec_${Buffer.alloc(24, 8).toString("base64")}`);
const url = "https://callbacks.example.com/events";
const json = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const withNetwork = (
  network: Omit<Webhook.CallbackNetwork["Service"], "localAddresses"> &
    Partial<Pick<Webhook.CallbackNetwork["Service"], "localAddresses">>,
) =>
  Webhook.layer.pipe(
    Layer.provide(
      Layer.succeed(Webhook.CallbackNetwork, { localAddresses: Effect.succeed([]), ...network }),
    ),
    Layer.provide(EffectNodeCrypto.layer),
  );

it.effect(
  "rechecks resource authority after DNS resolution before releasing application bytes",
  () => {
    let revoked = false;
    let posts = 0;
    return Effect.gen(function* () {
      const webhook = yield* Webhook.McpEventsWebhook;
      const error = yield* webhook
        .send({
          id: "event",
          subscriptionId: "sub",
          url,
          secret,
          body: "{}",
          authorize: Effect.suspend(() =>
            revoked
              ? Effect.fail(new Webhook.CallbackError({ reason: "access_denied" }))
              : Effect.void,
          ),
        })
        .pipe(Effect.flip);
      expect(error.reason).toBe("access_denied");
      expect(posts).toBe(0);
    }).pipe(
      Effect.provide(
        withNetwork({
          resolve: () =>
            Effect.sync(() => {
              revoked = true;
              return [{ address: "8.8.8.8", family: 4 }];
            }),
          post: () =>
            Effect.sync(() => {
              posts++;
              return { status: 204, body: "" };
            }),
        }),
      ),
    );
  },
);

it.effect(
  "signs the exact bytes with supplied decoded keys and resolves again on every attempt",
  () => {
    const requests: Array<Parameters<Webhook.CallbackNetwork["Service"]["post"]>[0]> = [];
    let resolves = 0;
    const body = '{"eventId":"event-1","data":{"unicode":"界","n":2}}';
    return Effect.gen(function* () {
      const webhook = yield* Webhook.McpEventsWebhook;
      const input = {
        id: "event-1",
        subscriptionId: "sub-1",
        url,
        secret,
        previousSecret: replacement,
        body,
        authorize: Effect.void,
      };
      expect(yield* webhook.send(input)).toBe(204);
      yield* TestClock.adjust("2 seconds");
      expect(yield* webhook.send(input)).toBe(204);
      expect(resolves).toBe(2);
      expect(requests.map((request) => request.body)).toEqual([body, body]);
      expect(requests[0]?.url.hostname).toBe("callbacks.example.com");
      expect(requests[0]?.address).toEqual({ address: "8.8.8.8", family: 4 });
      for (const request of requests) {
        const timestamp = request.headers["webhook-timestamp"];
        const expected = [7, 8]
          .map(
            (value) =>
              `v1,${NodeCrypto.createHmac("sha256", Buffer.alloc(value === 7 ? 32 : 24, value))
                .update(`event-1.${timestamp}.${body}`)
                .digest("base64")}`,
          )
          .join(" ");
        expect(request.headers["webhook-signature"]).toBe(expected);
        expect(request.headers["webhook-id"]).toBe("event-1");
      }
      expect(requests[0]?.headers["webhook-signature"]).not.toBe(
        requests[1]?.headers["webhook-signature"],
      );
    }).pipe(
      Effect.provide(
        withNetwork({
          resolve: () =>
            Effect.sync(() => {
              resolves++;
              return [{ address: "8.8.8.8", family: 4 }];
            }),
          post: (input) =>
            Effect.sync(() => {
              requests.push(input);
              return { status: 204, body: "" };
            }),
        }),
      ),
    );
  },
);

it.effect.each([
  "127.0.0.1",
  "10.0.0.1",
  "100.64.0.1",
  "169.254.169.254",
  "172.16.0.1",
  "192.168.0.1",
  "0.0.0.0",
  "192.0.0.9",
  "192.0.2.1",
  "198.18.0.1",
  "198.51.100.1",
  "203.0.113.1",
  "224.0.0.1",
  "::1",
  "::",
  "fc00::1",
  "fe80::1",
  "2001:db8::1",
  "2002:7f00:1::",
  "::ffff:8.8.8.8",
  "64:ff9b::7f00:1",
])("rejects every non-public answer including a mixed DNS result: %s", (address) => {
  let posts = 0;
  return Effect.gen(function* () {
    const webhook = yield* Webhook.McpEventsWebhook;
    const error = yield* webhook
      .send({
        id: "event-1",
        subscriptionId: "sub-1",
        url,
        secret,
        body: "{}",
        authorize: Effect.void,
      })
      .pipe(Effect.flip);
    expect(error.reason).toBe("non_public_address");
    expect(posts).toBe(0);
  }).pipe(
    Effect.provide(
      withNetwork({
        resolve: () =>
          Effect.succeed([
            { address: "8.8.8.8", family: 4 },
            { address, family: address.includes(":") ? 6 : 4 },
          ]),
        post: () =>
          Effect.sync(() => {
            posts++;
            return { status: 200, body: "" };
          }),
      }),
    ),
  );
});

it.effect(
  "verifies a fresh challenge, isolates and expires the cache, and rejects a replayed echo",
  () => {
    const challenges: Array<string> = [];
    let replay = false;
    let stale = false;
    return Effect.gen(function* () {
      const webhook = yield* Webhook.McpEventsWebhook;
      const input = {
        principal: "principal-1",
        subscriptionId: "sub-1",
        url,
        secret,
        authorize: Effect.void,
      };
      yield* webhook.verify(input);
      yield* webhook.verify(input);
      expect(challenges).toHaveLength(1);
      yield* webhook.verify({ ...input, principal: "principal-2" });
      yield* webhook.verify({ ...input, secret: replacement });
      expect(new Set(challenges).size).toBe(3);
      yield* TestClock.adjust("5 minutes");
      replay = true;
      const error = yield* webhook.verify(input).pipe(Effect.flip);
      expect(error.reason).toBe("challenge_failed");
      expect(new Set(challenges).size).toBe(4);
      replay = false;
      stale = true;
      expect(
        (yield* webhook.verify({ ...input, principal: "principal-stale" }).pipe(Effect.flip))
          .reason,
      ).toBe("challenge_failed");
    }).pipe(
      Effect.provide(
        withNetwork({
          resolve: () => Effect.succeed([{ address: "8.8.8.8", family: 4 }]),
          post: (input) =>
            Effect.sync(() => {
              const challenge = (json(input.body) as { challenge: string }).challenge;
              challenges.push(challenge);
              return {
                status: 200,
                body: encode({ challenge: replay ? challenges[0] : challenge }),
              };
            }).pipe(Effect.tap(() => (stale ? TestClock.adjust("31 seconds") : Effect.void))),
        }),
      ),
    );
  },
);

it.effect.each([302, 410, 413, 500])(
  "requires a 2xx challenge response and does not follow %s",
  (status) => {
    let posts = 0;
    return Effect.gen(function* () {
      const webhook = yield* Webhook.McpEventsWebhook;
      const error = yield* webhook
        .verify({
          principal: "principal",
          subscriptionId: "sub",
          url,
          secret,
          authorize: Effect.void,
        })
        .pipe(Effect.flip);
      expect(error.reason).toBe("challenge_failed");
      expect(posts).toBe(1);
    }).pipe(
      Effect.provide(
        withNetwork({
          resolve: () => Effect.succeed([{ address: "8.8.8.8", family: 4 }]),
          post: (input) =>
            Effect.sync(() => {
              posts++;
              return {
                status,
                body: encode({ challenge: (json(input.body) as { challenge: string }).challenge }),
              };
            }),
        }),
      ),
    );
  },
);

it.effect("rejects malformed secrets, unsafe URLs, and oversized payloads before connecting", () =>
  Effect.gen(function* () {
    for (const length of [24, 64])
      expect(
        Redacted.value(
          yield* Webhook.decodeSecret(
            Redacted.make(`whsec_${Buffer.alloc(length).toString("base64")}`),
          ),
        ).length,
      ).toBe(length);
    for (const value of [
      "whsec_bad!",
      `whsec_${Buffer.alloc(23).toString("base64")}`,
      `whsec_${Buffer.alloc(65).toString("base64")}`,
      "not-a-secret",
    ]) {
      expect((yield* Webhook.decodeSecret(Redacted.make(value)).pipe(Effect.flip)).reason).toBe(
        "invalid_secret",
      );
    }
    for (const value of [
      "http://example.com",
      "https://127.1",
      "https://localhost",
      "https://u:p@example.com",
      "https://example.com/#secret",
    ]) {
      expect((yield* Webhook.callbackUrl(value).pipe(Effect.flip)).reason).toBe("invalid_url");
    }
    const webhook = yield* Webhook.McpEventsWebhook;
    expect(
      (yield* webhook
        .send({
          id: "event",
          subscriptionId: "sub",
          url,
          secret,
          body: "x".repeat(256 * 1024 + 1),
          authorize: Effect.void,
        })
        .pipe(Effect.flip)).reason,
    ).toBe("payload_too_large");
  }).pipe(
    Effect.provide(
      withNetwork({
        resolve: () => Effect.die("must not resolve"),
        post: () => Effect.die("must not connect"),
      }),
    ),
  ),
);

it.effect.each([
  { address: "8.8.8.8", own: "8.8.8.8", family: 4 },
  { address: "2001:4860:4860::8888", own: "2001:4860:4860:0:0:0:0:8888", family: 6 },
])("rejects the host's own public interface address $address", ({ address, own, family }) => {
  let posts = 0;
  return Effect.gen(function* () {
    const webhook = yield* Webhook.McpEventsWebhook;
    expect(
      (yield* webhook
        .send({
          id: "event",
          subscriptionId: "sub",
          url,
          secret,
          body: "{}",
          authorize: Effect.void,
        })
        .pipe(Effect.flip)).reason,
    ).toBe("non_public_address");
    expect(posts).toBe(0);
  }).pipe(
    Effect.provide(
      withNetwork({
        localAddresses: Effect.succeed([{ address: own, family }]),
        resolve: () =>
          Effect.succeed([
            { address: "8.8.4.4", family: 4 },
            { address, family },
          ]),
        post: () =>
          Effect.sync(() => {
            posts++;
            return { status: 204, body: "" };
          }),
      }),
    ),
  );
});

it.effect(
  "bounds pending verification per principal and globally and rejects duplicate in-flight challenges",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Queue.unbounded<void>();
        const release = yield* Deferred.make<void>();
        let resolves = 0;
        const work = Effect.gen(function* () {
          const webhook = yield* Webhook.McpEventsWebhook;
          const input = (i: number) => ({
            principal: `principal-${Math.floor(i / 16)}`,
            subscriptionId: `sub-${i}`,
            url: `${url}/${i}`,
            secret,
            authorize: Effect.void,
          });
          const running = yield* Effect.forEach(
            Array.from({ length: 64 }, (_, i) => i),
            (i) => webhook.verify(input(i)),
            { concurrency: "unbounded" },
          ).pipe(Effect.forkScoped);
          for (let i = 0; i < 64; i++) yield* Queue.take(started);
          expect((yield* webhook.verify(input(0)).pipe(Effect.flip)).reason).toBe(
            "verification_busy",
          );
          expect(
            (yield* webhook
              .verify({ ...input(0), url: `${url}/principal-overflow`, secret: replacement })
              .pipe(Effect.flip)).reason,
          ).toBe("verification_busy");
          expect(
            (yield* webhook.verify({ ...input(1000), secret: replacement }).pipe(Effect.flip))
              .reason,
          ).toBe("verification_busy");
          expect(resolves).toBe(64);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(running);
          yield* webhook.verify(input(0));
          expect(resolves).toBe(64);
        });
        yield* work.pipe(
          Effect.provide(
            withNetwork({
              resolve: () =>
                Effect.sync(() => {
                  resolves++;
                  return [{ address: "8.8.8.8", family: 4 }];
                }),
              post: (input) =>
                Queue.offer(started, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as({ status: 200, body: input.body }),
                ),
            }),
          ),
        );
      }),
    ),
);

it.effect(
  "bounds failed challenge attempts before DNS even when no durable subscription is created",
  () => {
    let resolves = 0;
    return Effect.gen(function* () {
      const webhook = yield* Webhook.McpEventsWebhook;
      const input = (principal: string) => ({
        principal,
        subscriptionId: "sub",
        url,
        secret,
        authorize: Effect.void,
      });
      for (let principal = 0; principal < 4; principal++) {
        for (let i = 0; i < 512; i++)
          expect((yield* webhook.verify(input(String(principal))).pipe(Effect.flip)).reason).toBe(
            "challenge_failed",
          );
        expect((yield* webhook.verify(input(String(principal))).pipe(Effect.flip)).reason).toBe(
          "verification_rate_limited",
        );
      }
      expect((yield* webhook.verify(input("new-principal")).pipe(Effect.flip)).reason).toBe(
        "verification_rate_limited",
      );
      expect(resolves).toBe(2048);
      yield* TestClock.adjust("1 minute");
      expect((yield* webhook.verify(input("0")).pipe(Effect.flip)).reason).toBe("challenge_failed");
      expect(resolves).toBe(2049);
    }).pipe(
      Effect.provide(
        withNetwork({
          resolve: () =>
            Effect.sync(() => {
              resolves++;
              return [{ address: "8.8.8.8", family: 4 }];
            }),
          post: () => Effect.succeed({ status: 400, body: "{}" }),
        }),
      ),
    );
  },
);

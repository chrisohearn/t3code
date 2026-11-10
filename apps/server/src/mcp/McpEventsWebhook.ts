import * as NodeDnsPromises from "node:dns/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The callback adapter must pin DNS without changing TLS hostname verification.
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Reject callbacks to the server's own network interfaces.
import * as NodeOS from "node:os";
import { isPublicFaviconHost, normalizeHostname } from "@t3tools/shared/hostClassification";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Mac from "effect/crypto/Mac";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { constantTimeEquals } from "../scheduledTasks/webhookVerification.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeChallenge = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ challenge: Schema.String })),
);

export class CallbackError extends Schema.TaggedError<CallbackError>()("McpEventsCallbackError", {
  reason: Schema.Literals([
    "invalid_url",
    "invalid_secret",
    "non_public_address",
    "resolve_failed",
    "timeout",
    "network",
    "response_too_large",
    "payload_too_large",
    "challenge_failed",
    "access_denied",
    "verification_busy",
    "verification_rate_limited",
  ]),
}) {
  override get message() {
    return "The MCP Events callback could not be verified or reached.";
  }
}
const isCallbackError = Schema.is(CallbackError);

interface Address {
  readonly address: string;
  readonly family: number;
}
interface CallbackResponse {
  readonly status: number;
  readonly body: string;
}

export class CallbackNetwork extends Context.Service<
  CallbackNetwork,
  {
    readonly localAddresses: Effect.Effect<ReadonlyArray<Address>, CallbackError>;
    readonly resolve: (hostname: string) => Effect.Effect<ReadonlyArray<Address>, CallbackError>;
    readonly post: (input: {
      readonly url: URL;
      readonly address: Address;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: string;
    }) => Effect.Effect<CallbackResponse, CallbackError>;
  }
>()("t3/mcp/McpEventsWebhook/CallbackNetwork") {}

export const layerNetwork = Layer.succeed(CallbackNetwork, {
  localAddresses: Effect.try({
    try: () =>
      Object.values(NodeOS.networkInterfaces()).flatMap((entries) =>
        (entries ?? []).map((entry) => ({
          address: entry.address,
          family: entry.family === "IPv6" ? 6 : 4,
        })),
      ),
    catch: () => new CallbackError({ reason: "network" }),
  }),
  resolve: Effect.fn("McpEventsWebhook.resolve")((hostname: string) =>
    Effect.tryPromise({
      try: () => NodeDnsPromises.lookup(hostname, { all: true, verbatim: true }),
      catch: () => new CallbackError({ reason: "resolve_failed" }),
    }).pipe(
      Effect.timeout("10 seconds"),
      Effect.catchTags({ TimeoutError: () => new CallbackError({ reason: "timeout" }) }),
    ),
  ),
  post: Effect.fn("McpEventsWebhook.post")((input) =>
    Effect.tryPromise({
      try: (signal) =>
        new Promise<CallbackResponse>((resolve, reject) => {
          const request = NodeHttps.request(
            input.url,
            {
              method: "POST",
              agent: false,
              signal,
              headers: input.headers,
              family: input.address.family,
              // Resolve once per connection; TLS still verifies the URL's original hostname.
              lookup: (_hostname, _options, callback) =>
                callback(null, input.address.address, input.address.family),
            },
            (response) => {
              const chunks: Array<Buffer> = [];
              let length = 0;
              response.on("data", (chunk: Buffer) => {
                length += chunk.byteLength;
                if (length > 4096) {
                  request.destroy();
                  reject(new CallbackError({ reason: "response_too_large" }));
                } else chunks.push(chunk);
              });
              response.on("error", reject);
              response.on("end", () =>
                resolve({
                  status: response.statusCode ?? 0,
                  body: Buffer.concat(chunks).toString("utf8"),
                }),
              );
            },
          );
          request.on("error", reject);
          request.end(input.body);
        }),
      catch: (error) => (isCallbackError(error) ? error : new CallbackError({ reason: "network" })),
    }).pipe(
      Effect.timeout("10 seconds"),
      Effect.catchTags({ TimeoutError: () => new CallbackError({ reason: "timeout" }) }),
    ),
  ),
});

export const decodeSecret = Effect.fn("McpEventsWebhook.decodeSecret")(function* (
  secret: Redacted.Redacted<string>,
) {
  const value = Redacted.value(secret);
  const encoded = value.startsWith("whsec_") ? value.slice(6) : "";
  if (encoded.length < 32 || encoded.length > 88)
    return yield* new CallbackError({ reason: "invalid_secret" });
  const bytes = Buffer.from(encoded, "base64");
  if (
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) ||
    bytes.length < 24 ||
    bytes.length > 64 ||
    bytes.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")
  ) {
    return yield* new CallbackError({ reason: "invalid_secret" });
  }
  return Redacted.make(bytes);
});

export const callbackUrl = (value: string) =>
  Effect.try({
    try: () => {
      const url = new URL(value);
      if (
        value.length > 4096 ||
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.hash ||
        !isPublicFaviconHost(url.hostname)
      )
        throw new Error();
      return url;
    },
    catch: () => new CallbackError({ reason: "invalid_url" }),
  });

export class McpEventsWebhook extends Context.Service<
  McpEventsWebhook,
  {
    readonly verify: (input: {
      readonly principal: string;
      readonly url: string;
      readonly secret: Redacted.Redacted<string>;
      readonly subscriptionId: string;
      readonly authorize: Effect.Effect<void, CallbackError>;
    }) => Effect.Effect<void, CallbackError>;
    readonly send: (input: {
      readonly id: string;
      readonly subscriptionId: string;
      readonly url: string;
      readonly body: string;
      readonly secret: Redacted.Redacted<string>;
      readonly previousSecret?: Redacted.Redacted<string>;
      readonly authorize: Effect.Effect<void, CallbackError>;
    }) => Effect.Effect<number, CallbackError>;
  }
>()("t3/mcp/McpEventsWebhook") {}

const make = Effect.gen(function* () {
  const network = yield* CallbackNetwork;
  const mac = yield* Mac.Mac;
  const digest = yield* Digest.Digest;
  const random = yield* SecureRandom.SecureRandom;
  const verified = new Map<string, number>();
  const pending = new Set<string>();
  const principals = new Map<string, { active: number; remaining: number; refillAt: number }>();
  let remaining = 2048;
  let refillAt = 0;
  const acquireVerification = Effect.fn("McpEventsWebhook.acquireVerification")(function* (
    key: string,
    principal: string,
  ) {
    const now = yield* Clock.currentTimeMillis;
    for (const [id, bucket] of principals)
      if (bucket.active === 0 && bucket.refillAt <= now) principals.delete(id);
    if (pending.has(key) || pending.size >= 64)
      return yield* new CallbackError({ reason: "verification_busy" });
    if (refillAt <= now) {
      remaining = 2048;
      refillAt = now + 60_000;
    }
    let bucket = principals.get(principal);
    if (bucket === undefined) {
      if (principals.size >= 4096)
        return yield* new CallbackError({ reason: "verification_rate_limited" });
      bucket = { active: 0, remaining: 512, refillAt: now + 60_000 };
      principals.set(principal, bucket);
    } else if (bucket.refillAt <= now) {
      bucket.remaining = 512;
      bucket.refillAt = now + 60_000;
    }
    if (bucket.active >= 16) return yield* new CallbackError({ reason: "verification_busy" });
    if (bucket.remaining <= 0 || remaining <= 0)
      return yield* new CallbackError({ reason: "verification_rate_limited" });
    // Fail fast instead of queuing unbounded handlers behind callback sockets.
    pending.add(key);
    bucket.active++;
    bucket.remaining--;
    remaining--;
    return bucket;
  });

  const send = Effect.fn("McpEventsWebhook.send")(function* (
    input: Parameters<McpEventsWebhook["Service"]["send"]>[0],
  ) {
    const url = yield* callbackUrl(input.url);
    if (Buffer.byteLength(input.body, "utf8") > 256 * 1024)
      return yield* new CallbackError({ reason: "payload_too_large" });
    const addresses = yield* network.resolve(normalizeHostname(url.hostname));
    const own = new NodeNet.BlockList();
    for (const entry of yield* network.localAddresses)
      own.addAddress(entry.address, entry.family === 6 ? "ipv6" : "ipv4");
    if (
      addresses.length === 0 ||
      addresses.some(
        ({ address, family }) =>
          NodeNet.isIP(address) !== family ||
          !isPublicFaviconHost(address) ||
          own.check(address, family === 6 ? "ipv6" : "ipv4") ||
          (family === 6 && !/^[23]/i.test(address)),
      )
    )
      return yield* new CallbackError({ reason: "non_public_address" });
    const signedAt = String(Math.floor((yield* Clock.currentTimeMillis) / 1000));
    const signatures = yield* Effect.forEach(
      [input.secret, ...(input.previousSecret === undefined ? [] : [input.previousSecret])],
      (secret) =>
        decodeSecret(secret).pipe(
          Effect.flatMap((key) => Mac.key(Mac.hmacSha256, Redacted.value(key))),
          Effect.flatMap((key) =>
            mac.sign(key, Buffer.from(`${input.id}.${signedAt}.${input.body}`, "utf8")),
          ),
          Effect.map((signature) => `v1,${Buffer.from(signature).toString("base64")}`),
          Effect.mapError(() => new CallbackError({ reason: "invalid_secret" })),
        ),
    );
    yield* input.authorize;
    const response = yield* network.post({
      url,
      address: addresses[0]!,
      body: input.body,
      headers: {
        "content-type": "application/json",
        "webhook-id": input.id,
        "webhook-timestamp": signedAt,
        "webhook-signature": signatures.join(" "),
        "x-mcp-subscription-id": input.subscriptionId,
      },
    });
    return response;
  });

  return McpEventsWebhook.of({
    send: Effect.fn("McpEventsWebhook.sendStatus")((input) =>
      send(input).pipe(Effect.map((response) => response.status)),
    ),
    verify: Effect.fn("McpEventsWebhook.verify")(function* (input) {
      yield* input.authorize;
      const url = yield* callbackUrl(input.url);
      yield* decodeSecret(input.secret);
      const keyInput = yield* encodeJson([
        input.principal,
        url.href,
        Redacted.value(input.secret),
      ]).pipe(Effect.mapError(() => new CallbackError({ reason: "invalid_secret" })));
      const key = Buffer.from(yield* digest.digest(Digest.sha256, Buffer.from(keyInput))).toString(
        "hex",
      );
      const now = yield* Clock.currentTimeMillis;
      for (const [cached, expiry] of verified) if (expiry <= now) verified.delete(cached);
      if ((verified.get(key) ?? 0) > now) return;
      yield* Effect.acquireUseRelease(
        acquireVerification(key, input.principal),
        () =>
          Effect.gen(function* () {
            const challenge = Buffer.from(yield* random.randomBytes(32)).toString("base64url");
            const id = `verification_${Buffer.from(yield* random.randomBytes(24)).toString("base64url")}`;
            const body = yield* encodeJson({ type: "verification", challenge }).pipe(
              Effect.mapError(() => new CallbackError({ reason: "challenge_failed" })),
            );
            const response = yield* send({ ...input, url: url.href, id, body });
            const echoed = yield* decodeChallenge(response.body).pipe(
              Effect.mapError(() => new CallbackError({ reason: "challenge_failed" })),
            );
            if (
              response.status < 200 ||
              response.status >= 300 ||
              (yield* Clock.currentTimeMillis) - now > 30_000 ||
              !(yield* constantTimeEquals(challenge, echoed.challenge).pipe(
                Effect.provideService(Digest.Digest, digest),
              ))
            )
              return yield* new CallbackError({ reason: "challenge_failed" });
            if (verified.size >= 1024) verified.delete(verified.keys().next().value!);
            verified.set(key, now + 300_000);
          }),
        (bucket) =>
          Effect.sync(() => {
            bucket.active--;
            pending.delete(key);
          }),
      );
    }),
  });
});

export const layer = Layer.effect(McpEventsWebhook, make);

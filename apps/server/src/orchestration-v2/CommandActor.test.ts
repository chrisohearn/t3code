import { describe, expect, it } from "@effect/vitest";
import { ownerClientActor } from "./CommandActor.ts";

describe("ownerClientActor", () => {
  it.each([
    [
      "a cloud-connect desktop",
      "dpop-access-token",
      { deviceType: "desktop", label: "Chris's Mac" },
      "Chris's Mac",
    ],
    ["a paired phone", "dpop-access-token", { deviceType: "mobile" }, "dpop-access-token"],
    [
      "the desktop app",
      "bearer-access-token",
      { deviceType: "desktop", label: "Desktop" },
      "Desktop",
    ],
    [
      "a browser cookie",
      "browser-session-cookie",
      { deviceType: "unknown", label: "Firefox" },
      "Firefox",
    ],
  ] as const)("answers as the owner from %s", (_name, method, client, clientLabel) => {
    expect(ownerClientActor({ sessionId: "0123456789abcdef", method, client })).toEqual({
      kind: "owner_client",
      client: { sessionId: "01234567", clientLabel },
    });
  });

  it("gives a `t3 auth session issue` session no actor, whatever subject it claims", () => {
    expect(
      ownerClientActor({
        sessionId: "0123456789abcdef",
        method: "bearer-access-token",
        client: { deviceType: "bot", label: "cloud-connect" },
      }),
    ).toBeUndefined();
  });
});

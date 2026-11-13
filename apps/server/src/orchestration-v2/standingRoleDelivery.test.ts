import { expect, it } from "vite-plus/test";

import { STANDING_ROLE_REFRESH_RUNS, standingRoleDue } from "./standingRoleDelivery.ts";

const role = {
  text: "role",
  revision: 3,
  updatedAt: "2026-01-01T00:00:00Z",
  updatedBy: "test",
  delivered: { revision: 3, nativeThreadId: "native-1", runOrdinal: 4 },
} as const;
const due = (overrides: Partial<Parameters<typeof standingRoleDue>[0]> = {}): boolean =>
  standingRoleDue({
    role,
    nativeThreadId: "native-1",
    runOrdinal: 5,
    compactedSinceDelivery: () => false,
    ...overrides,
  });

it("is not due again while the provider still holds it", () => {
  expect(due()).toBe(false);
});

it.each([
  ["never delivered", { role: { ...role, delivered: undefined } }],
  ["changed", { role: { ...role, revision: 4 } }],
  ["a new native session", { nativeThreadId: "native-2" }],
  [
    "enough runs to outlast an automatic compaction",
    { runOrdinal: 4 + STANDING_ROLE_REFRESH_RUNS },
  ],
  ["a compaction since delivery", { compactedSinceDelivery: (after: number) => after === 4 }],
] as const)("is due after %s", (_name, overrides) => {
  expect(due(overrides as never)).toBe(true);
});

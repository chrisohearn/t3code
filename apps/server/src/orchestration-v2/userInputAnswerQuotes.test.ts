import { describe, expect, it } from "@effect/vitest";
import { quoteUserInputAnswer } from "./userInputAnswerQuotes.ts";

const question = (fields: object = {}) => ({
  id: "q",
  header: "Q",
  question: "Which?",
  options: [
    { label: "Ship", description: "Deploy now." },
    { label: "Wait", description: "Hold until Monday.", value: "hold" },
  ],
  ...fields,
});

describe("quoteUserInputAnswer", () => {
  it.each([
    [
      "an option by its label",
      question(),
      "Ship",
      [{ kind: "option", label: "Ship", description: "Deploy now." }],
    ],
    [
      "an option by its exact value",
      question(),
      "hold",
      [{ kind: "option", label: "Wait", description: "Hold until Monday." }],
    ],
    // An option with a value is chosen only by that value, never by its label.
    [
      "the label of an option that has a value",
      question(),
      "Wait",
      [{ kind: "text", text: "Wait", prefilled: false }],
    ],
    [
      "typed text, trimmed",
      question(),
      "  Friday  ",
      [{ kind: "text", text: "Friday", prefilled: false }],
    ],
    ["a blank answer", question(), "   ", [{ kind: "text", text: "", prefilled: false }]],
    [
      "text the agent prefilled",
      question({ initialAnswer: "Deploy it " }),
      "Deploy it",
      [{ kind: "text", text: "Deploy it", prefilled: true }],
    ],
    [
      "text when typing is not allowed",
      question({ allowCustomAnswer: false }),
      "Friday",
      [{ kind: "unmatched" }],
    ],
    [
      "a value two options share",
      question({
        options: [
          { label: "A", description: "a", value: "x" },
          { label: "B", description: "b", value: "x" },
        ],
      }),
      "x",
      [{ kind: "unmatched" }],
    ],
    [
      "each of several selections",
      question({ multiSelect: true }),
      ["Ship", "hold"],
      [
        { kind: "option", label: "Ship", description: "Deploy now." },
        { kind: "option", label: "Wait", description: "Hold until Monday." },
      ],
    ],
  ])("quotes %s", (_name, q, answer, expected) => {
    expect(quoteUserInputAnswer(q, answer)).toEqual(expected);
  });
});

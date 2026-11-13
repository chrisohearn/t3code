import type { OrchestrationV2UserInputQuestion, UserInputAnswerQuote } from "@t3tools/contracts";

// The client resolver sends an option's exact value, or the trimmed label of an option without one.
const choosesOption = (
  option: OrchestrationV2UserInputQuestion["options"][number],
  value: string,
) => (option.value === undefined ? option.label.trim() === value.trim() : option.value === value);

/** How each answer value read when it was given, so a later change to the dialog cannot alter it. */
export const quoteUserInputAnswer = (
  question: OrchestrationV2UserInputQuestion,
  answer: unknown,
): ReadonlyArray<UserInputAnswerQuote> => {
  const values =
    typeof answer === "string"
      ? [answer]
      : Array.isArray(answer)
        ? answer.filter((value): value is string => typeof value === "string")
        : [];
  return values.map((value) => {
    const chosen = question.options.filter((option) => choosesOption(option, value));
    if (chosen.length === 1)
      return { kind: "option", label: chosen[0]!.label, description: chosen[0]!.description };
    if (chosen.length > 1 || question.allowCustomAnswer === false) return { kind: "unmatched" };
    const text = value.trim();
    return {
      kind: "text",
      text,
      prefilled: question.initialAnswer !== undefined && question.initialAnswer.trim() === text,
    };
  });
};

export const quoteUserInputAnswers = (
  questions: ReadonlyArray<OrchestrationV2UserInputQuestion>,
  answers: Readonly<Record<string, unknown>>,
) =>
  Object.fromEntries(
    questions.flatMap((question) =>
      Object.hasOwn(answers, question.id)
        ? [[question.id, quoteUserInputAnswer(question, answers[question.id])]]
        : [],
    ),
  );

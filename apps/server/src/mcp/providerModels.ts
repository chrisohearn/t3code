import { OrchestratorMcpFailure, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

export const advertisedModel = (provider: ServerProvider, model: string) =>
  provider.models.find((candidate) => candidate.slug === model) ??
  provider.models.find((candidate) =>
    candidate.aliases?.some((alias) => alias.toLowerCase() === model.toLowerCase()),
  );

/** A provider that lists no models accepts any slug. */
export const requireAdvertisedModel = (provider: ServerProvider, model: string) =>
  provider.models.length > 0 && advertisedModel(provider, model) === undefined
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "model_unavailable",
          message: `Model ${model} is not advertised by provider ${provider.instanceId}. Use one of: ${listChoices(provider.models.map((candidate) => candidate.slug))}.`,
        }),
      )
    : Effect.void;

const MAX_LISTED_CHOICES = 12;

/** Valid values for an error message, capped so a large catalog stays readable. */
export const listChoices = (values: Iterable<string>) => {
  const all = [...new Set(values)];
  if (all.length === 0) return "none";
  const shown = all.slice(0, MAX_LISTED_CHOICES).join(", ");
  return all.length > MAX_LISTED_CHOICES
    ? `${shown}, and ${all.length - MAX_LISTED_CHOICES} more in orchestrator_capabilities`
    : shown;
};

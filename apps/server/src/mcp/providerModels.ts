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
          message: `Model ${model} is not advertised by provider ${provider.instanceId}.`,
        }),
      )
    : Effect.void;

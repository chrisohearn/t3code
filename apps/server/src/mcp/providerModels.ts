import { OrchestratorMcpFailure, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

export const advertisedModel = (provider: ServerProvider, model: string) =>
  provider.models.find((candidate) => candidate.slug === model) ??
  provider.models.find((candidate) =>
    candidate.aliases?.some((alias) => alias.toLowerCase() === model.toLowerCase()),
  );

/** A provider that lists no models accepts any slug. */
const withV = (version: string) => (version.startsWith("v") ? version : `v${version}`);

/** Names advertised slugs to retry with: same last `/` segment first, else a short list. */
const advertisedModelsHint = (
  models: ReadonlyArray<ServerProvider["models"][number]>,
  requested: string,
) => {
  const lastSegment = (slug: string) => slug.slice(slug.lastIndexOf("/") + 1).toLowerCase();
  const wanted = lastSegment(requested);
  const close = models.filter((model) => lastSegment(model.slug) === wanted);
  if (close.length > 0) {
    return `Did you mean ${close
      .slice(0, 12)
      .map((model) => model.slug)
      .join(", ")}?`;
  }
  const listed = models
    .toSorted((a, b) => Number(a.isLegacy ?? false) - Number(b.isLegacy ?? false))
    .slice(0, 12);
  const omitted = models.length - listed.length;
  return `Advertised models: ${listed.map((model) => model.slug).join(", ")}${
    omitted > 0 ? ` and ${omitted} more; orchestrator_capabilities with search finds them` : ""
  }.`;
};

/** A provider that lists no models accepts any slug. */
export const requireAdvertisedModel = (provider: ServerProvider, model: string) => {
  if (provider.models.length === 0 || advertisedModel(provider, model) !== undefined) {
    return Effect.void;
  }
  const updateRequired = provider.updateRequiredModels?.find(
    (candidate) => candidate.slug === model,
  );
  const detectedVersion = provider.installedVersion ?? provider.version;
  return Effect.fail(
    new OrchestratorMcpFailure({
      code: "model_unavailable",
      message:
        updateRequired === undefined
          ? `Model ${model} is not advertised by provider ${provider.instanceId}. ${advertisedModelsHint(provider.models, model)}`
          : `Model ${model} needs provider ${provider.instanceId} at ${withV(updateRequired.minVersion)} or newer, but the detected CLI is ${detectedVersion === null ? "an unknown version" : withV(detectedVersion)}. Ask the user to update it or point the provider's binary path at a newer install.`,
    }),
  );
};

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

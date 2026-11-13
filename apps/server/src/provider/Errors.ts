import * as NodeOS from "node:os";
import * as Schema from "effect/Schema";

export class ProviderInstanceNotFoundError extends Schema.TaggedError<ProviderInstanceNotFoundError>()(
  "ProviderInstanceNotFoundError",
  {
    instanceId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `No provider instance bound to id '${this.instanceId}'`;
  }
}

export { ProviderDriverError } from "@t3tools/provider-core/server/errors";

export class ProviderWorkspaceMissingError extends Schema.TaggedError<ProviderWorkspaceMissingError>()(
  "ProviderWorkspaceMissingError",
  {
    threadId: Schema.String,
    cwd: Schema.String,
  },
) {
  override get message(): string {
    // The system clears these at reboot; a project that must last belongs in a folder that persists.
    const temporary = [NodeOS.tmpdir(), "/tmp", "/var/tmp"].some((directory) =>
      this.cwd.startsWith(`${directory}/`),
    )
      ? "It is under a temporary folder, which the system clears at reboot. "
      : "";
    return `This thread's workspace folder no longer exists or is not a directory: ${this.cwd}. ${temporary}Restore the folder at this path before retrying.`;
  }
}

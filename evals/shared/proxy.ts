// Eval-only helper: it reads the local Codex config through python3 at startup.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

const decodeProxyConfig = Schema.decodeUnknownSync(
  Schema.Union([
    Schema.Struct({ error: Schema.String }),
    Schema.Struct({ url: Schema.String, headers: Schema.Record(Schema.String, Schema.String) }),
  ]),
);

const MISSING_EXIT_CODE = 3;

/** No selected custom provider or vibeproxy fallback is configured. */
export class ProxyConfigMissing extends Schema.TaggedError<ProxyConfigMissing>()(
  "ProxyConfigMissing",
  { message: Schema.String },
) {}
/** Reads the selected custom provider, falling back to vibeproxy, from the selected Codex home. */
export const readProxyConfig = (
  codexHome = process.env.CODEX_HOME ?? NodePath.join(NodeOS.homedir(), ".codex"),
) => {
  const configPath = NodePath.join(codexHome, "config.toml");
  const script = [
    "import json, os, pathlib, sys, tomllib",
    "home = pathlib.Path(sys.argv[1])",
    'path = home / "config.toml"',
    "config = tomllib.loads(path.read_text()) if path.is_file() else {}",
    'providers = config.get("model_providers", {})',
    'configured = config.get("model_provider")',
    'override = os.environ.get("T3CODE_EVAL_MODEL_PROVIDER")',
    'name = override or (configured if configured in providers else "vibeproxy")',
    "if override and name not in providers:",
    '  print(json.dumps({"error": "T3CODE_EVAL_MODEL_PROVIDER names {!r}, but {} has no matching model provider.".format(name, path)}))',
    "  sys.exit(0)",
    "provider = providers.get(name)",
    "if not provider:",
    '  if not override and name == "vibeproxy": sys.exit(3)',
    '  print(json.dumps({"error": "{} has no [model_providers.{}] entry.".format(path, name)}))',
    "  sys.exit(0)",
    'if not provider.get("base_url"):',
    '  print(json.dumps({"error": "[model_providers.{}] in {} has no base_url.".format(name, path)}))',
    "  sys.exit(0)",
    'headers = provider.get("http_headers", {}).copy()',
    'for header, env_name in provider.get("env_http_headers", {}).items():',
    "  value = os.environ.get(env_name)",
    "  if value is None:",
    '    print(json.dumps({"error": "[model_providers.{}] in {} reads header {} from {}, which is not set.".format(name, path, header, env_name)}))',
    "    sys.exit(0)",
    "  headers[header] = value",
    'env_key = provider.get("env_key")',
    'key = os.environ.get(env_key) if env_key else provider.get("experimental_bearer_token")',
    "if env_key and not key:",
    '  print(json.dumps({"error": "[model_providers.{}] in {} reads its key from {}, which is not set.".format(name, path, env_key)}))',
    "  sys.exit(0)",
    'auth_file = home / "auth.json"',
    'if not key and provider.get("requires_openai_auth") and auth_file.is_file():',
    '  key = json.loads(auth_file.read_text()).get("OPENAI_API_KEY")',
    'if not key and provider.get("requires_openai_auth"):',
    '  print(json.dumps({"error": "[model_providers.{}] in {} requires OPENAI_API_KEY in {}.".format(name, path, auth_file)}))',
    "  sys.exit(0)",
    'if key: headers["Authorization"] = "Bearer " + key',
    'print(json.dumps({"url": provider["base_url"].rstrip("/"), "headers": headers}))',
  ].join("\n");
  try {
    const config = decodeProxyConfig(
      JSON.parse(
        NodeChildProcess.execFileSync("python3", ["-c", script, codexHome], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "inherit"],
        }),
      ),
    );
    if ("error" in config) throw new Error(config.error);
    return config;
  } catch (error) {
    if ((error as { status?: unknown }).status !== MISSING_EXIT_CODE) throw error;
    throw new ProxyConfigMissing({
      message: [
        `No [model_providers.vibeproxy] in ${configPath}.`,
        "This eval sends model calls through a CLIProxyAPI provider; configure model_provider and its provider, or set CODEX_HOME to a Codex home with a vibeproxy provider.",
        "Evals are optional and call paid models. CI does not run them. See evals/README.md.",
      ].join("\n"),
    });
  }
};

/** Prints one actionable message instead of a stack trace when no provider is configured. */
export const proxyConfig = () => {
  try {
    return readProxyConfig();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return process.exit(2);
  }
};

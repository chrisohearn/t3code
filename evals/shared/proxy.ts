// Eval-only helper: it reads the local Codex config through python3 at startup.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

// Read credentials into memory only. Python's TOML parser avoids another runner dependency.
const decodeProxyConfig = Schema.decodeUnknownSync(
  Schema.Union([
    Schema.Struct({ error: Schema.String }),
    Schema.Struct({ url: Schema.String, headers: Schema.Record(Schema.String, Schema.String) }),
  ]),
);

const MISSING_EXIT_CODE = 3;

/** No selected custom provider or `vibeproxy` fallback is configured. */
export class ProxyConfigMissing extends Schema.TaggedError<ProxyConfigMissing>()(
  "ProxyConfigMissing",
  { message: Schema.String },
) {}
const isProxyConfigMissing = Schema.is(ProxyConfigMissing);

/** Reads the configured custom provider, falling back to `vibeproxy`, from the selected Codex home. */
export const readProxyConfig = (
  codexHome = process.env.CODEX_HOME ?? NodePath.join(NodeOS.homedir(), ".codex"),
) => {
  const configPath = NodePath.join(codexHome, "config.toml");
  try {
    const config = decodeProxyConfig(
      JSON.parse(
        NodeChildProcess.execFileSync(
          "python3",
          [
            "-c",
            `
import json, os, pathlib, sys, tomllib
home = pathlib.Path(sys.argv[1])
path = home / 'config.toml'
config = tomllib.loads(path.read_text()) if path.is_file() else {}
providers = config.get('model_providers', {})
configured = config.get('model_provider')
name = configured if configured in providers else 'vibeproxy'
p = providers.get(name)
if not p: sys.exit(${MISSING_EXIT_CODE})
def fail(message):
  print(json.dumps({'error': message}))
  sys.exit()
if not p.get('base_url'): fail(f'[model_providers.{name}] in {path} has no base_url.')
h = p.get('http_headers', {}).copy()
h.update({k: os.environ[v] for k,v in p.get('env_http_headers', {}).items()})
key = os.environ.get(p['env_key']) if p.get('env_key') else p.get('experimental_bearer_token')
if p.get('env_key') and not key: fail(f'[model_providers.{name}] in {path} reads its key from {p["env_key"]}, which is not set.')
if not key and p.get('requires_openai_auth') and (home / 'auth.json').is_file(): key = json.loads((home / 'auth.json').read_text()).get('OPENAI_API_KEY')
if key: h['Authorization'] = 'Bearer ' + key
print(json.dumps({'url': p['base_url'].rstrip('/'), 'headers': h}))
`,
            codexHome,
          ],
          { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
        ),
      ),
    );
    if ("error" in config) throw new Error(config.error);
    return config;
  } catch (error) {
    if ((error as { status?: unknown }).status !== MISSING_EXIT_CODE) throw error;
    throw new ProxyConfigMissing({
      message: [
        `No \`[model_providers.vibeproxy]\` in ${configPath}.`,
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
    if (!isProxyConfigMissing(error)) throw error;
    process.stderr.write(`${error.message}\n`);
    return process.exit(2);
  }
};

// Eval-only helper: it reads the local Codex config through python3 at startup.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

// Read credentials into memory only. Python's TOML parser avoids another runner dependency.
const decodeProxyConfig = Schema.decodeUnknownSync(
  Schema.Struct({ url: Schema.String, headers: Schema.Record(Schema.String, Schema.String) }),
);

const MISSING_EXIT_CODE = 3;

/** The `vibeproxy` provider is absent, so no model call can be made. */
export class ProxyConfigMissing extends Schema.TaggedError<ProxyConfigMissing>()(
  "ProxyConfigMissing",
  { message: Schema.String },
) {}
const isProxyConfigMissing = Schema.is(ProxyConfigMissing);

/** Reads the `vibeproxy` CLIProxyAPI provider from `<codexHome>/config.toml`. */
export const readProxyConfig = (
  codexHome = process.env.CODEX_HOME ?? NodePath.join(NodeOS.homedir(), ".codex"),
) => {
  const configPath = NodePath.join(codexHome, "config.toml");
  try {
    return decodeProxyConfig(
      JSON.parse(
        NodeChildProcess.execFileSync(
          "python3",
          [
            "-c",
            `
import json, os, pathlib, sys, tomllib
home = pathlib.Path(sys.argv[1])
config = home / 'config.toml'
p = tomllib.loads(config.read_text()).get('model_providers', {}).get('vibeproxy') if config.is_file() else None
if not p: sys.exit(${MISSING_EXIT_CODE})
h = p.get('http_headers', {}).copy()
h.update({k: os.environ[v] for k,v in p.get('env_http_headers', {}).items()})
key = os.environ[p['env_key']] if p.get('env_key') else p.get('experimental_bearer_token')
if not key and p.get('requires_openai_auth'): key = json.loads((home / 'auth.json').read_text()).get('OPENAI_API_KEY')
if key: h['Authorization'] = 'Bearer ' + key
print(json.dumps({'url': p['base_url'].rstrip('/'), 'headers': h}))
`,
            codexHome,
          ],
          { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
        ),
      ),
    );
  } catch (error) {
    if ((error as { status?: unknown }).status !== MISSING_EXIT_CODE) throw error;
    throw new ProxyConfigMissing({
      message: [
        `No \`[model_providers.vibeproxy]\` in ${configPath}.`,
        "This eval sends model calls through a CLIProxyAPI provider with that name; set one up, or set CODEX_HOME to a Codex home that has it.",
        "Evals are optional and call paid models. CI does not run them. See evals/README.md.",
      ].join("\n"),
    });
  }
};

/** Like `readProxyConfig`, but exits with one message instead of a stack trace when the provider is missing. */
export const proxyConfig = () => {
  try {
    return readProxyConfig();
  } catch (error) {
    if (!isProxyConfigMissing(error)) throw error;
    process.stderr.write(`${error.message}\n`);
    return process.exit(2);
  }
};

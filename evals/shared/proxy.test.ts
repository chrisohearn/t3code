// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { ProxyConfigMissing, readProxyConfig } from "./proxy.ts";

const codexHome = (config: string | undefined, auth?: unknown) => {
  const path = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-eval-proxy-"));
  if (config !== undefined) NodeFS.writeFileSync(NodePath.join(path, "config.toml"), config);
  if (auth !== undefined)
    NodeFS.writeFileSync(NodePath.join(path, "auth.json"), JSON.stringify(auth));
  return { path, [Symbol.dispose]: () => NodeFS.rmSync(path, { recursive: true, force: true }) };
};

const stubEnvs = (...values: ReadonlyArray<readonly [string, string]>) => {
  for (const [name, value] of values) vi.stubEnv(name, value);
  return { [Symbol.dispose]: () => vi.unstubAllEnvs() };
};

describe("readProxyConfig", () => {
  it.each([
    ["no config.toml", undefined],
    ["no model_providers table", 'model = "gpt-6-luna"\n'],
    ["another provider only", '[model_providers.other]\nbase_url = "http://localhost:1"\n'],
  ])("names the missing vibeproxy provider when there is %s", (_name, config) => {
    using home = codexHome(config);
    expect(() => readProxyConfig(home.path)).toThrow(ProxyConfigMissing);
    expect(() => readProxyConfig(home.path)).toThrow(
      `No [model_providers.vibeproxy] in ${NodePath.join(home.path, "config.toml")}.`,
    );
  });

  it("reads the configured provider and its environment-backed headers and key", () => {
    using home = codexHome(
      'model_provider = "vibeproxy"\n[model_providers.vibeproxy]\nbase_url = "http://localhost:8317/v1/"\nenv_key = "EVAL_PROXY_KEY"\nenv_http_headers = { "X-Trace" = "EVAL_TRACE" }\n',
    );
    using _env = stubEnvs(["EVAL_PROXY_KEY", "test-key"], ["EVAL_TRACE", "test-trace"]);
    expect(readProxyConfig(home.path)).toEqual({
      url: "http://localhost:8317/v1",
      headers: { "X-Trace": "test-trace", Authorization: "Bearer test-key" },
    });
  });

  it("uses the explicitly selected provider before model_provider", () => {
    using home = codexHome(
      'model_provider = "vibeproxy"\n[model_providers.vibeproxy]\nbase_url = "http://localhost:8317/v1"\n[model_providers.cliproxy]\nbase_url = "https://proxy.example/v1/"\n',
    );
    using _env = stubEnvs(["T3CODE_EVAL_MODEL_PROVIDER", "cliproxy"]);
    expect(readProxyConfig(home.path)).toEqual({
      url: "https://proxy.example/v1",
      headers: {},
    });
  });

  it.each([
    ["no auth.json", undefined],
    ["a ChatGPT-login auth.json", { OPENAI_API_KEY: null, tokens: { access_token: "test-token" } }],
  ])(
    "requires an API key when the selected provider requires OpenAI auth and has %s",
    (_name, auth) => {
      using home = codexHome(
        'model_provider = "cliproxy"\n[model_providers.cliproxy]\nbase_url = "https://proxy.example/v1"\nrequires_openai_auth = true\n',
        auth,
      );
      expect(() => readProxyConfig(home.path)).toThrow(/requires OPENAI_API_KEY/);
    },
  );

  it("uses OPENAI_API_KEY from auth.json when the provider requires OpenAI auth", () => {
    using home = codexHome(
      'model_provider = "cliproxy"\n[model_providers.cliproxy]\nbase_url = "https://proxy.example/v1"\nrequires_openai_auth = true\n',
      { OPENAI_API_KEY: "test-api-key" },
    );
    expect(readProxyConfig(home.path)).toEqual({
      url: "https://proxy.example/v1",
      headers: { Authorization: "Bearer test-api-key" },
    });
  });

  it("reports an unavailable explicit provider", () => {
    using home = codexHome(
      'model_provider = "vibeproxy"\n[model_providers.vibeproxy]\nbase_url = "http://localhost:8317/v1"\n',
    );
    using _env = stubEnvs(["T3CODE_EVAL_MODEL_PROVIDER", "missing"]);
    expect(() => readProxyConfig(home.path)).toThrow(/no matching model provider/);
  });
});

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { ProxyConfigMissing, readProxyConfig } from "./proxy.ts";

const codexHome = (config: string | undefined) => {
  const path = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-eval-proxy-"));
  if (config !== undefined) NodeFS.writeFileSync(NodePath.join(path, "config.toml"), config);
  return { path, [Symbol.dispose]: () => NodeFS.rmSync(path, { recursive: true, force: true }) };
};

it.each([
  ["no config.toml", undefined],
  ["no model_providers table", 'model = "gpt-6-luna"\n'],
  ["another provider only", '[model_providers.other]\nbase_url = "http://localhost:1"\n'],
])("names the missing provider when there is %s", (_name, config) => {
  using home = codexHome(config);
  expect(() => readProxyConfig(home.path)).toThrow(ProxyConfigMissing);
  expect(() => readProxyConfig(home.path)).toThrow(
    `No \`[model_providers.vibeproxy]\` in ${NodePath.join(home.path, "config.toml")}`,
  );
});

it("reads a configured provider", () => {
  using home = codexHome(
    '[model_providers.vibeproxy]\nbase_url = "http://localhost:8317/v1/"\nexperimental_bearer_token = "test"\n',
  );
  expect(readProxyConfig(home.path)).toEqual({
    url: "http://localhost:8317/v1",
    headers: { Authorization: "Bearer test" },
  });
});

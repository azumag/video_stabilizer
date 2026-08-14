import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = path.join(root, "extension");
const manifest = JSON.parse(await readFile(path.join(extensionRoot, "manifest.json"), "utf8"));

test("manifest references existing local resources", async () => {
  const resources = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...manifest.content_scripts.flatMap((entry) => entry.js ?? []),
    ...manifest.web_accessible_resources.flatMap((entry) => entry.resources ?? []),
  ];

  for (const resource of resources) {
    await access(path.join(extensionRoot, resource));
  }
  assert.equal(new Set(resources).size, resources.length, "manifest resource list should not contain duplicates");
});

test("WASM probe is valid and callable", async () => {
  const bytes = await readFile(path.join(extensionRoot, "wasm", "probe.wasm"));
  assert.equal(WebAssembly.validate(bytes), true);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  assert.equal(instance.exports.add(20, 22), 42);
});

test("extension remains scoped to Twitch and bundles executable resources", () => {
  assert.deepEqual(manifest.host_permissions, ["https://www.twitch.tv/*"]);
  assert.deepEqual(manifest.content_scripts[0].matches, ["https://www.twitch.tv/*"]);
  assert.match(manifest.content_security_policy.extension_pages, /script-src 'self'/);
  assert.match(manifest.content_security_policy.extension_pages, /wasm-unsafe-eval/);
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = path.join(root, "extension");
const manifestPath = path.join(extensionRoot, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

assert.equal(manifest.manifest_version, 3, "Manifest V3 is required");
assert.equal(typeof manifest.version, "string");
assert.ok(manifest.permissions.includes("storage"));
assert.ok(manifest.host_permissions.includes("https://www.twitch.tv/*"));
assert.match(
  manifest.content_security_policy.extension_pages,
  /wasm-unsafe-eval/,
  "WASM must be explicitly allowed for extension pages",
);

const referencedFiles = new Set();
referencedFiles.add(manifest.background.service_worker);
referencedFiles.add(manifest.action.default_popup);
for (const script of manifest.content_scripts ?? []) {
  for (const file of script.js ?? []) referencedFiles.add(file);
  for (const file of script.css ?? []) referencedFiles.add(file);
}
for (const group of manifest.web_accessible_resources ?? []) {
  for (const file of group.resources ?? []) referencedFiles.add(file);
}

const popupHtml = await readFile(path.join(extensionRoot, manifest.action.default_popup), "utf8");
for (const match of popupHtml.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const reference = match[1];
  if (!reference.startsWith("http") && !reference.startsWith("#")) {
    referencedFiles.add(reference);
  }
}

for (const relativePath of referencedFiles) {
  await access(path.join(extensionRoot, relativePath));
}

async function collectJavaScript(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...await collectJavaScript(fullPath));
    } else if (/\.(?:js|mjs)$/.test(entry.name)) {
      result.push(fullPath);
    }
  }
  return result;
}

for (const scriptPath of await collectJavaScript(root)) {
  if (scriptPath.includes(`${path.sep}dist${path.sep}`)) continue;
  execFileSync(process.execPath, ["--check", scriptPath], { stdio: "pipe" });
}

const wasmBytes = await readFile(path.join(extensionRoot, "wasm", "probe.wasm"));
assert.ok(WebAssembly.validate(wasmBytes), "probe.wasm must be a valid WebAssembly module");
const { instance } = await WebAssembly.instantiate(wasmBytes, {});
assert.equal(instance.exports.add(20, 22), 42, "WASM probe must return 42");

const serializedManifest = JSON.stringify(manifest);
assert.doesNotMatch(serializedManifest, /https?:\/\/(?!www\.twitch\.tv)/, "Manifest must not load remote code");

console.log(`Validated ${referencedFiles.size} manifest resources and the WASM probe.`);

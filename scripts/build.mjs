import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "extension");
const outputRoot = path.join(root, "dist");
const output = path.join(outputRoot, "video-stabilizer");

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
await cp(source, output, { recursive: true });
await writeFile(
  path.join(outputRoot, "LOAD_UNPACKED.txt"),
  [
    "Chromeで chrome://extensions を開きます。",
    "デベロッパーモードを有効にします。",
    "「パッケージ化されていない拡張機能を読み込む」で video-stabilizer フォルダを選択します。",
    "Twitchの配信またはVODページを開き、右下のPhase 0診断パネルを確認します。",
    "",
  ].join("\n"),
  "utf8",
);

console.log(`Built unpacked extension: ${path.relative(root, output)}`);

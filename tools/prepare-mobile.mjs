import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webDir = join(root, "www");
const includeFiles = new Set([
  ".nojekyll",
  "characters.html",
  "game.html",
  "index.html",
]);
const includeDirs = new Set(["assets"]);

function copyEntry(name) {
  const from = join(root, name);
  const to = join(webDir, name);
  if (!existsSync(from)) return;
  cpSync(from, to, { recursive: true });
}

rmSync(webDir, { recursive: true, force: true });
mkdirSync(webDir, { recursive: true });

for (const entry of readdirSync(root)) {
  const full = join(root, entry);
  const stats = statSync(full);
  if (stats.isDirectory() && includeDirs.has(entry)) copyEntry(entry);
  if (stats.isFile() && includeFiles.has(entry)) copyEntry(entry);
}

console.log(`Prepared ${basename(webDir)} for Capacitor at ${webDir}`);

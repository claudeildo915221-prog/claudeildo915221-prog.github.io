import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const androidDir = join(root, "android");
const isWindows = process.platform === "win32";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    stdio: "inherit",
    shell: isWindows,
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status || 1);
}

run("node", ["tools/prepare-mobile.mjs"]);

const npx = isWindows ? "npx.cmd" : "npx";
run(npx, ["cap", existsSync(androidDir) ? "sync" : "add", "android"]);

const gradle = isWindows ? "gradlew.bat" : "./gradlew";
run(join(androidDir, gradle), ["assembleDebug"], { cwd: androidDir });

console.log("APK created at android/app/build/outputs/apk/debug/app-debug.apk");

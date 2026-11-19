import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// The daemon runs detached with no console. On Windows, any console program it
// starts without `windowsHide` opens a new visible console window that flashes.
test("every child process started from src/ sets windowsHide", () => {
  const files = readdirSync("src", { recursive: true, encoding: "utf8" }).filter(f => f.endsWith(".mjs"));
  const missing = [];
  for (const file of files) {
    const source = readFileSync(join("src", file), "utf8");
    for (const match of source.matchAll(/\b(spawn|spawnSync|fork|execFile|execFileSync|exec|execSync)\(([^;]*?)\);?$/gm)) {
      // Real calls pass an argument array; this skips regex `.exec(text)` calls.
      if (!match[2].includes("[")) continue;
      if (!match[2].includes("windowsHide: true")) missing.push(`${file}: ${match[0].slice(0, 80)}`);
    }
  }
  assert.deepEqual(missing, []);
});

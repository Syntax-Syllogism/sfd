import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

// sfd loads @salesforce/core, SDR, apex-node and source-tracking from the installed sf CLI,
// so auth files, API versions and metadata registries always match what `sf` itself uses.
export function findSfRoot(env = process.env) {
  if (env.SFD_SF_ROOT) return env.SFD_SF_ROOT;
  const bin = execFileSync("which", ["sf"], { encoding: "utf8" }).trim();
  for (let dir = dirname(realpathSync(bin)); dirname(dir) !== dir; dir = dirname(dir)) {
    try {
      if (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name === "@salesforce/cli") return dir;
    } catch {}
  }
  throw new Error(`Could not locate the @salesforce/cli install behind ${bin}; set SFD_SF_ROOT.`);
}

export function sfInfo(root) {
  const file = join(root, "package.json");
  return { root, version: JSON.parse(readFileSync(file, "utf8")).version, mtimeMs: statSync(file).mtimeMs };
}

export function sfRequire(root) {
  return createRequire(join(root, "package.json"));
}

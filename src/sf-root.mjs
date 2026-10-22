import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

// sfd loads @salesforce/core, SDR, apex-node and source-tracking from the installed sf CLI,
// so auth files, API versions and metadata registries always match what `sf` itself uses.
export function findSfRoot(env = process.env, platform = process.platform) {
  if (env.SFD_SF_ROOT) return env.SFD_SF_ROOT;
  const bin = whichSf(platform);
  for (let dir = dirname(realpathSync(bin)); dirname(dir) !== dir; dir = dirname(dir)) {
    // npm installs on Windows put an sf.cmd shim next to node_modules instead of a symlink.
    for (const candidate of [dir, join(dir, "node_modules", "@salesforce", "cli")]) {
      try {
        if (JSON.parse(readFileSync(join(candidate, "package.json"), "utf8")).name === "@salesforce/cli") return candidate;
      } catch {}
    }
  }
  throw new Error(`Could not locate the @salesforce/cli install behind ${bin}; set SFD_SF_ROOT.`);
}

function whichSf(platform) {
  if (platform !== "win32") return execFileSync("which", ["sf"], { encoding: "utf8" }).trim();
  // `where` lists every match in PATH order; prefer the cmd shim over the extensionless sh script.
  const found = execFileSync("where", ["sf"], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
  return found.find(f => /\.(cmd|exe)$/i.test(f)) ?? found[0];
}

export function sfInfo(root) {
  const file = join(root, "package.json");
  return { root, version: JSON.parse(readFileSync(file, "utf8")).version, mtimeMs: statSync(file).mtimeMs };
}

export function sfRequire(root) {
  return createRequire(join(root, "package.json"));
}

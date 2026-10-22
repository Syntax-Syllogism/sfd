import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

function walkUp(start, test) {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (test(dir)) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

export function findProjectDir(cwd) {
  return walkUp(cwd, dir => existsSync(join(dir, "sfdx-project.json")));
}

function readTargetOrg(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"))["target-org"];
  } catch {
    return undefined;
  }
}

// Same precedence as sf: flag, SF_TARGET_ORG, nearest local .sf/config.json, then global config.
export function resolveTargetOrg(flag, cwd, env = process.env, home = homedir()) {
  if (flag) return flag;
  if (env.SF_TARGET_ORG) return env.SF_TARGET_ORG;
  const local = walkUp(cwd, dir => dir !== home && readTargetOrg(join(dir, ".sf", "config.json")) !== undefined);
  if (local) return readTargetOrg(join(local, ".sf", "config.json"));
  const global = readTargetOrg(join(home, ".sf", "config.json"));
  if (global) return global;
  throw new Error("No target org. Pass -o <alias> or set target-org with `sf config set target-org`.");
}

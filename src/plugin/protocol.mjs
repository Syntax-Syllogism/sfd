// @ts-check
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
/** @param {import('./discover.mjs').PluginInfo[]} plugins */
export function pluginFingerprint(plugins) {
  return createHash("sha1").update(plugins.map(p => {
    let mtime = 0;
    try { mtime = statSync(p.operationsFile).mtimeMs; } catch {}
    return `${p.name}@${p.version}:${p.root}:${mtime}`;
  }).sort().join(",")).digest("hex").slice(0, 8);
}

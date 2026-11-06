// @ts-check
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve, relative, isAbsolute } from "node:path";
import { validateManifest } from "../../packages/sfd-plugin/validate.mjs";
import { VERSION } from "../version.mjs";
/** @typedef {{name: string, version: string, root: string, manifest: import('../../packages/sfd-plugin/index.js').SfdManifest, operationsFile: string, problems: string[]}} PluginInfo */
/** @param {NodeJS.ProcessEnv} [env] @param {string} [platform] */
export function sfDataDir(env = process.env, platform = process.platform) {
  return env.SF_DATA_DIR ?? join(platform === "win32" ? env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local") : env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "sf");
}
/** @param {string} file @returns {any} */
function readJson(file) { return JSON.parse(readFileSync(file, "utf8")); }
/** @param {{env?: NodeJS.ProcessEnv}} [config] @returns {PluginInfo[]} */
export function discoverPlugins({ env = process.env } = {}) {
  const data = sfDataDir(env);
  const roots = (env.SFD_PLUGIN_PATHS ?? "").split(delimiter).filter(Boolean);
  if (env.SFD_PLUGIN_PATHS_ONLY !== "1") {
    try {
      const registry = readJson(join(data, "package.json"));
      roots.push(...Object.keys(registry.dependencies ?? {}).map(name => join(data, "node_modules", name)));
      roots.push(...(registry.oclif?.plugins ?? []).filter((/** @type {any} */ p) => p.root).map((/** @type {any} */ p) => p.root));
    } catch { /* An absent registry means no installed user plugins. */ }
  }
  const seen = new Set();
  const plugins = [];
  for (const candidate of roots) {
    let root, pkg;
    try { root = realpathSync(candidate); pkg = readJson(join(root, "package.json")); } catch { continue; }
    if (seen.has(root)) continue;
    seen.add(root);
    if (!("sfd" in pkg)) continue;
    const problems = validateManifest(pkg.sfd);
    let operationsFile = "";
    if (typeof pkg.sfd?.operations === "string") {
      operationsFile = resolve(root, pkg.sfd.operations);
      try {
        const path = relative(root, realpathSync(operationsFile));
        if (path === ".." || path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(path)) problems.push("operations must stay inside the plugin root");
      } catch { problems.push("operations file is missing"); }
    }
    const range = pkg.sfd?.requires?.sfd;
    if (typeof range === "string") {
      if (!/^>=\d+\.\d+\.\d+$/.test(range)) problems.push("requires.sfd supports only >=x.y.z in v0");
      else {
        const required = range.slice(2).split(".").map(Number);
        /** @type {number[]} */
        const current = VERSION.split(".").map(Number);
        const different = current.findIndex((n, i) => n !== required[i]);
        if (different !== -1 && current[different] < required[different]) problems.push(`requires sfd ${range}; installed ${VERSION}`);
      }
    }
    plugins.push({ name: pkg.name ?? root, version: pkg.version ?? "0.0.0", root, manifest: pkg.sfd, operationsFile, problems });
  }
  return plugins;
}

/** Cache registry discovery, but re-read on installs and package version/manifest edits.
 * @param {{env?: NodeJS.ProcessEnv}} [config]
 */
export function createDiscovery({ env = process.env } = {}) {
  /** @type {PluginInfo[] | undefined} */
  let cached;
  let previous = "";
  const stamp = (/** @type {string} */ path) => {
    try { const stat = statSync(path); return `${stat.mtimeMs}:${stat.size}`; } catch { return "missing"; }
  };
  const signature = () => [env.SFD_PLUGIN_PATHS, env.SFD_PLUGIN_PATHS_ONLY,
    stamp(join(sfDataDir(env), "package.json")),
    ...(cached ?? []).map(p => `${p.root}:${stamp(join(p.root, "package.json"))}`)].join("|");
  return (force = false) => {
    if (force || !cached || signature() !== previous) {
      cached = discoverPlugins({ env });
      previous = signature();
    }
    return cached;
  };
}

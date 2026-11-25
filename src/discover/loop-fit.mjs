import { existsSync, readFileSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { join, resolve } from "node:path";
import { runtimeDirPath } from "../paths.mjs";
import { pluginRoots } from "../plugin/discover.mjs";
import { loadTable } from "../plugin/table-cache.mjs";
import { allMappings } from "../rewrite.mjs";
import { findSfRoot } from "../sf-root.mjs";
import { medianOfSorted } from "./shared.mjs";

export const LOOP_FIT_LIMIT = 15;
const DEFAULT_STARTUP_SECONDS = 3;
const commandId = /^[a-z0-9_][a-z0-9_-]*(?::[a-z0-9_][a-z0-9_-]*)*$/i;

/** @param {string} file @returns {unknown} */
function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {NodeJS.ProcessEnv} env */
function coreRoots(env) {
  let root;
  try { root = resolve(findSfRoot(env)); } catch { return []; }
  const pkg = readJson(join(root, "package.json"));
  if (!isRecord(pkg) || !isRecord(pkg.oclif) || !Array.isArray(pkg.oclif.plugins)) return [root];
  const resolver = createRequire(join(root, "package.json")).resolve;
  const plugins = pkg.oclif.plugins.flatMap(name => {
    if (typeof name !== "string" || isBuiltin(name) || !/^(?:@[\w.-]+\/)?[\w-][\w.-]*$/.test(name)) return [];
    const folder = resolver.paths(name)?.find(dir => existsSync(join(dir, name, "package.json")));
    return folder ? [join(folder, name)] : [];
  });
  return [...plugins, root];
}

/** @param {NodeJS.ProcessEnv} env */
export function loadLoopFitInputs(env) {
  /** @type {Map<string, {id: string, pluginProvides: boolean}>} */
  const commands = new Map();
  /** @type {[string, {id: string, pluginProvides: boolean}][]} */
  const aliases = [];
  for (const root of new Set([...pluginRoots(env), ...coreRoots(env)])) {
    const manifest = readJson(join(root, "oclif.manifest.json"));
    if (!isRecord(manifest) || !isRecord(manifest.commands)) continue;
    const pkg = readJson(join(root, "package.json"));
    const pluginProvides = isRecord(pkg) && Object.hasOwn(pkg, "sfd");
    for (const [id, metadata] of Object.entries(manifest.commands)) {
      if (!commandId.test(id) || commands.has(id)) continue;
      const command = { id, pluginProvides };
      commands.set(id, command);
      if (!isRecord(metadata) || !Array.isArray(metadata.aliases)) continue;
      for (const alias of metadata.aliases) {
        if (typeof alias === "string" && commandId.test(alias)) aliases.push([alias, command]);
      }
    }
  }
  for (const [alias, command] of aliases) {
    if (!commands.has(alias)) commands.set(alias, command);
  }
  let maxDepth = 0;
  for (const id of commands.keys()) maxDepth = Math.max(maxDepth, id.split(":").length);

  const table = loadTable({ env, readOnly: true });
  const covered = new Set(allMappings().map(mapping => mapping.sf.split(" ").join(":")));
  for (const plugin of table.plugins) {
    for (const command of plugin.commands) covered.add((command.sf ?? command.name).join(":"));
  }
  const coveredIds = new Set([...covered].map(id => commands.get(id)?.id ?? id));
  const measurements = readJson(join(runtimeDirPath(env), "measurements.json"));
  return { commands, coveredIds, maxDepth, measurements: isRecord(measurements) ? measurements : {} };
}

/**
 * @param {string[]} argv
 * @param {Omit<ReturnType<typeof loadLoopFitInputs>, "measurements">} catalog
 */
export function matchCommandId(argv, { commands, maxDepth }) {
  let prefix = "";
  let id;
  for (const word of argv.slice(0, maxDepth)) {
    if (!commandId.test(word)) break;
    prefix = prefix ? `${prefix}:${word}` : word;
    id = commands.get(prefix)?.id ?? id;
  }
  return id;
}

/**
 * @param {Map<string, Map<string, number>>} counts
 * @param {ReturnType<typeof loadLoopFitInputs>["commands"]} commands
 * @param {Record<string, unknown>} measurements
 */
export function rankLoopFit(counts, commands, measurements) {
  const rows = [];
  for (const [commandId, bySession] of counts) {
    const repeats = [...bySession.values()].sort((a, b) => a - b);
    const sessions = repeats.length;
    const calls = repeats.reduce((total, count) => total + count, 0);
    const medianRepeatsPerSession = medianOfSorted(repeats) ?? 0;
    const measured = measurements[commandId];
    const startupSeconds = typeof measured === "number" && Number.isFinite(measured) && measured >= 0
      ? measured : DEFAULT_STARTUP_SECONDS;
    rows.push({
      commandId, sessions, calls, medianRepeatsPerSession,
      p90RepeatsPerSession: repeats[Math.ceil(sessions * 0.9) - 1],
      startupSeconds, estimatedStartupSeconds: calls * startupSeconds,
      pluginProvides: commands.get(commandId)?.pluginProvides ?? false,
      score: medianRepeatsPerSession * sessions * startupSeconds
    });
  }
  return rows.sort((a, b) => b.score - a.score || a.commandId.localeCompare(b.commandId));
}

/** @param {ReturnType<typeof rankLoopFit>} rows @param {boolean} all */
export function formatLoopFit(rows, all) {
  const visible = all ? rows : rows.slice(0, LOOP_FIT_LIMIT);
  if (!visible.length) return ["Loop fit (unported sf commands)", "  (none)"];
  const cells = [
    ["Command", "Sessions", "Calls", "Median", "P90", "Startup s/call", "Total startup s", "sfd plugin", "Score"],
    ...visible.map(row => [
      row.commandId, row.sessions, row.calls, row.medianRepeatsPerSession, row.p90RepeatsPerSession,
      row.startupSeconds, row.estimatedStartupSeconds, row.pluginProvides ? "yes" : "no", row.score
    ].map(value => typeof value === "number" ? String(Number(value.toPrecision(8))) : value))
  ];
  const widths = cells[0].map((_, col) => Math.max(...cells.map(row => row[col].length)));
  const lines = cells.map(row => `  ${row.map((cell, col) => col === 0 ? cell.padEnd(widths[col]) : cell.padStart(widths[col])).join("  ")}`);
  if (visible.length < rows.length) lines.push(`  Showing ${visible.length} of ${rows.length}. Use --all to show every row.`);
  return ["Loop fit (unported sf commands)", ...lines];
}

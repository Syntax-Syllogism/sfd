import { readFileSync, statSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { discoverPlugins, sfDataDir } from "./discover.mjs";
import { paths } from "../paths.mjs";
import { validateCliTable } from "../../packages/sfd-plugin/validate.mjs";
import { containedPath, mergeTables } from "./cli-table.mjs";

/** @param {string} file @returns {any} */
const read = file => JSON.parse(readFileSync(file, "utf8"));
/** @param {string} file */
const stamp = file => { try { const s = statSync(file); return `${s.mtimeMs}:${s.ctimeMs}:${s.size}`; } catch { return "missing"; } };
/**
 * @param {any[]} plugins
 * @param {NodeJS.ProcessEnv} env
 */
function keyFor(plugins, env) {
  return createHash("sha1").update(JSON.stringify([env.SFD_PLUGIN_PATHS, env.SFD_PLUGIN_PATHS_ONLY, sfDataDir(env),
    stamp(join(sfDataDir(env), "package.json")), ...plugins.map(p => [p.root,
      stamp(join(p.root, "package.json")), stamp(p.operationsFile), stamp(join(p.root, p.cli ?? p.manifest?.cli ?? "cli.json"))])])).digest("hex");
}
/**
 * @param {string} file
 * @param {unknown} table
 */
function writeCache(file, table) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, JSON.stringify(table), { mode: 0o600 }); renameSync(temporary, file); }
  finally { try { unlinkSync(temporary); } catch {} }
}

// The warm path stats known inputs and never imports plugin modules or starts workers.
export function loadTable({ env = process.env } = {}) {
  let file, cached;
  try {
    file = join(paths(env).dir, "plugin-table.json");
    cached = read(file);
    if (Array.isArray(cached.plugins) && cached.plugins.every((/** @type {any} */ p) => Array.isArray(p.commands) && !validateCliTable({ apiVersion: 0, commands: p.commands }).length) && cached.key === keyFor(cached.plugins, env)) return cached;
  } catch { /* Missing/corrupt cache is rebuilt below. */ }
  const plugins = discoverPlugins({ env }).map(plugin => {
    const entry = { name: plugin.name, root: plugin.root, operationsFile: plugin.operationsFile,
      cli: plugin.manifest?.cli, commands: /** @type {any[]} */ ([]), problems: [...plugin.problems] };
    if (!entry.cli || entry.problems.length) return entry;
    try {
      const table = read(containedPath(plugin.root, entry.cli));
      entry.problems.push(...validateCliTable(table));
      // Effects come only from worker descriptors (refreshTableMetadata), never from static cli.json.
      if (!entry.problems.some(p => !p.startsWith("warning: "))) entry.commands = table.commands.map((/** @type {any} */ { effects, ...command }) => command);
    } catch (error) { entry.problems.push(`Invalid cli.json: ${/** @type {Error} */ (error).message}`); }
    return entry;
  });
  const table = { key: keyFor(plugins, env), plugins: mergeTables(plugins) };
  try { if (file) writeCache(file, table); } catch { /* Read-only runtime: use the in-memory table. */ }
  return table;
}

// Called with descriptors obtained in isolated workers, never by the hook.
/**
 * @param {any[]} plugins
 * @param {NodeJS.ProcessEnv} [env]
 */
export function refreshTableMetadata(plugins, env = process.env) {
  const table = loadTable({ env });
  for (const entry of table.plugins) {
    const plugin = plugins.find(p => p.root === entry.root);
    if (!plugin) continue;
    const problems = validateCliTable({ apiVersion: 0, commands: entry.commands }, plugin.operations.map((/** @type {any} */ op) => ({ ...op, optionsSchema: op.optionKeys ? { shape: Object.fromEntries(op.optionKeys.map((/** @type {string} */ key) => [key, true])) } : op.optionsSchema })));
    entry.problems = [...new Set([...entry.problems, ...problems])];
    plugin.problems = [...new Set([...plugin.problems, ...entry.problems])];
    if (problems.some(p => !p.startsWith("warning: "))) entry.commands = [];
    else entry.commands = entry.commands.map((/** @type {any} */ command) => {
      const descriptor = plugin.operations.find((/** @type {any} */ op) => op.id === command.operation);
      return { ...command, summary: descriptor?.summary ?? command.summary, effects: descriptor?.effects };
    });
  }
  try { writeCache(join(paths(env).dir, "plugin-table.json"), table); } catch {}
  return table;
}

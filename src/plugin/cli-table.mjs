import { parseArgs } from "node:util";
import { resolve, relative, isAbsolute } from "node:path";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { COMMANDS } from "../commands.mjs";
import { toCsv } from "../format.mjs";
import { UsageError } from "../usage-error.mjs";

/** @param {{plugins: any[]}} [table] */
export function pluginCommands(table = { plugins: [] }) {
  return table.plugins.flatMap(plugin => plugin.commands.map((/** @type {any} */ command) => ({
    ...command, name: command.name.join(" "), args: "[flags]", plugin: plugin.name, root: plugin.root
  })));
}

/** @param {any[]} plugins */
export function mergeTables(plugins) {
  const owners = new Map(COMMANDS.map(c => [c.name.split(" ")[0], "built-in"]));
  return plugins.map(plugin => {
    const problems = [...(plugin.problems ?? [])];
    const commands = plugin.commands.filter((/** @type {any} */ command) => {
      const name = command.name.join(" ");
      const owner = owners.get(command.name[0]) ?? owners.get(name);
      if (owner) { problems.push(`Command ${name} conflicts with ${owner}`); return false; }
      owners.set(name, plugin.name);
      return true;
    });
    return { ...plugin, commands, problems };
  });
}

/**
 * @param {string[]} argv
 * @param {{plugins: any[]}} [table]
 */
export function matchCommand(argv, table) {
  return pluginCommands(table).sort((a, b) => b.name.split(" ").length - a.name.split(" ").length)
    .find(command => command.name.split(" ").every((/** @type {string} */ word, /** @type {number} */ index) => argv[index] === word));
}

/**
 * @param {string[]} argv
 * @param {any} command
 * @param {string} [cwd]
 * @returns {{ values: Record<string, any>, options: Record<string, unknown> }}
 */
export function parseCommand(argv, command, cwd = process.cwd()) {
  /** @type {Record<string, any>} */
  const options = Object.fromEntries(command.flags.map((/** @type {any} */ flag) => [flag.name, {
    type: flag.type === "boolean" ? "boolean" : "string", ...(flag.char ? { short: flag.char } : {}), multiple: flag.multiple ?? false
  }]));
  Object.assign(options, { "target-org": { type: "string", short: "o" }, "api-version": { type: "string" },
    confirm: { type: "string" }, json: { type: "boolean" }, plan: { type: "boolean" }, quiet: { type: "boolean" }, help: { type: "boolean", short: "h" } });
  const { values, positionals } = parseArgs({ args: argv.slice(command.name.split(" ").length), options, allowPositionals: true });
  if (positionals.length) throw new UsageError("Plugin command does not accept positional arguments.");
  /** @type {Record<string, unknown>} */
  const parsed = {};
  for (const flag of command.flags) {
    const value = values[flag.name];
    if (value === undefined) {
      if (flag.required && !values.help) throw new UsageError(`Missing required --${flag.name}.`);
      continue;
    }
    const convert = (/** @type {any} */ value) => {
      if (flag.type === "integer") {
        if (!String(value).trim() || !Number.isSafeInteger(Number(value))) throw new UsageError(`--${flag.name} must be an integer.`);
        return Number(value);
      }
      return ["file", "directory"].includes(flag.type) ? resolve(cwd, value) : value;
    };
    if (flag.option) Object.defineProperty(parsed, flag.option, { value: Array.isArray(value) ? value.map(convert) : convert(value), enumerable: true });
  }
  return { values, options: parsed };
}

/** @param {any} command */
export function pluginManual(command) {
  return [`sfd ${command.name} [flags]`, command.summary, `Effects: ${(command.effects ?? []).join(", ") || "see sfd plugin list"}`,
    ...command.flags.map((/** @type {any} */ f) => `  ${f.char ? `-${f.char}, ` : ""}--${f.name}${f.type === "boolean" ? "" : ` <${f.type}>`}${f.required ? " (required)" : ""}`),
    "  -o, --target-org <alias>", "  --api-version <version>", "  --confirm <hash>", "  --json  --plan  --quiet  -h, --help", command.docs ?? ""].filter(Boolean).join("\n");
}

/**
 * @param {string} root
 * @param {string} file
 */
export function containedPath(root, file) {
  const target = realpathSync(resolve(root, file));
  const path = relative(realpathSync(root), target);
  if (path === ".." || path.startsWith("../") || path.startsWith("..\\") || isAbsolute(path)) throw new Error("Plugin file must stay inside plugin root");
  return target;
}

/**
 * @param {any} data
 * @param {any} command
 */
export async function formatPlugin(data, command) {
  if (typeof command.formatter === "object") {
    const mod = await import(pathToFileURL(containedPath(command.root, command.formatter.module)).href);
    if (typeof mod.default !== "function") throw new Error("Formatter must export a default function");
    const output = mod.default(data, { columns: undefined });
    if (typeof output !== "string") throw new Error("Formatter must return a string");
    return output;
  }
  const rows = Array.isArray(data) ? data : data?.items;
  if (command.formatter === "csv") return toCsv(rows ?? [data]);
  if (command.formatter === "table" && rows?.length) {
    const columns = Object.keys(rows[0]);
    /** @type {string[][]} */
    const cells = [columns, ...rows.map((/** @type {any} */ row) => columns.map(key => String(row[key] ?? "")))];
    const widths = columns.map((_, i) => Math.max(...cells.map(row => row[i].length)));
    return cells.map(row => row.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd()).join("\n");
  }
  if (command.formatter === "summary" && typeof data?.summary === "string") return data.summary;
  return JSON.stringify(data, null, command.formatter === "json" ? 2 : 0) ?? "null";
}

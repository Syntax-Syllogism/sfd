import { split } from "../shell.mjs";
import { homedir } from "node:os";
import { basename } from "node:path";
import { rewrite, lex } from "../rewrite.mjs";
import { read as claude } from "./claude.mjs";
import { read as codex } from "./codex.mjs";
import { read as gemini } from "./gemini.mjs";
import { UsageError } from "../usage-error.mjs";
import { Worker } from "node:worker_threads";
import { COMMANDS } from "../commands.mjs";
import { formatLoopFit, loadLoopFitInputs, matchCommandId, rankLoopFit } from "./loop-fit.mjs";
import { medianOfSorted } from "./shared.mjs";

const readers = { claude, codex, gemini };
// Only known command paths may enter the report; trailing words can be private values.
const sfPaths = [
  "org list metadata-types", "org list metadata", "org list", "org display",
  "org create scratch", "org create sandbox", "org login web", "org login jwt",
  "apex list log", "apex get log", "apex run test", "apex run", "data query",
  "project retrieve start", "project deploy start", "sobject describe", "api request rest",
  "plugins"
];
/** @type {Record<string, string[]>} */
const commandPaths = {
  sf: sfPaths,
  sfdx: [...sfPaths, "force:org:list", "force:org:display", "force:data:soql:query",
    "force:apex:execute", "force:apex:test:run", "force:source:deploy", "force:source:retrieve"],
  sfd: COMMANDS.flatMap(({ name }) => name.split(" | "))
};

/** @param {string[]} words */
function subcommandName([executable, ...args]) {
  if (!args.length || args[0].startsWith("-")) return "(no subcommand)";
  const matches = commandPaths[executable].filter(path =>
    path.split(" ").every((word, index) => args[index] === word));
  return matches.sort((a, b) => b.split(" ").length - a.split(" ").length)[0]
    ?? "(unrecognized subcommand)";
}

/**
 * @param {{ since?: string, agent?: string[], top?: string | number, project?: string }} values
 * @param {number} [now]
 */
export function discoverOptions(values, now = Date.now()) {
  const window = values.since ?? "30d";
  if (!/^\d+[dh]$/.test(window)) throw new UsageError("--since must be a duration such as 30d or 12h.");
  const since = new Date(now - Number(window.slice(0, -1)) * (window.endsWith("d") ? 86400000 : 3600000));
  if (!Number.isFinite(+since)) throw new UsageError("--since is too large.");
  const agents = [...new Set(values.agent ?? Object.keys(readers))];
  if (agents.some(agent => !Object.hasOwn(readers, agent))) throw new UsageError("--agent must be claude, codex or gemini.");
  const top = Number(values.top ?? 10);
  if (!Number.isSafeInteger(top) || top <= 0) throw new UsageError("--top must be a positive integer.");
  return { since, window, agents, top, project: values.project };
}

/**
 * @param {string} command
 * @returns {string[][]}
 */
function invocations(command) {
  const parsed = split(command);
  if (!parsed.skip) {
    /** @type {string[][]} */
    const found = [];
    for (const segment of parsed.segments) for (const element of segment.elements) {
      const text = command.slice(element.start, element.end);
      const match = /^\s*(?:(?:\w+=(?:'[^']*'|"[^"]*"|\S+)|env|rtk|proxy|command)\s+)*(sf|sfd|sfdx)(?=\s|$)(.*)/s.exec(text);
      if (!match) continue;
      let words;
      try { words = lex(match[2]).filter(token => !token.op).map(token => token.value); }
      catch { words = match[2].trim().split(/\s+/); }
      found.push([match[1], ...words]);
    }
    if (found.length) return found;
  }
  let tokens;
  try { tokens = lex(command); }
  catch {
    // The rewriter will retain its exact syntax/expansion skip reason.
    const match = /^(?:\s*cd\s+\S+\s*&&)?\s*((?:\w+=\S+\s+)*)(sf|sfd|sfdx)\b(.*)/s.exec(command);
    return match ? [[match[2], ...match[3].trim().split(/\s+/)]] : [];
  }
  /** @type {string[][]} */
  const found = [];
  let start = true;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.op) { start = ["&&", "||", ";", "|", "\n", "&"].includes(token.op); continue; }
    if (!start) continue;
    if (/^\w+=/.test(token.value) || ["env", "rtk", "proxy", "command"].includes(token.value)) continue;
    start = false;
    if (["sf", "sfd", "sfdx"].includes(basename(token.value))) {
      const words = [basename(token.value)];
      for (let j = i + 1; j < tokens.length && !tokens[j].op; j++) words.push(tokens[j].value);
      found.push(words);
    }
  }
  return found;
}

/** @param {string} reason */
function reportReason(reason) {
  if (reason.startsWith("unsupported result format ")) return "unsupported result format";
  const flagReason = /^(unsupported flag|duplicate flag|missing value for|unsupported value for|unsupported boolean value) (.*)$/s.exec(reason);
  if (!flagReason) return reason;
  const flag = flagReason[2].split("=")[0];
  return `${flagReason[1]}${/^(?:--[A-Za-z][A-Za-z0-9-]*|-[A-Za-z])$/.test(flag) ? ` ${flag}` : ""}`;
}

/** @param {string} command */
export function classify(command) {
  return classifyInvocation(command, invocations(command));
}

/** @param {string} command @param {string[][]} found */
function classifyInvocation(command, found) {
  const words = found.find(words => words[0] !== "sfd") ?? found[0];
  if (!words) return;
  const subcommand = subcommandName(words);
  if (words[0] === "sfd") return { classification: "adopted", subcommand };
  if (words[0] === "sfdx" && words[1]?.startsWith("force:")) return { classification: "legacy", subcommand };
  const result = rewrite(command);
  if (result.command) return { classification: "rewritable", subcommand };
  if (result.skip === "unsupported sf command") return { classification: "unsupported", subcommand };
  return { classification: "skipped", subcommand, reason: reportReason(result.skip) };
}

/** @param {string} command @param {Parameters<typeof matchCommandId>[1]} catalog */
export function observe(command, catalog) {
  const found = invocations(command);
  const classification = classifyInvocation(command, found);
  if (!classification) return;
  const commandIds = found.flatMap(([executable, ...args]) => {
    const id = executable === "sf" ? matchCommandId(args, catalog) : undefined;
    return id && !catalog.coveredIds.has(id) ? [id] : [];
  });
  return { classification, commandIds };
}

const median = (/** @type {number[]} */ values) => medianOfSorted(values.sort((a, b) => a - b));
const ranked = (/** @type {Map<string, number>} */ map) => [...map].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

/**
 * @param {string} agent
 * @param {object} options
 * @returns {Promise<{ observations: any[], stats: Record<string, number> }>}
 */
function scanAgent(agent, options) {
  // Independent JSON parsers keep large agent histories off one CPU core.
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./worker.mjs", import.meta.url), { workerData: { agent, ...options } });
    /** @type {any} */
    let result;
    worker.on("message", message => { result = message; });
    worker.on("error", reject);
    worker.on("exit", code => {
      if (code !== 0 || !result) reject(new Error(`Discover ${agent} reader exited with code ${code}`));
      else resolve(result);
    });
  });
}

/**
 * @param {{ home?: string, agents?: string[], since?: Date, window?: string, project?: string, top?: number, env?: NodeJS.ProcessEnv }} [options]
 */
export async function discover({ home = homedir(), agents = Object.keys(readers), since = new Date(0), window = "all history", project, top = 10, env = process.env } = {}) {
  /** @type {Record<string, any>} */
  const report = {
    since: since.toISOString(), window, agents, project: project ?? null, top,
    sfCalls: 0, sessions: 0,
    counts: { rewritable: 0, skipped: 0, unsupported: 0, legacy: 0, adopted: 0 },
    estimates: { timeSavedMs: 0, durationSamples: 0, outputChars: 0, outputSamples: 0, outputTokens: 0 },
    diagnostics: { malformedEntries: 0, ignoredEntries: 0, unreadableFiles: 0 }
  };
  const sessions = new Set(), groups = new Map(), reasons = new Map(), unsupported = new Map(), rewritable = new Map();
  /** @type {Map<string, Map<string, number>>} */
  const callsByCommand = new Map();
  const { measurements, ...catalog } = loadLoopFitInputs(env);
  const scans = await Promise.all(agents.map(agent => scanAgent(agent, { home, since, project, catalog })));
  for (const { observations, stats } of scans) {
    for (const [key, value] of Object.entries(stats)) report.diagnostics[key] += value;
    for (const record of observations) {
      const classification = record.classification;
      const { classification: kind, subcommand, reason } = classification;
      report.counts[kind]++;
      if (kind !== "adopted") report.sfCalls++;
      const session = `${record.agent}:${record.session}`;
      sessions.add(session);
      for (const commandId of record.commandIds) {
        const bySession = callsByCommand.get(commandId) ?? new Map();
        bySession.set(session, (bySession.get(session) ?? 0) + 1);
        callsByCommand.set(commandId, bySession);
      }
      const key = JSON.stringify([kind, subcommand, reason]);
      if (!groups.has(key)) groups.set(key, { ...classification, count: 0, durations: [], sizes: [] });
      const group = groups.get(key);
      group.count++;
      if (record.durationMs !== undefined) group.durations.push(record.durationMs);
      if (record.outputChars !== undefined) group.sizes.push(record.outputChars);
      if (kind === "rewritable") {
        rewritable.set(subcommand, (rewritable.get(subcommand) ?? 0) + 1);
        if (record.durationMs !== undefined) {
          report.estimates.durationSamples++;
          report.estimates.timeSavedMs += Math.max(0, record.durationMs - 300);
        }
        if (record.outputChars !== undefined) {
          report.estimates.outputSamples++;
          report.estimates.outputChars += record.outputChars;
        }
      } else if (kind === "skipped") reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      else if (["unsupported", "legacy"].includes(kind)) unsupported.set(subcommand, (unsupported.get(subcommand) ?? 0) + 1);
    }
  }
  report.sessions = sessions.size;
  report.estimates.outputTokens = report.estimates.outputChars / 4;
  report.commands = [...groups.values()].map(({ durations, sizes, ...group }) => ({
    ...group, medianDurationMs: median(durations), durationSamples: durations.length,
    medianOutputChars: median(sizes), medianOutputTokens: sizes.length ? median(sizes) / 4 : null, outputSamples: sizes.length
  })).sort((a, b) => b.count - a.count || a.subcommand.localeCompare(b.subcommand));
  report.skipReasons = ranked(reasons);
  report.unsupported = ranked(unsupported);
  report.rewritable = ranked(rewritable);
  report.loopFit = rankLoopFit(callsByCommand, catalog.commands, measurements);
  return report;
}

/** @param {Record<string, any>} report @param {{all?: boolean}} [options] */
export function formatReport(report, { all = false } = {}) {
  const list = (/** @type {{ name: string, count: number }[]} */ items) => items.slice(0, report.top).map(item => `${item.name} ${item.count}`).join(" · ") || "(none)";
  const { counts: c, estimates: e, diagnostics: d } = report;
  const time = e.durationSamples ? `~${(e.timeSavedMs / 60000).toFixed(1)} min saved (${e.durationSamples} samples)` : "time unknown";
  const output = e.outputSamples ? `~${Math.round(e.outputTokens)} output tokens (${e.outputSamples} samples)` : "output unknown";
  return [
    `sfd discover: ${report.window}, ${report.agents.length} agents, ${report.sfCalls} sf/sfdx calls in ${report.sessions} sessions`,
    `  rewritable now  ${c.rewritable}  (${time}; ${output})`,
    `  skipped         ${c.skipped}  ${list(report.skipReasons)}`,
    `  not in sfd      ${c.unsupported + c.legacy}  ${list(report.unsupported)} (legacy ${c.legacy})`,
    `  already sfd     ${c.adopted}`,
    `Top rewritable: ${list(report.rewritable)}`,
    `Scan: ${d.malformedEntries} malformed, ${d.ignoredEntries} ignored entries, ${d.unreadableFiles} unreadable files.`,
    "Durations include permission wait; savings assume 0.3 s/call. Tokens are chars/4.",
    "Output tokens are potential savings before sfd output, which is not measured. Missing samples are not extrapolated.",
    "Adoption counts each shell tool call once, using the first sf/sfdx invocation in compound calls.",
    "",
    ...formatLoopFit(report.loopFit, all)
  ].join("\n");
}

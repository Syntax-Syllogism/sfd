import { homedir } from "node:os";
import { basename } from "node:path";
import { rewrite, lex } from "../rewrite.mjs";
import { read as claude } from "./claude.mjs";
import { read as codex } from "./codex.mjs";
import { read as gemini } from "./gemini.mjs";
import { UsageError } from "../usage-error.mjs";
import { Worker } from "node:worker_threads";
import { COMMANDS } from "../commands.mjs";

const readers = { claude, codex, gemini };
// Only known command paths may enter the report; trailing words can be private values.
const sfPaths = [
  "org list metadata-types", "org list metadata", "org list", "org display",
  "org create scratch", "org create sandbox", "org login web", "org login jwt",
  "apex list log", "apex get log", "apex run test", "apex run", "data query",
  "project retrieve start", "project deploy start", "sobject describe", "api request rest",
  "plugins"
];
const commandPaths = {
  sf: sfPaths,
  sfdx: [...sfPaths, "force:org:list", "force:org:display", "force:data:soql:query",
    "force:apex:execute", "force:apex:test:run", "force:source:deploy", "force:source:retrieve"],
  sfd: COMMANDS.flatMap(({ name }) => name.split(" | "))
};

function subcommandName([executable, ...args]) {
  if (!args.length || args[0].startsWith("-")) return "(no subcommand)";
  const matches = commandPaths[executable].filter(path =>
    path.split(" ").every((word, index) => args[index] === word));
  return matches.sort((a, b) => b.split(" ").length - a.split(" ").length)[0]
    ?? "(unrecognized subcommand)";
}

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

function invocation(command) {
  let tokens;
  try { tokens = lex(command); }
  catch {
    // The rewriter will retain its exact syntax/expansion skip reason.
    const match = /^(?:\s*cd\s+\S+\s*&&)?\s*((?:\w+=\S+\s+)*)(sf|sfd|sfdx)\b(.*)/s.exec(command);
    return match ? [match[2], ...match[3].trim().split(/\s+/)] : undefined;
  }
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
  return found.find(words => words[0] !== "sfd") ?? found[0];
}

function reportReason(reason) {
  if (reason.startsWith("unsupported result format ")) return "unsupported result format";
  const flagReason = /^(unsupported flag|duplicate flag|missing value for|unsupported value for|unsupported boolean value) (.*)$/s.exec(reason);
  if (!flagReason) return reason;
  const flag = flagReason[2].split("=")[0];
  return `${flagReason[1]}${/^(?:--[A-Za-z][A-Za-z0-9-]*|-[A-Za-z])$/.test(flag) ? ` ${flag}` : ""}`;
}

export function classify(command) {
  const words = invocation(command);
  if (!words) return;
  const subcommand = subcommandName(words);
  if (words[0] === "sfd") return { classification: "adopted", subcommand };
  if (words[0] === "sfdx" && words[1]?.startsWith("force:")) return { classification: "legacy", subcommand };
  const result = rewrite(command);
  if (result.command) return { classification: "rewritable", subcommand };
  if (result.skip === "unsupported sf command") return { classification: "unsupported", subcommand };
  return { classification: "skipped", subcommand, reason: reportReason(result.skip) };
}

const median = values => {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
};
const ranked = map => [...map].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

function scanAgent(agent, options) {
  // Independent JSON parsers keep large agent histories off one CPU core.
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./worker.mjs", import.meta.url), { workerData: { agent, ...options } });
    let result;
    worker.on("message", message => { result = message; });
    worker.on("error", reject);
    worker.on("exit", code => {
      if (code !== 0 || !result) reject(new Error(`Discover ${agent} reader exited with code ${code}`));
      else resolve(result);
    });
  });
}

export async function discover({ home = homedir(), agents = Object.keys(readers), since = new Date(0), window = "all history", project, top = 10 } = {}) {
  const report = {
    since: since.toISOString(), window, agents, project: project ?? null, top,
    sfCalls: 0, sessions: 0,
    counts: { rewritable: 0, skipped: 0, unsupported: 0, legacy: 0, adopted: 0 },
    estimates: { timeSavedMs: 0, durationSamples: 0, outputChars: 0, outputSamples: 0, outputTokens: 0 },
    diagnostics: { malformedEntries: 0, ignoredEntries: 0, unreadableFiles: 0 }
  };
  const sessions = new Set(), groups = new Map(), reasons = new Map(), unsupported = new Map(), rewritable = new Map();
  const scans = await Promise.all(agents.map(agent => scanAgent(agent, { home, since, project })));
  for (const { observations, stats } of scans) {
    for (const [key, value] of Object.entries(stats)) report.diagnostics[key] += value;
    for (const record of observations) {
      const classification = record.classification;
      const { classification: kind, subcommand, reason } = classification;
      report.counts[kind]++;
      if (kind !== "adopted") report.sfCalls++;
      sessions.add(`${record.agent}:${record.session}`);
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
  return report;
}

export function formatReport(report) {
  const list = items => items.slice(0, report.top).map(item => `${item.name} ${item.count}`).join(" · ") || "(none)";
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
    "Counts classify shell tool calls once; compound calls use the first sf/sfdx invocation."
  ].join("\n");
}

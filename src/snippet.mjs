import { COMMANDS } from "./commands.mjs";

const START = "<!-- sfd:start -->";
const END = "<!-- sfd:end -->";

/** @param {{ plugins: any[] }} [table] */
export function snippet(table) {
  /** @type {string[]} */
  const lines = [];
  let previousGroup;
  for (const { name, args, summary, agentTip, agentGroup } of COMMANDS.filter(command => command.name !== "help")) {
    const tip = agentTip ?? `${args}: ${summary.replaceAll("\n", " ")}`;
    const separator = tip.indexOf(": ");
    if (separator === -1) throw new Error(`Invalid agentTip for ${name}: expected ": " separator`);
    const invocation = ["sfd", name, tip.slice(0, separator).trim()].filter(Boolean).join(" ");
    const entry = `\`${invocation}\`: ${tip.slice(separator + 2)}`;
    if (agentGroup && agentGroup === previousGroup) lines[lines.length - 1] += `; ${entry}`;
    else lines.push(`- ${entry}`);
    previousGroup = agentGroup;
  }
  const plugins = [];
  let count = 0;
  for (const plugin of [...(table?.plugins ?? [])].sort((a, b) => a.name.localeCompare(b.name))) {
    const limit = Math.min(6, 20 - count);
    const shown = plugin.commands.slice(0, limit);
    for (const command of shown) {
      const tip = command.agentTip?.includes(": ") ? command.agentTip : `: ${command.summary.replaceAll("\n", " ")}`;
      const separator = tip.indexOf(": ");
      plugins.push(`- \`sfd ${command.name.join(" ")}${separator > 0 ? ` ${tip.slice(0, separator)}` : ""}\`: ${separator >= 0 ? tip.slice(separator + 2) : tip}`);
    }
    count += shown.length;
    if (plugin.commands.length > shown.length) plugins.push(`- \`sfd help ${plugin.commands[0].name[0]}\`: ${plugin.commands.length - shown.length} more commands`);
  }
  return [
    START,
    'Prefer `sfd` (warm Salesforce daemon, ~0.2 s/call, compact output) over `sf`:',
    ...lines,
    ...(plugins.length ? ["Plugins (via sfd):", ...plugins] : []),
    'Run `sfd help <command>` for full documentation. Add `-o <alias>` as with `sf`. Exit: 0 ok, 1 operation failed, 2 usage, 3 daemon. For anything else use `sf … --json`; pipe through `jq` for a few fields.',
    END
  ].join("\n");
}

/**
 * @param {string} text
 * @param {string} block
 */
export function upsertSnippet(text, block) {
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start === -1 && end === -1) {
    const prefix = text.replace(/\s+$/, "");
    return `${prefix ? `${prefix}\n\n` : ""}${block}\n`;
  }
  if (end === -1) throw new Error("found start marker without end");
  if (start === -1) throw new Error("found end marker without start");
  if (end < start) throw new Error("end marker precedes start marker");
  if (text.indexOf(START, start + START.length) !== -1 || text.indexOf(END, end + END.length) !== -1) {
    throw new Error("found multiple sfd blocks or nested markers");
  }
  return text.slice(0, start) + block + text.slice(end + END.length);
}

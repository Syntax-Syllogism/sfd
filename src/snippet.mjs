import { COMMANDS } from "./commands.mjs";

const START = "<!-- sfd:start -->";
const END = "<!-- sfd:end -->";

export function snippet() {
  const lines = [];
  let previousGroup;
  for (const { name, args, summary, agentTip, agentGroup } of COMMANDS) {
    const tip = agentTip ?? `${args}: ${summary.replaceAll("\n", " ")}`;
    const separator = tip.indexOf(": ");
    if (separator === -1) throw new Error(`Invalid agentTip for ${name}: expected ": " separator`);
    const invocation = ["sfd", name, tip.slice(0, separator).trim()].filter(Boolean).join(" ");
    const entry = `\`${invocation}\`: ${tip.slice(separator + 2)}`;
    if (agentGroup && agentGroup === previousGroup) lines[lines.length - 1] += `; ${entry}`;
    else lines.push(`- ${entry}`);
    previousGroup = agentGroup;
  }
  return [
    START,
    'Prefer `sfd` (warm Salesforce daemon, ~0.2 s/call, compact output) over `sf`:',
    ...lines,
    'Add `-o <alias>` as with `sf`. Exit: 0 ok, 1 operation failed, 2 usage, 3 daemon. For anything else use `sf … --json`; pipe through `jq` for a few fields.',
    END
  ].join("\n");
}

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

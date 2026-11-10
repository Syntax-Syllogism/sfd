import { split } from "./shell.mjs";
import { SF_JSON_COMMANDS } from "./sf-json.mjs";
import { synchronousTestError } from "./test-options.mjs";

// This is deliberately a literal-shell subset. Unknown shell syntax stays with sf.
/**
 * The policy view of one rewritten call.
 * @typedef {{ operation: string, args: { org?: string, method?: string }, effects?: string[] }} PolicyCall
 */
/**
 * Result of rewriting a command. A skipped command has only `skip`.
 * @typedef {{ skip?: string, command?: string, reason?: string, rewritten?: number, skipped?: string[],
 *   policyCalls?: PolicyCall[], policyCall?: PolicyCall }} RewriteResult
 */
/**
 * Result of mapping one sf argv to sfd. A skipped mapping has only `skip`.
 * @typedef {{ skip?: string, command?: string, policyCall?: PolicyCall, apex?: boolean, subcommand?: string,
 *   json?: boolean, format?: boolean, file?: boolean }} MappedArgs
 */
/** @typedef {{ plugins: any[] }} CommandTable */

const quote = (/** @type {string} */ value) => `'${value.replaceAll("'", "'\\''")}'`;
/** @param {string} reason */
const skip = reason => ({ skip: reason });

/**
 * @param {string} source
 * @returns {{ value?: string, op?: string, start: number, end: number }[]}
 */
export function lex(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    if (/[ \t\r]/.test(source[i])) { i++; continue; }
    const start = i;
    const op = /^(?:2>&1|2>\/dev\/null|&&|\|\||>>|<<|[|;&<>\n])/.exec(source.slice(i));
    if (op) {
      tokens.push({ op: op[0], start, end: i += op[0].length });
      continue;
    }
    let value = "", mode = "";
    while (i < source.length) {
      const c = source[i];
      if (!mode && /[ \t\r\n|;&<>]/.test(c)) break;
      if (c === "'" && mode !== '"') { mode = mode === "'" ? "" : "'"; i++; continue; }
      if (c === '"' && mode !== "'") { mode = mode === '"' ? "" : '"'; i++; continue; }
      if (c === "\\" && mode !== "'") {
        if (++i === source.length) throw Error("incomplete escape");
        if (mode === '"' && !/[\$`"\\]/.test(source[i])) value += "\\";
        value += source[i++];
        continue;
      }
      if (mode !== "'" && /[$`]/.test(c)) throw Error("shell expansion or command substitution");
      if (!mode && /[(){}*?\[\]~#]/.test(c)) throw Error("unsupported shell syntax");
      value += c; i++;
    }
    if (mode) throw Error("unclosed quote");
    tokens.push({ value, start, end: i });
  }
  return tokens;
}

// [sf names, sfd flag (empty means drop), takes value, repeatable]
const org = ["o target-org", "-o", true];
const json = ["json", "", false];
const tooling = ["t use-tooling-api", "--tooling", false];
const format = ["r result-format", "", true];
const wait = ["w wait", "-w", true];
const level = ["l test-level", "-l", true];
const tests = ["t tests", "-t", true, true];
const mappings = [
  { sf: "org list metadata-types", sfd: "list-metadata-types", flags: [org, json] },
  { sf: "org list metadata", sfd: "list-metadata", flags: [org, json, ["m metadata-type", "-m", true], ["folder", "--folder", true]] },
  { sf: "apex list log", sfd: "logs", flags: [org, json] },
  { sf: "apex get log", sfd: "logs get", flags: [org, json, ["i log-id", "", true], ["n number", "", true]] },
  { sf: "data query", sfd: "query", flags: [org, json, tooling, ["q query", "", true], ["all-rows", "--all", false], format], required: "q" },
  { sf: "apex run test", sfd: "test", flags: [org, json, wait, level, tests, format, ["n class-names", "-n", true, true], ["s suite-names", "-s", true, true], ["c code-coverage", "-c", false], ["y synchronous", "--synchronous", false]] },
  { sf: "apex run", sfd: "apex", flags: [org, json, ["f file", "-f", true]] },
  { sf: "project retrieve start", sfd: "retrieve", flags: [org, json, wait, ["d source-dir", "-d", true, true], ["m metadata", "-m", true, true], ["x manifest", "-x", true], ["c ignore-conflicts", "--ignore-conflicts", false]] },
  { sf: "project deploy start", sfd: "deploy", flags: [org, json, wait, level, tests, ["d source-dir", "-d", true, true], ["m metadata", "-m", true, true], ["dry-run", "--check-only", false]] },
  { sf: "sobject describe", sfd: "describe", flags: [org, json, tooling, ["s sobject", "", true]], required: "s" },
  { sf: "api request rest", sfd: "rest", flags: [org, ["X method", "-X", true], ["b body", "--body", true]], positional: true },
  { sf: "org list", sfd: "org list", flags: [["all", "--all", false], ["skip-connection-status", "", false], ["json", "--json", false]] },
  { sf: "org display", sfd: "org", flags: [org, json] }
];

/** @param {CommandTable} [table] */
export function allMappings(table = { plugins: [] }) {
  // --confirm is never forwarded: an sf flag cannot carry an sfd hash, and forwarding would bypass deny rules for sfd --confirm.
  const plugin = table.plugins.flatMap(p => p.commands.filter((/** @type {any} */ c) => c.sf).map((/** @type {any} */ c) => ({
    sf: c.sf.join(" "), sfd: c.name.join(" "), plugin: true, effects: c.effects?.length ? c.effects : ["org-write"],
    requiredFlags: c.flags.filter((/** @type {any} */ f) => f.required).map((/** @type {any} */ f) => f.name),
    flags: [org, ["json", "--json", false], ["api-version", "--api-version", true], ...c.flags.filter((/** @type {any} */ f) => !["target-org", "json", "api-version", "confirm"].includes(f.name)).map((/** @type {any} */ f) =>
      [[f.char, f.name].filter(Boolean).join(" "), `--${f.name}`, f.type !== "boolean", f.multiple])]
  })));
  return [...mappings, ...plugin.sort((a, b) => b.sf.split(" ").length - a.sf.split(" ").length)];
}

/**
 * @param {string[]} argv
 * @param {(value: string) => string} quoteValue
 * @param {CommandTable} [table]
 * @returns {MappedArgs}
 */
function mapArgs(argv, quoteValue, table) {
  /** @type {any} */
  const mapping = allMappings(table).find(m => m.sf.split(" ").every((/** @type {string} */ v, /** @type {number} */ i) => argv[i] === v));
  if (!mapping) return skip("unsupported sf command");
  const args = argv.slice(mapping.sf.split(" ").length);
  /** @type {Map<string, string[]>} */
  const seen = new Map();
  /** @type {string[]} */
  const output = [], positionals = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) { positionals.push(arg); continue; }
    const match = /^(?:--([^=]+)|-([A-Za-z]))(?:=(.*))?$/.exec(arg);
    const name = match?.[1] ?? match?.[2];
    const spec = mapping.flags.find((/** @type {any[]} */ f) => f[0].split(" ").includes(name));
    if (!spec) return skip(`unsupported flag ${arg.split("=")[0]}`);
    const [names, target, takesValue, multiple] = spec;
    const key = names.split(" ")[0];
    if (seen.has(key) && !multiple) return skip(`duplicate flag ${arg.split("=")[0]}`);
    let values = [];
    if (takesValue) {
      const value = match[3] ?? args[++i];
      if (value === undefined || value === "") return skip(`missing value for ${arg}`);
      if (value.startsWith("-")) return skip(`unsupported value for ${arg}`);
      values.push(value);
      if (multiple && match[3] === undefined) {
        while (args[i + 1] !== undefined && !args[i + 1].startsWith("-")) values.push(args[++i]);
      }
    } else if (match[3] !== undefined) return skip(`unsupported boolean value ${arg}`);
    seen.set(key, multiple ? [...(seen.get(key) ?? []), ...values] : values);
    if (!mapping.plugin && key === "r") {
      if (mapping.sfd === "query" && values[0] === "csv") output.push("--csv");
      else if (!["human", "json"].includes(values[0])) return skip(`unsupported result format ${values[0]}`);
    }
    if (!mapping.plugin && key === "w" && (!Number.isFinite(Number(values[0])) || Number(values[0]) <= 0)) return skip("wait must be positive");
    if (target) {
      if (takesValue) for (const v of values) output.push(target, quoteValue(v));
      else output.push(target);
    }
  }
  if (mapping.sfd === "org list" && !seen.has("skip-connection-status")) output.push("--status");
  if (mapping.required && !seen.has(mapping.required)) return skip(`missing required ${mapping.required} flag`);
  for (const name of mapping.requiredFlags ?? []) {
    const key = mapping.flags.find((/** @type {any[]} */ f) => f[0].split(" ").includes(name))[0].split(" ")[0];
    if (!seen.has(key)) return skip(`missing required --${name} flag`);
  }
  if (mapping.sfd === "list-metadata" && !seen.has("m")) return skip("metadata listing needs metadata-type");
  if (mapping.sfd === "deploy" && !seen.has("d") && !seen.has("m")) return skip("deploy needs source-dir or metadata");
  if (mapping.sfd === "retrieve" && ["d", "m", "x"].filter(key => seen.has(key)).length > 1) return skip("retrieve selectors are mutually exclusive");
  if (mapping.sfd === "test" && !seen.has("w") && !seen.has("y")) return skip("asynchronous tests need --wait or --synchronous");
  if (mapping.sfd === "test" && seen.has("y")) {
    const selectors = (/** @type {string} */ key) => seen.get(key)?.flatMap(value => value.split(",")).map(value => value.trim()).filter(Boolean);
    const error = synchronousTestError({
      classNames: selectors("n"), tests: selectors("t"), suiteNames: selectors("s"), testLevel: seen.get("l")?.[0]
    });
    if (error) return skip(`synchronous runs need one class: ${error}`);
  }
  if (mapping.sfd === "rest") {
    const method = seen.get("X")?.[0] ?? "GET";
    if (!["GET", "POST", "PUT", "PATCH", "HEAD", "DELETE", "OPTIONS", "TRACE"].includes(method)) return skip("unsupported REST method");
    // sf ignores a body with GET; sfd infers POST from a body instead.
    if (seen.has("b") && method === "GET") return skip("REST body with implicit or explicit GET is unsupported");
  }
  if (mapping.positional ? positionals.length !== 1 : positionals.length !== 0) return skip("unsupported positional arguments");
  let logTarget;
  if (mapping.sfd === "logs get") {
    if (seen.has("i") && seen.has("n")) return skip("choose log-id or number");
    if (seen.has("i")) logTarget = seen.get("i")[0];
    else if (seen.get("n")?.[0] === "1") logTarget = "latest";
    else return skip("log get needs log-id or --number 1");
  }
  const positional = logTarget ? [logTarget] : mapping.required ? seen.get(mapping.required) : positionals;
  // Protect sfd's own option parser from values that could be interpreted as options.
  if (positional.some((/** @type {string} */ v) => v.startsWith("-"))) return skip("unsupported positional value");
  return { command: ["sfd", mapping.sfd, ...positional.map(quoteValue), ...output].join(" "), policyCall: { operation: mapping.sfd, args: { org: seen.get("o")?.[0], method: seen.get("X")?.[0] }, ...(mapping.plugin ? { effects: mapping.effects } : {}) }, apex: mapping.sfd === "apex", subcommand: mapping.sfd, json: seen.has("json"), format: seen.has("r"), file: seen.has("f") };
}

/**
 * @param {unknown} command
 * @param {{ shell?: string, table?: CommandTable, includePolicy?: boolean }} [options]
 * @returns {RewriteResult}
 */
export function rewrite(command, { shell = "posix", table, includePolicy = false } = {}) {
  if (typeof command !== "string" || !command.trim()) return skip("empty command");
  try {
    /** @type {RewriteResult} */
    const result = shell === "powershell" ? rewritePowerShell(command, table) : shell === "posix" ? rewriteShell(command, table) : skip("unsupported shell");
    if (!includePolicy) delete result.policyCalls;
    return result;
  } catch (error) { return skip(error.message); }
}

/** @param {string} source */
function lexPowerShell(source) {
  /** @type {string[]} */
  const words = [];
  let i = 0;
  while (i < source.length) {
    if (/[ \t]/.test(source[i])) { i++; continue; }
    let value = "";
    const delimiter = source[i];
    if (delimiter === "'" || delimiter === '"') {
      i++;
      let closed = false;
      while (i < source.length) {
        const c = source[i++];
        if (c === delimiter) {
          if (delimiter === "'" && source[i] === "'") { value += "'"; i++; continue; }
          closed = true; break;
        }
        if (delimiter === '"' && /[$`]/.test(c)) throw Error("PowerShell expansion or escape");
        value += c;
      }
      if (!closed) throw Error("unclosed PowerShell quote");
    } else {
      while (i < source.length && !/[ \t]/.test(source[i])) {
        if (!/[A-Za-z0-9_\-.:=\\/+%*?~\[\]]/.test(source[i])) throw Error("unsupported PowerShell syntax");
        value += source[i++];
      }
    }
    if (i < source.length && !/[ \t]/.test(source[i])) throw Error("mixed PowerShell token");
    words.push(value);
  }
  return words;
}

/**
 * @param {string} command
 * @param {CommandTable} [table]
 * @returns {RewriteResult}
 */
function rewritePowerShell(command, table) {
  // Keep a strict subset that passes the same values through PowerShell 5.1 and 7.
  const source = command.replace(/^[ \t]+/, "").replace(/[ \t]*(?:\r?\n)?[ \t]*$/, "");
  if (/[\r\n\x00-\x08\x0b-\x1f\u2018-\u201e]/.test(source) || source.includes("--%")) return skip("unsupported PowerShell syntax");
  if (!/^sf(?:[ \t]|$)/.test(source)) return skip("not a plain sf invocation");
  const words = lexPowerShell(source);
  const quotePowerShell = (/** @type {string} */ value) => {
    if (!value || value.includes('"') || value.endsWith("\\")) throw Error("unsafe PowerShell native argument");
    return `'${value.replaceAll("'", "''")}'`;
  };
  const mapped = mapArgs(words.slice(1), quotePowerShell, table);
  if (mapped.skip) return mapped;
  if (mapped.apex && !mapped.file) return skip("PowerShell apex run needs a file");
  return { command: mapped.command, reason: "sfd: warm daemon, ~0.3 s", rewritten: 1, skipped: [], policyCalls: [mapped.policyCall] };
}

/**
 * @param {string} text
 * @param {boolean} consumed
 * @param {boolean} stdin
 * @param {string} whole
 * @param {CommandTable} [table]
 * @returns {RewriteResult}
 */
function rewriteElement(text, consumed, stdin, whole, table) {
  let continued = "", single = false, double = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && !single) {
      if (text[i + 1] === "\n") { continued += "  "; i++; continue; }
      continued += c + (text[++i] ?? ""); continue;
    }
    if (c === "'" && !double) single = !single;
    if (c === '"' && !single) double = !double;
    if (c === "\n" && (single || double)) return skip("unsupported multiline command");
    if (c === "\n") { continued += text.slice(i); break; }
    continued += c;
  }
  const firstLine = continued.indexOf("\n");
  const head = firstLine < 0 ? continued : continued.slice(0, firstLine);
  const tokens = lex(head);
  const start = tokens[0]?.value?.startsWith("SF_TARGET_ORG=") ? 1 : 0;
  if (tokens[start]?.value !== "sf") return skip("not a plain sf invocation");
  /** @type {string[]} */
  const words = [], redirects = [];
  let heredoc = "";
  for (let i = start + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.op) {
      if (/^\d+$/.test(token.value) && tokens[i + 1]?.start === token.end && tokens[i + 1].op) return skip("unsupported redirection");
      words.push(token.value); continue;
    }
    if (["2>/dev/null", "2>&1"].includes(token.op)) redirects.push(token.op);
    else if ([">", ">>"].includes(token.op) && tokens[i + 1]?.value !== undefined) {
      consumed = true;
      redirects.push(`${token.op} ${head.slice(tokens[i + 1].start, tokens[i + 1].end)}`); i++;
    } else if (token.op === "<<" && tokens[i + 1]?.value) {
      if (heredoc) return skip("unsupported heredoc");
      heredoc = text.slice(token.start, tokens[i + 1].end) + (firstLine < 0 ? "" : text.slice(firstLine));
      i++;
    } else return skip("unsupported redirection");
  }
  const mapped = mapArgs(words, quote, table);
  if (mapped.skip) return mapped;
  if ((stdin || heredoc) && !mapped.apex) return skip("stdin is supported only for apex run");
  if (consumed) {
    if (!SF_JSON_COMMANDS.has(mapped.subcommand) || !mapped.json || mapped.format) return skip("sf output is piped or redirected without compatible JSON (unsupported redirection)");
    if (redirects.includes("2>&1")) return skip("stderr merged into consumed output");
    if (mapped.subcommand.startsWith("org") && /accessToken|sfdxAuthUrl/i.test(whole)) return skip("consumer may read a token sfd never prints");
    if (mapped.subcommand === "org list" && words.includes("--skip-connection-status")) mapped.command += " --skip-connection-status";
    mapped.command = mapped.command.replace(/ --json\b/, "") + " --sf-json";
  }
  if (!mapped.policyCall.args.org && start) mapped.policyCall.args.org = tokens[0].value.slice("SF_TARGET_ORG=".length);
  const prefix = head.slice(0, tokens[start].start);
  const trailing = heredoc && firstLine >= 0 ? "" : firstLine < 0 ? text.match(/\s*$/)[0] : text.slice(firstLine);
  return { policyCall: mapped.policyCall, command: prefix + mapped.command + redirects.map(r => ` ${r}`).join("") + (heredoc ? ` ${heredoc}` : "") + trailing };
}

/**
 * @param {string} command
 * @param {CommandTable} [table]
 * @returns {RewriteResult}
 */
function rewriteShell(command, table) {
  if (/SF_TEMP_SHOW_SECRETS/i.test(command)) return skip("consumer may read a token sfd never prints");
  const parsed = split(command);
  if (parsed.skip) return parsed;
  /** @type {{ start: number, end: number, text: string, policyCall: PolicyCall }[]} */
  const replacements = [];
  /** @type {string[]} */
  const skipped = [];
  for (const segment of parsed.segments) {
    for (const [index, element] of segment.elements.entries()) {
      const text = command.slice(element.start, element.end);
      if (!/^\s*(?:SF_TARGET_ORG=(?:'[^']*'|"[^"]*"|\S+)\s+)?(?:sf|'sf'|"sf")(?=\s|$)/.test(text)) continue;
      /** @type {RewriteResult} */
      let result;
      try { result = rewriteElement(text, index < segment.elements.length - 1, index > 0, command, table); }
      catch (error) { result = skip(error.message); }
      if (result.skip) skipped.push(result.skip);
      else replacements.push({ ...element, text: result.command, policyCall: result.policyCall });
    }
  }
  if (!replacements.length) return skip(skipped[0] ?? "not a plain sf invocation (paths, env prefixes and sfdx are unsupported)");
  let output = command;
  for (const { start, end, text } of replacements.toReversed()) output = output.slice(0, start) + text + output.slice(end);
  return { command: output, reason: replacements.length > 1 ? `sfd: rewrote ${replacements.length} calls; warm daemon, ~0.3 s` : "sfd: warm daemon, ~0.3 s", rewritten: replacements.length, skipped, policyCalls: replacements.map(r => r.policyCall) };
}

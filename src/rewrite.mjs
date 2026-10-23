import { split } from "./shell.mjs";
import { SF_JSON_COMMANDS } from "./sf-json.mjs";

// This is deliberately a literal-shell subset. Unknown shell syntax stays with sf.
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const skip = reason => ({ skip: reason });

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
  { sf: "apex run test", sfd: "test", flags: [org, json, wait, level, tests, format, ["n class-names", "-n", true, true], ["s suite-names", "-s", true, true], ["c code-coverage", "-c", false], ["y synchronous", "", false]] },
  { sf: "apex run", sfd: "apex", flags: [org, json, ["f file", "-f", true]] },
  { sf: "project retrieve start", sfd: "retrieve", flags: [org, json, wait, ["d source-dir", "-d", true, true], ["m metadata", "-m", true, true], ["x manifest", "-x", true], ["c ignore-conflicts", "--ignore-conflicts", false]] },
  { sf: "project deploy start", sfd: "deploy", flags: [org, json, wait, level, tests, ["d source-dir", "-d", true, true], ["m metadata", "-m", true, true], ["dry-run", "--check-only", false]] },
  { sf: "sobject describe", sfd: "describe", flags: [org, json, tooling, ["s sobject", "", true]], required: "s" },
  { sf: "api request rest", sfd: "rest", flags: [org, ["X method", "-X", true], ["b body", "--body", true]], positional: true },
  { sf: "org list", sfd: "org list", flags: [["all", "--all", false], ["skip-connection-status", "", false], ["json", "--json", false]] },
  { sf: "org display", sfd: "org", flags: [org, json] }
];

function mapArgs(argv) {
  const mapping = mappings.find(m => m.sf.split(" ").every((v, i) => argv[i] === v));
  if (!mapping) return skip("unsupported sf command");
  const args = argv.slice(mapping.sf.split(" ").length);
  const seen = new Map(), output = [], positionals = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) { positionals.push(arg); continue; }
    const match = /^(?:--([^=]+)|-([A-Za-z]))(?:=(.*))?$/.exec(arg);
    const name = match?.[1] ?? match?.[2];
    const spec = mapping.flags.find(f => f[0].split(" ").includes(name));
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
    seen.set(key, values);
    if (key === "r") {
      if (mapping.sfd === "query" && values[0] === "csv") output.push("--csv");
      else if (!["human", "json"].includes(values[0])) return skip(`unsupported result format ${values[0]}`);
    }
    if (key === "w" && (!Number.isFinite(Number(values[0])) || Number(values[0]) <= 0)) return skip("wait must be positive");
    if (target) {
      if (takesValue) for (const v of values) output.push(target, quote(v));
      else output.push(target);
    }
  }
  if (mapping.sfd === "org list" && !seen.has("skip-connection-status")) output.push("--status");
  if (mapping.required && !seen.has(mapping.required)) return skip(`missing required ${mapping.required} flag`);
  if (mapping.sfd === "list-metadata" && !seen.has("m")) return skip("metadata listing needs metadata-type");
  if (mapping.sfd === "deploy" && !seen.has("d") && !seen.has("m")) return skip("deploy needs source-dir or metadata");
  if (mapping.sfd === "retrieve" && ["d", "m", "x"].filter(key => seen.has(key)).length > 1) return skip("retrieve selectors are mutually exclusive");
  if (mapping.sfd === "test" && !seen.has("w") && !seen.has("y")) return skip("asynchronous tests need --wait or --synchronous");
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
  if (positional.some(v => v.startsWith("-"))) return skip("unsupported positional value");
  return { command: ["sfd", mapping.sfd, ...positional.map(quote), ...output].join(" "), apex: mapping.sfd === "apex", subcommand: mapping.sfd, json: seen.has("json"), format: seen.has("r") };
}

export function rewrite(command) {
  if (typeof command !== "string" || !command.trim()) return skip("empty command");
  try {
    return rewriteShell(command);
  } catch (error) { return skip(error.message); }
}

function rewriteElement(text, consumed, stdin, whole) {
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
  const mapped = mapArgs(words);
  if (mapped.skip) return mapped;
  if ((stdin || heredoc) && !mapped.apex) return skip("stdin is supported only for apex run");
  if (consumed) {
    if (!SF_JSON_COMMANDS.has(mapped.subcommand) || !mapped.json || mapped.format) return skip("sf output is piped or redirected without compatible JSON (unsupported redirection)");
    if (redirects.includes("2>&1")) return skip("stderr merged into consumed output");
    if (mapped.subcommand.startsWith("org") && /accessToken|sfdxAuthUrl/i.test(whole)) return skip("consumer may read a token sfd never prints");
    if (mapped.subcommand === "org list" && words.includes("--skip-connection-status")) mapped.command += " --skip-connection-status";
    mapped.command = mapped.command.replace(/ --json\b/, "") + " --sf-json";
  }
  const prefix = head.slice(0, tokens[start].start);
  const trailing = heredoc && firstLine >= 0 ? "" : firstLine < 0 ? text.match(/\s*$/)[0] : text.slice(firstLine);
  return { command: prefix + mapped.command + redirects.map(r => ` ${r}`).join("") + (heredoc ? ` ${heredoc}` : "") + trailing };
}

function rewriteShell(command) {
  if (/SF_TEMP_SHOW_SECRETS/i.test(command)) return skip("consumer may read a token sfd never prints");
  const parsed = split(command);
  if (parsed.skip) return parsed;
  const replacements = [], skipped = [];
  for (const segment of parsed.segments) {
    for (const [index, element] of segment.elements.entries()) {
      const text = command.slice(element.start, element.end);
      if (!/^\s*(?:SF_TARGET_ORG=(?:'[^']*'|"[^"]*"|\S+)\s+)?(?:sf|'sf'|"sf")(?=\s|$)/.test(text)) continue;
      let result;
      try { result = rewriteElement(text, index < segment.elements.length - 1, index > 0, command); }
      catch (error) { result = skip(error.message); }
      if (result.skip) skipped.push(result.skip);
      else replacements.push({ ...element, text: result.command });
    }
  }
  if (!replacements.length) return skip(skipped[0] ?? "not a plain sf invocation (paths, env prefixes and sfdx are unsupported)");
  let output = command;
  for (const { start, end, text } of replacements.toReversed()) output = output.slice(0, start) + text + output.slice(end);
  return { command: output, reason: replacements.length > 1 ? `sfd: rewrote ${replacements.length} calls; warm daemon, ~0.3 s` : "sfd: warm daemon, ~0.3 s", rewritten: replacements.length, skipped };
}

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
  return { command: ["sfd", mapping.sfd, ...positional.map(quote), ...output].join(" "), apex: mapping.sfd === "apex" };
}

export function rewrite(command) {
  if (typeof command !== "string" || !command.trim()) return skip("empty command");
  try {
    return rewriteShell(command);
  } catch (error) { return skip(error.message); }
}

function rewriteShell(command) {
  // Only remove continuations outside single quotes; the lexer does the rest.
  let source = "", single = false, double = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "\n" && !single && !double) { source += command.slice(i); break; }
    if (c === "\\" && !single) {
      if (command[i + 1] === "\n") { i++; continue; }
      source += c + (command[++i] ?? ""); continue;
    }
    if (c === "'" && !double) single = !single;
    if (c === '"' && !single) double = !double;
    source += c;
  }
  source = source.trimStart();
  // Heredoc contents are opaque: preserve them byte for byte and require one literal delimiter.
  const newline = source.indexOf("\n");
  let body = "";
  if (newline !== -1) { body = source.slice(newline); source = source.slice(0, newline); }
  const tokens = lex(source);
  let stderr = "";
  while (["2>&1", "2>/dev/null"].includes(tokens.at(-1)?.op)) {
    stderr = ` ${tokens.pop().op}${stderr}`;
  }
  let heredoc = "";
  const hd = tokens.findIndex(t => t.op === "<<");
  if (hd !== -1) {
    const delimiter = tokens[hd + 1];
    if (!delimiter || delimiter.op || hd + 2 !== tokens.length || !/^[A-Za-z_][\w]*$/.test(delimiter.value)) return skip("unsupported heredoc");
    const contents = body.slice(1);
    const lines = (contents.endsWith("\n") ? contents.slice(0, -1) : contents).split("\n");
    if (lines.at(-1) !== delimiter.value || lines.slice(0, -1).includes(delimiter.value)) return skip("unsupported heredoc terminator");
    heredoc = source.slice(tokens[hd].start, delimiter.end) + body;
    tokens.splice(hd);
  } else if (body.trim()) return skip("unsupported multiline command");
  while (["2>&1", "2>/dev/null"].includes(tokens.at(-1)?.op)) {
    stderr = ` ${tokens.pop().op}${stderr}`;
  }
  if (tokens.some(t => t.op && !["&&", "|"].includes(t.op))) return skip("output redirection or unsupported shell chain");
  const chains = tokens.flatMap((t, i) => t.op === "&&" ? [i] : []);
  let start = 0;
  if (chains.length) {
    if (chains.length !== 1 || chains[0] !== 2 || tokens[0].value !== "cd" || !tokens[1].value || tokens[1].value.startsWith("-")) return skip("unsupported && chain");
    start = 3;
  }
  const pipes = tokens.flatMap((t, i) => t.op === "|" ? [i] : []);
  if (pipes.length) {
    if (pipes.some(i => i <= start || i === tokens.length - 1 || tokens[i - 1].op)) return skip("unsupported pipeline");
    // Never rewrite sf whose stdout is consumed, even if a later segment is also sf.
    for (const i of [start, ...pipes.map(p => p + 1)].slice(0, -1)) {
      if (tokens[i]?.value === "sf" || tokens[i]?.value?.startsWith("SF_TARGET_ORG=")) return skip("sf output is piped");
    }
    start = pipes.at(-1) + 1;
  }
  if (tokens[start]?.value?.startsWith("SF_TARGET_ORG=")) start++;
  if (tokens[start]?.value !== "sf") return skip("not a plain sf invocation (paths, env prefixes and sfdx are unsupported)");
  if (tokens.slice(start).some(t => t.op)) return skip("unsupported shell operator");
  const mapped = mapArgs(tokens.slice(start + 1).map(t => t.value));
  if (mapped.skip) return mapped;
  if ((pipes.length || heredoc) && !mapped.apex) return skip("stdin is supported only for apex run");
  return { command: source.slice(0, tokens[start].start) + mapped.command + stderr + (heredoc ? ` ${heredoc}` : ""), reason: "sfd: warm daemon, ~0.3 s" };
}

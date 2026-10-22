#!/usr/bin/env node
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { call, isRunning, startDaemon, DaemonError, VERSION } from "../src/client.mjs";
import { findProjectDir, resolveTargetOrg } from "../src/project.mjs";
import { formatMetadataTypes, formatMetadataList, formatOrgList, formatApex, formatLog, formatLogList, formatDeploy, formatTests, formatRetrieve, formatTracking, toCsv } from "../src/format.mjs";
import { paths } from "../src/paths.mjs";
import { commandHelp } from "../src/commands.mjs";
import { snippet, upsertSnippet } from "../src/snippet.mjs";
import { UsageError } from "../src/usage-error.mjs";

const USAGE = `sfd ${VERSION}: fast Salesforce CLI operations through a warm local daemon

Usage: sfd <command> [options]

Commands:
${commandHelp()}

Common options:
  -o, --target-org <alias>  Org alias or username (default: sf target-org config)
  --json                    Print the raw JSON response
  -h, --help                Show this help

Exit codes: 0 success, 1 operation failed, 2 usage error, 3 daemon error.`;

const options = {
  "target-org": { type: "string", short: "o" },
  write: { type: "boolean" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  folder: { type: "string" },
  details: { type: "boolean" },
  tooling: { type: "boolean" },
  status: { type: "boolean" },
  all: { type: "boolean" },
  csv: { type: "boolean" },
  raw: { type: "boolean" },
  log: { type: "boolean" },
  logs: { type: "boolean" },
  full: { type: "boolean" },
  "no-trace": { type: "boolean" },
  count: { type: "string" },
  limit: { type: "string" },
  user: { type: "string" },
  file: { type: "string", short: "f" },
  method: { type: "string", short: "X" },
  body: { type: "string" },
  "source-dir": { type: "string", short: "d", multiple: true },
  metadata: { type: "string", short: "m", multiple: true },
  manifest: { type: "string", short: "x" },
  "ignore-conflicts": { type: "boolean" },
  local: { type: "boolean" },
  remote: { type: "boolean" },
  conflicts: { type: "boolean" },
  "check-only": { type: "boolean" },
  "test-level": { type: "string", short: "l" },
  tests: { type: "string", short: "t", multiple: true },
  "class-names": { type: "string", short: "n", multiple: true },
  "suite-names": { type: "string", short: "s", multiple: true },
  "code-coverage": { type: "boolean", short: "c" },
  wait: { type: "string", short: "w" }
};

const split = list => list?.flatMap(v => v.split(",")).map(v => v.trim()).filter(Boolean);

function readStdin() {
  if (process.stdin.isTTY) return "";
  try { return readFileSync(0, "utf8"); } catch { return ""; }
}

function readInputFile(file) {
  const path = resolve(file);
  try { return readFileSync(path, "utf8"); }
  catch (e) { throw new UsageError(`Cannot read input file ${path}: ${e.message}`); }
}

function readBody(spec) {
  if (spec === undefined) return undefined;
  const text = spec.startsWith("@") ? readInputFile(spec.slice(1)) : spec;
  try { return JSON.parse(text); } catch { return text; }
}

function wait(values) {
  if (values.wait === undefined) return undefined;
  const minutes = Number(values.wait);
  if (!Number.isFinite(minutes) || minutes <= 0) throw new UsageError("--wait must be a positive number of minutes.");
  return minutes;
}

function queryLimit(value) {
  if (value === undefined) return undefined;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new UsageError("--limit must be a positive integer.");
  return limit;
}

function print(value) {
  process.stdout.write((typeof value === "string" ? value : JSON.stringify(value, null, 2)) + "\n");
}

async function run(argv) {
  if (argv[0] === "hook") {
    const { runHook } = await import("../src/hooks.mjs");
    return runHook(argv.slice(1));
  }
  if (argv[0] === "discover") {
    const { values, positionals } = parseArgs({ args: argv.slice(1), options: {
      since: { type: "string" }, agent: { type: "string", multiple: true },
      project: { type: "string" }, top: { type: "string" }, json: { type: "boolean" },
      help: { type: "boolean", short: "h" }
    }, allowPositionals: true });
    if (values.help) { print("sfd discover [--since 30d] [--agent claude|codex|gemini]… [--project <path>] [--top 10] [--json]"); return 0; }
    if (positionals.length) throw new UsageError("discover does not accept positional arguments.");
    const { discover, discoverOptions, formatReport } = await import("../src/discover/index.mjs");
    const report = await discover(discoverOptions(values));
    print(values.json ? report : formatReport(report));
    return 0;
  }
  const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: true });
  let [command, ...rest] = positionals;
  if (values.help || !command) { print(USAGE); return 0; }

  const cwd = process.cwd();
  const org = () => resolveTargetOrg(values["target-org"], cwd);
  const projectDir = () => {
    const dir = findProjectDir(cwd);
    if (!dir) throw new UsageError("No sfdx-project.json found in this directory or its parents.");
    return dir;
  };

  if (command === "agents-snippet") {
    if (rest.length > 1 || (rest.length && !values.write)) {
      throw new UsageError("agents-snippet accepts --write [file].");
    }
    const block = snippet();
    if (!values.write) { print(block); return 0; }
    const root = findProjectDir(cwd) ?? cwd;
    const file = rest[0] ?? ["AGENTS.md", "CLAUDE.md"].find(name => existsSync(resolve(root, name))) ?? "AGENTS.md";
    const target = resolve(rest[0] ? cwd : root, file);
    let original;
    try { original = readFileSync(target, "utf8"); }
    catch (e) {
      if (e.code !== "ENOENT") throw new UsageError(`Cannot read target file ${target}: ${e.message}`);
    }
    let updated;
    try { updated = upsertSnippet(original ?? "", block); }
    catch (e) { throw new UsageError(`Malformed sfd block in ${file}: ${e.message}`); }
    if (updated === original) print(`${file} already up to date`);
    else {
      try { writeFileSync(target, updated); }
      catch (e) { throw new UsageError(`Cannot write target file ${target}: ${e.message}`); }
      print(`${original === undefined ? "Created" : "Updated"} ${file}`);
    }
    return 0;
  }

  // Lifecycle commands.
  switch (command) {
    case "start":
      if (await isRunning()) { print("sfd already running"); return 0; }
      startDaemon();
      await call("ping");
      print(`sfd started (${paths().socket})`);
      return 0;
    case "stop":
      if (!(await isRunning())) { print("sfd not running"); return 0; }
      await call("stop", {}, { autoStart: false });
      print("sfd stopping");
      return 0;
    case "status": {
      if (!(await isRunning())) { print(values.json ? { running: false } : "sfd not running"); return 0; }
      const res = await call("status", {}, { autoStart: false });
      const s = { running: true, version: VERSION, socket: paths().socket, log: paths().log, ...res.result };
      print(values.json ? s : `sfd ${VERSION} running (pid ${s.pid}, up ${s.uptimeSeconds}s), orgs: ${s.orgs.join(", ") || "none"}\nlog: ${s.log}`);
      return 0;
    }
    case "reload": {
      if (!(await isRunning())) { print("sfd not running"); return 0; }
      await call("reload", {}, { autoStart: false });
      print("sfd reloaded");
      return 0;
    }
  }

  let req;
  let render = result => result;
  switch (command) {
    case "query": {
      const q = rest.join(" ") || readStdin().trim();
      if (!q) throw new UsageError("query needs a SOQL string.");
      const limit = queryLimit(values.limit);
      req = { org: org(), q, tooling: values.tooling, all: values.all, raw: values.raw, limit };
      if (values.csv) render = result => toCsv(result.records);
      break;
    }
    case "apex": {
      const file = values.file ?? rest[0];
      const body = file ? readInputFile(file) : readStdin();
      if (!body.trim()) throw new UsageError("apex needs code from a file, -f <file>, or stdin.");
      req = { org: org(), body };
      render = result => formatApex(result, { fullLog: values.log });
      break;
    }
    case "rest": {
      const url = rest[0];
      if (!url) throw new UsageError("rest needs a path, e.g. /services/data/v67.0/limits.");
      req = { org: org(), method: (values.method ?? (values.body ? "POST" : "GET")).toUpperCase(), url, body: readBody(values.body) };
      break;
    }
    case "describe": {
      if (!rest[0]) throw new UsageError("describe needs an sObject name.");
      req = { org: org(), sobject: rest[0], tooling: values.tooling, raw: values.raw };
      break;
    }
    case "list-metadata-types":
      command = "listMetadataTypes";
      req = { org: org() };
      render = formatMetadataTypes;
      break;
    case "list-metadata": {
      const types = [...new Set(split(values.metadata) ?? [])];
      if (!types.length) throw new UsageError("list-metadata needs -m <Type>.");
      if (values.folder !== undefined && types.length > 1) throw new UsageError("--folder requires exactly one metadata type.");
      command = "listMetadata";
      req = { org: org(), types, folder: values.folder };
      render = result => formatMetadataList(result, { details: values.details });
      break;
    }
    case "deploy": {
      const dir = projectDir();
      const sourcePaths = split(values["source-dir"])?.map(d => resolve(cwd, d));
      for (const p of sourcePaths ?? []) if (!existsSync(p)) throw new UsageError(`No such path: ${p}`);
      const metadata = split(values.metadata);
      if (!sourcePaths?.length && !metadata?.length) throw new UsageError("deploy needs -d <path> or -m <Type[:Name]>.");
      req = {
        org: org(), projectDir: dir, sourcePaths, metadata, checkOnly: values["check-only"],
        testLevel: values["test-level"], tests: split(values.tests), waitMinutes: wait(values)
      };
      render = result => formatDeploy(result, req.org);
      break;
    }
    case "retrieve": {
      const dir = projectDir();
      const sourcePaths = split(values["source-dir"])?.map(d => resolve(cwd, d));
      const manifest = values.manifest ? resolve(cwd, values.manifest) : undefined;
      for (const p of [...(sourcePaths ?? []), ...(manifest ? [manifest] : [])]) {
        if (!existsSync(p)) throw new UsageError(`No such path: ${p}`);
      }
      const metadata = split(values.metadata);
      if ([Boolean(sourcePaths?.length), Boolean(metadata?.length), Boolean(manifest)].filter(Boolean).length > 1) {
        throw new UsageError("retrieve accepts only one of -d, -m or -x.");
      }
      req = { org: org(), projectDir: dir, sourcePaths, metadata, manifest,
        ignoreConflicts: values["ignore-conflicts"], waitMinutes: wait(values) };
      render = result => formatRetrieve(result, req.org);
      break;
    }
    case "tracking":
      if (values.local && values.remote) throw new UsageError("tracking accepts only one of --local or --remote.");
      req = { org: org(), projectDir: projectDir(), local: values.local, remote: values.remote, conflicts: values.conflicts };
      render = formatTracking;
      break;
    case "logs": {
      if (rest[0] === "get") {
        if (rest.length !== 2) throw new UsageError("logs get needs an ID or latest.");
        command = "logGet";
        req = { org: org(), id: rest[1], noTrace: values["no-trace"] };
        render = result => values.full ? result.body : formatLog(result);
      } else {
        if (rest.length) throw new UsageError("logs accepts only get <id|latest>.");
        const count = Number(values.count ?? values.limit ?? 10);
        if (!Number.isSafeInteger(count) || count < 1) throw new UsageError("Log count must be a positive integer.");
        req = { org: org(), count, user: values.user, noTrace: values["no-trace"] };
        render = result => formatLogList(result.records);
      }
      break;
    }
    case "test":
      req = {
        org: org(), classNames: split(values["class-names"]), tests: split(values.tests), suiteNames: split(values["suite-names"]),
        logs: values.logs, noTrace: values["no-trace"], testLevel: values["test-level"], codeCoverage: values["code-coverage"], waitMinutes: wait(values)
      };
      render = result => formatTests(result, req.org);
      break;
    case "org":
      if (rest[0] === "list") {
        if (rest.length !== 1 || values["target-org"] !== undefined) throw new UsageError("org list accepts no target org or additional arguments.");
        command = "orgList";
        req = { all: values.all, status: values.status };
        render = formatOrgList;
      } else {
        req = { org: org() };
      }
      break;
    default:
      throw new UsageError(`Unknown command: ${command}. Run sfd --help.`);
  }

  const res = await call(command, req);
  const trace = res.result?.trace ?? res.trace;
  if (trace) {
    process.stderr.write(`sfd: enabled debug logging for ${trace.username} until ${trace.expires} (TraceFlag ${trace.id})\n`);
  }
  if (values.json) { print(command === "orgList" && res.status === 0 ? { orgs: res.result.orgs } : res); return res.status === 0 ? okStatus(command, res.result) : res.name === "UsageError" ? 2 : 1; }
  if (res.status !== 0) {
    process.stderr.write(`${res.name}: ${res.message}\n`);
    return res.name === "UsageError" ? 2 : 1;
  }
  const output = render(res.result);
  if (command !== "query" || !values.csv || output) print(output);
  if (command === "query" && res.result.truncated) {
    const { totalSize, records } = res.result;
    const trailer = `… ${(totalSize - records.length).toLocaleString("en-US")} more rows not shown (totalSize ${totalSize.toLocaleString("en-US")}); raise --limit or narrow the query\n`;
    (values.csv ? process.stderr : process.stdout).write(trailer);
  }
  return okStatus(command, res.result);
}

// A request can succeed while the Salesforce operation fails (compile error, failed deploy or test).
function okStatus(command, result) {
  if (command === "apex") return result.compiled && result.success ? 0 : 1;
  if (command === "deploy" || command === "retrieve") return result.success ? 0 : 1;
  if (command === "test") return result.failing === 0 && !result.setupFailures?.length ? 0 : 1;
  return 0;
}

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (e) {
  if (e instanceof UsageError || e.code?.startsWith?.("ERR_PARSE_ARGS")) {
    process.stderr.write(`${e.message}\n`);
    process.exitCode = 2;
  } else if (e instanceof DaemonError || ["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(e.code)) {
    process.stderr.write(`sfd daemon error: ${e.message}\nlog: ${paths().log}\n`);
    process.exitCode = 3;
  } else {
    process.stderr.write(`${e.message}\n`);
    process.exitCode = 1;
  }
}

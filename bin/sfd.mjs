#!/usr/bin/env node
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { call, isRunning, startDaemon, DaemonError, VERSION } from "../src/client.mjs";
import { findProjectDir, resolveTargetOrg } from "../src/project.mjs";
import { formatMetadataTypes, formatMetadataList, formatOrgList, formatApex, formatLog, formatLogList, formatDeploy, formatTests, formatRetrieve, formatTracking, toCsv } from "../src/format.mjs";
import { paths } from "../src/paths.mjs";
import { COMMANDS, commandHelp, commandUsage } from "../src/commands.mjs";
import { helpUsageError, renderCommandManual, renderGuide, renderHelpIndex } from "../src/help-topics.mjs";
import { snippet, upsertSnippet } from "../src/snippet.mjs";
import { UsageError } from "../src/usage-error.mjs";
import { synchronousTestError } from "../src/test-options.mjs";

import { loadTable } from "../src/plugin/table-cache.mjs";
import { matchCommand, parseCommand, pluginManual, formatPlugin } from "../src/plugin/cli-table.mjs";
import { initCliTable } from "../src/plugin/init.mjs";

import { SF_JSON_COMMANDS, sfEnvelope, sfError } from "../src/sf-json.mjs";

const USAGE = `sfd ${VERSION}: fast Salesforce CLI operations through a warm local daemon

Usage: sfd <command> [options]

Commands:
${commandHelp()}

Common options:
  -o, --target-org <alias>  Org alias or username (default: sf target-org config)
  --json                    Print the raw JSON response
  --confirm <hash>          Confirm a policy approval (single use, 10 min)
  --version                 Print the sfd version
  -h, --help                Show this help

Run 'sfd help <command|guide>' for full documentation.

Exit codes: 0 success, 1 operation failed, 2 usage error, 3 daemon error, 4 approval required or policy denied.`;

const options = {
  "target-org": { type: "string", short: "o" },
  confirm: { type: "string" },
  quiet: { type: "boolean" },
  plan: { type: "boolean" },
  "options-json": { type: "string" },
  write: { type: "boolean" },
  json: { type: "boolean" },
  "sf-json": { type: "boolean" },
  version: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  folder: { type: "string" },
  details: { type: "boolean" },
  tooling: { type: "boolean" },
  status: { type: "boolean" },
  "skip-connection-status": { type: "boolean" },
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
  synchronous: { type: "boolean", short: "y" },
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

async function renderPluginResult(result, values, format) {
  if (values.json) print(result);
  else if (result.ok) {
    print(result.policy ? result.data : await format(result.data));
    for (const warning of result.warnings ?? []) process.stderr.write(`warning: ${warning}\n`);
    if (result.failures > 0) process.stderr.write(`failed: ${result.failures} item(s)\n`);
    if (result.policy) {
      process.stderr.write(`policy: ${result.policy.decision}\n`);
      if (result.policy.hash) process.stderr.write(`re-run with: --confirm ${result.policy.hash}   (valid 10 min)\n`);
    } else if (result.truncated) process.stderr.write(`… result truncated (total ${result.total ?? "unknown"})\n`);
  } else {
    process.stderr.write(`${result.code}: ${result.message}\n`);
    for (const action of result.actions) process.stderr.write(`  → ${action}\n`);
  }
  return !result.ok ? (result.code === "usage" ? 2 : 1) : result.failures > 0 ? 1 : 0;
}

async function run(argv) {
  // Version is a side-effect-free global flag. It takes precedence over commands and --sf-json.
  if (argv.includes("--version")) { print(`sfd ${VERSION}`); return 0; }
  if (argv[0] === "help") {
    const { values, positionals } = parseArgs({ args: argv.slice(1), options: {
      all: { type: "boolean", short: "a" }, guides: { type: "boolean", short: "g" },
      help: { type: "boolean", short: "h" }
    }, allowPositionals: true });
    if (values.help) { print(commandUsage("help")); return 0; }
    if (values.all && values.guides) throw new UsageError("sfd help accepts only one of --all or --guides.");
    if ((values.all || values.guides) && positionals.length) throw new UsageError("sfd help --all and --guides do not accept a topic.");
    if (!positionals.length) { print(renderHelpIndex({ guidesOnly: values.guides, table: loadTable() })); return 0; }
    const topic = positionals.join(" ");
    const manual = renderCommandManual(topic, loadTable());
    if (manual !== undefined) { print(manual); return 0; }
    const guide = renderGuide(topic);
    if (guide !== undefined) { print(guide); return 0; }
    throw new UsageError(helpUsageError(topic));
  }
  if (argv.includes("--sf-json") && ["hook", "discover"].includes(argv[0])) throw new UsageError("--sf-json is unsupported for this command.");
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
  if (argv[0] === "plugin" && argv[1] === "init") {
    const { values, positionals } = parseArgs({ args: argv.slice(2), allowPositionals: true, options: {
      ops: { type: "string" }, write: { type: "boolean" }, help: { type: "boolean", short: "h" }
    } });
    if (values.help) { print("sfd plugin init [<plugin-root>] [--ops <id,…>] [--write]"); return 0; }
    if (positionals.length > 1) throw new UsageError("plugin init accepts at most one plugin root.");
    const { table, review } = await initCliTable(positionals[0] ?? process.cwd(), { ops: values.ops?.split(","), write: values.write });
    print(table);
    for (const line of review) process.stderr.write(`review: ${line}\n`);
    return 0;
  }
  // Select the command before parsing: plugin flags are independent of built-ins.
  if (argv[0] && !argv[0].startsWith("-") && !COMMANDS.some(c => c.name.split(" ")[0] === argv[0])) {
    const command = matchCommand(argv, loadTable());
    if (command) {
      const { values, options: operationOptions } = parseCommand(argv, command);
      if (values.help) { print(pluginManual(command)); return 0; }
      let targetOrg;
      try { targetOrg = resolveTargetOrg(values["target-org"], process.cwd()); } catch {}
      let lastProgress = 0;
      const res = await call("plugin", { operation: command.operation, options: operationOptions, targetOrg,
        apiVersion: values["api-version"], cwd: process.cwd(), confirm: values.confirm, mode: values.plan ? "plan" : "apply" }, { onEvent: event => {
        if (!values.quiet && event.event === "progress" && Date.now() - lastProgress >= 250) {
          lastProgress = Date.now(); process.stderr.write(`progress: ${event.phase ?? ""} ${event.message ?? ""}\n`);
        }
      } });
      if (res.status !== 0) return responseError(res, values);
      const result = res.result;
      return renderPluginResult(result, values, data => formatPlugin(data, command));
    }
  }
  const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: true });
  let [command, ...rest] = positionals;
  if (values.help && command) {
    const key = ["logs get", "org list", "plugin list"].find(name => name === `${command} ${rest[0]}`) ?? command;
    const usage = commandUsage(key);
    if (usage) { print(usage); return 0; }
    throw new UsageError(`Unknown command: ${command}. Run sfd --help.`);
  }
  if (values.help || !command) { print(USAGE); return 0; }

  if (values["sf-json"]) {
    const key = command === "org" && rest[0] === "list" ? "org list" : command;
    if (!SF_JSON_COMMANDS.has(key) || values.csv || values.json || values.limit !== undefined) throw new UsageError("--sf-json requires query, describe, apex, org or org list, without --csv, --json or --limit.");
  }
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
    const block = snippet(loadTable());
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

  if (command === "op" || command === "plugin") {
    if (command === "plugin" && (rest.length !== 1 || rest[0] !== "list")) throw new UsageError("Use sfd plugin list [--json].");
    if (command === "op" && rest.length !== 1) throw new UsageError("op needs exactly one operation id.");
    let lastProgress = 0;
    const onEvent = event => {
      if (values.quiet) return;
      if (event.event === "progress" && Date.now() - lastProgress >= 250) {
        lastProgress = Date.now();
        process.stderr.write(`progress: ${event.phase ?? ""} ${event.done ?? ""}/${event.total ?? ""} ${event.message ?? ""}\n`);
      }
    };
    let args = {};
    if (command === "op") {
      const spec = values["options-json"];
      let operationOptions = {};
      if (spec !== undefined) {
        const text = spec === "-" ? readStdin() : spec.startsWith("@") ? readInputFile(spec.slice(1)) : spec;
        try { operationOptions = JSON.parse(text); } catch { throw new UsageError("--options-json must contain valid JSON."); }
      }
      let targetOrg;
      try { targetOrg = org(); } catch { /* Org-free operations do not need a default. */ }
      args = { operation: rest[0], options: operationOptions, targetOrg, cwd, confirm: values.confirm, mode: values.plan ? "plan" : "apply" };
    }
    const res = await call(command === "op" ? "plugin" : "pluginList", args, { onEvent });
    if (res.status !== 0) return responseError(res, values);
    const result = res.result;
    if (command === "plugin") {
      print(values.json ? result : result.map(p => `${p.name} ${p.version}  ${p.root}  ${p.operations.map(o => `${o.id} [${o.effects.join(",")}]`).join("; ")}  ${p.worker}${p.rss ? ` (${Math.round(p.rss / 1024 / 1024)} MiB)` : ""}${p.problems.length ? `  ${p.problems.join("; ")}` : ""}`).join("\n"));
      return 0;
    }
    return renderPluginResult(result, values, data => JSON.stringify(data) ?? "null");
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
      print(values.json ? s : `sfd ${VERSION} running (pid ${s.pid}, up ${s.uptimeSeconds}s), orgs: ${s.orgs.join(", ") || "none"}\nlog: ${s.log}${s.plugins?.length ? `\nplugins: ${s.plugins.map(p => `${p.name} ${p.worker}${p.rss ? ` ${Math.round(p.rss / 1024 / 1024)} MiB` : ""}`).join(", ")}` : ""}`);
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
      req = { org: org(), q, tooling: values.tooling, all: values.all, raw: values.raw || values["sf-json"], limit };
      if (values.csv) render = result => toCsv(result.records);
      break;
    }
    case "apex": {
      const file = values.file ?? rest[0];
      const body = file ? readInputFile(file) : readStdin();
      if (!body.trim()) throw new UsageError("apex needs code from a file, -f <file>, or stdin.");
      req = { org: org(), body, raw: values["sf-json"] };
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
      req = { org: org(), sobject: rest[0], tooling: values.tooling, raw: values.raw || values["sf-json"] };
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
    case "test": {
      const selectors = {
        classNames: split(values["class-names"]), tests: split(values.tests),
        suiteNames: split(values["suite-names"]), testLevel: values["test-level"]
      };
      if (values.synchronous) {
        const error = synchronousTestError(selectors);
        if (error) throw new UsageError(error);
      }
      req = {
        org: org(), ...selectors, synchronous: values.synchronous,
        logs: values.logs, noTrace: values["no-trace"], codeCoverage: values["code-coverage"], waitMinutes: wait(values)
      };
      render = result => formatTests(result, req.org);
      break;
    }
    case "org":
      if (rest[0] === "list") {
        if (rest.length !== 1 || values["target-org"] !== undefined) throw new UsageError("org list accepts no target org or additional arguments.");
        command = "orgList";
        req = { all: values.all, status: values.status || (values["sf-json"] && !values["skip-connection-status"]), raw: values["sf-json"] };
        render = formatOrgList;
      } else {
        req = { org: org(), raw: values["sf-json"] };
      }
      break;
    default:
      throw new UsageError(`Unknown command: ${command}. Run sfd --help.`);
  }

  if (values.confirm !== undefined) req.confirm = values.confirm;
  const res = await call(command, req);
  if (values["sf-json"]) {
    const envelope = sfEnvelope(command, res);
    print(envelope);
    return envelope.status;
  }
  const trace = res.result?.trace ?? res.trace;
  if (trace) {
    process.stderr.write(`sfd: enabled debug logging for ${trace.username} until ${trace.expires} (TraceFlag ${trace.id})\n`);
  }
  if (res.exitCode === 4) return responseError(res, values);
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

function responseError(res, values) {
  const exitCode = res.exitCode ?? (res.name === "UsageError" ? 2 : 1);
  if (values.json) print(res.approvalRequired ? { status: 4, approvalRequired: res.approvalRequired } : { ...res, status: exitCode });
  else {
    process.stderr.write(`sfd: ${res.message}\n`);
    if (res.summary) process.stderr.write(`plan: ${res.summary}\n`);
    if (res.approvalRequired) process.stderr.write(`re-run with: --confirm ${res.approvalRequired.hash}   (valid 10 min)\n`);
  }
  return exitCode;
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
  if (process.argv.includes("--sf-json")) {
    const exitCode = e instanceof UsageError || e.code?.startsWith?.("ERR_PARSE_ARGS") ? 2 : e instanceof DaemonError || ["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(e.code) ? 3 : 1;
    const command = process.argv[2] === "org" && process.argv[3] === "list" ? "orgList" : process.argv[2];
    print(sfError(command, e, exitCode));
    process.exitCode = exitCode;
  } else if (e instanceof UsageError || e.code?.startsWith?.("ERR_PARSE_ARGS")) {
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

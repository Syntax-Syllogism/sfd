#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { call, isRunning, startDaemon, DaemonError, VERSION } from "../src/client.mjs";
import { findProjectDir, resolveTargetOrg } from "../src/project.mjs";
import { formatApex, formatDeploy, formatTests } from "../src/format.mjs";
import { paths } from "../src/paths.mjs";
import { UsageError } from "../src/usage-error.mjs";

const USAGE = `sfd ${VERSION}: fast Salesforce CLI operations through a warm local daemon

Usage: sfd <command> [options]

Commands:
  query <soql>          Run SOQL (all pages). --tooling, --all (include deleted)
  apex [file]           Run anonymous Apex from a file, -f <file>, or stdin. --log for the full debug log
  rest <path>           Call a REST path, e.g. /services/data/v67.0/limits. -X <method>, --body <json|@file>
  describe <sobject>    Compact describe. --tooling, --raw for the full describe
  deploy                Deploy source. -d <path> (repeatable), -m <Type[:Name]> (repeatable),
                        --check-only, -l <test level>, -t <test> (repeatable), -w <minutes>
  test                  Run Apex tests. -n <class> (repeatable), -t <Class.method> (repeatable),
                        -s <suite> (repeatable), -l <test level>, -c (coverage), -w <minutes>
  org                   Show the resolved org (username, id, instance, API version)
  hook <agent|check|install|uninstall>
                        Integrate with Claude Code, Codex CLI or Gemini CLI
  start | stop | status | reload
                        Manage the daemon. reload drops cached orgs and auth state

Common options:
  -o, --target-org <alias>  Org alias or username (default: sf target-org config)
  --json                    Print the raw JSON response
  -h, --help                Show this help

Exit codes: 0 success, 1 operation failed, 2 usage error, 3 daemon error.`;

const options = {
  "target-org": { type: "string", short: "o" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  tooling: { type: "boolean" },
  all: { type: "boolean" },
  raw: { type: "boolean" },
  log: { type: "boolean" },
  file: { type: "string", short: "f" },
  method: { type: "string", short: "X" },
  body: { type: "string" },
  "source-dir": { type: "string", short: "d", multiple: true },
  metadata: { type: "string", short: "m", multiple: true },
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

function print(value) {
  process.stdout.write((typeof value === "string" ? value : JSON.stringify(value, null, 2)) + "\n");
}

async function run(argv) {
  if (argv[0] === "hook") {
    const { runHook } = await import("../src/hooks.mjs");
    return runHook(argv.slice(1));
  }
  const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: true });
  const [command, ...rest] = positionals;
  if (values.help || !command) { print(USAGE); return 0; }

  const cwd = process.cwd();
  const org = () => resolveTargetOrg(values["target-org"], cwd);
  const projectDir = () => {
    const dir = findProjectDir(cwd);
    if (!dir) throw new UsageError("No sfdx-project.json found in this directory or its parents.");
    return dir;
  };

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
      req = { org: org(), q, tooling: values.tooling, all: values.all, raw: values.raw };
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
    case "test":
      req = {
        org: org(), classNames: split(values["class-names"]), tests: split(values.tests), suiteNames: split(values["suite-names"]),
        testLevel: values["test-level"], codeCoverage: values["code-coverage"], waitMinutes: wait(values)
      };
      render = result => formatTests(result, req.org);
      break;
    case "org":
      req = { org: org() };
      break;
    default:
      throw new UsageError(`Unknown command: ${command}. Run sfd --help.`);
  }

  const res = await call(command, req);
  if (values.json) { print(res); return res.status === 0 ? okStatus(command, res.result) : 1; }
  if (res.status !== 0) {
    process.stderr.write(`${res.name}: ${res.message}\n`);
    return 1;
  }
  print(render(res.result));
  return okStatus(command, res.result);
}

// A request can succeed while the Salesforce operation fails (compile error, failed deploy or test).
function okStatus(command, result) {
  if (command === "apex") return result.compiled && result.success ? 0 : 1;
  if (command === "deploy") return result.success ? 0 : 1;
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

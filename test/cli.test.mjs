import { socketPath } from '../src/paths.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, cpSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS } from "../src/commands.mjs";
import { VERSION } from "../src/version.mjs";

const bin = fileURLToPath(new URL("../bin/sfd.mjs", import.meta.url));
const runtime = mkdtempSync(join(tmpdir(), "sfd-cli-"));
const sfRoot = mkdtempSync(join(tmpdir(), "sfd-sfroot-"));
writeFileSync(join(sfRoot, "package.json"), JSON.stringify({ name: "@salesforce/cli", version: "9.9.9" }));

const env = {
  ...process.env,
  SFD_RUNTIME_DIR: runtime,
  SFD_SF_ROOT: sfRoot,
  SFD_HANDLERS_MODULE: fileURLToPath(new URL("./fixtures/stub-handlers.mjs", import.meta.url)),
  SFD_PLUGIN_PATHS_ONLY: "1",
  SFD_PLUGIN_PATHS: fileURLToPath(new URL("./fixtures/plugins/echo", import.meta.url)),
  SF_TARGET_ORG: "stub-org"
};
const sfd = (args, input) => spawnSync(process.execPath, [bin, ...args], { env, input, encoding: "utf8" });

test.after(() => sfd(["stop"]));

test("version is printed without starting the daemon", () => {
  const result = sfd(["--version", "query", "ignored", "--sf-json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `sfd ${VERSION}\n`, JSON.stringify(result));
  assert.equal(result.stderr, "");
  assert.equal(existsSync(join(runtime, "sfd.sock")), false);
  assert.equal(existsSync(join(runtime, "sfd.pid")), false);
});

test("help lists commands and guides and renders command manuals without starting the daemon", () => {
  for (const args of [["help"], ["help", "-a"], ["help", "--all"], ["help", "-g"], ["help", "--guides"], ["help", "logs", "get"], ["help", "agent-hooks"], ["help", "--help"]]) {
    const result = sfd(args);
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
    assert.equal(result.stderr, "", args.join(" "));
  }
  const all = sfd(["help"]);
  assert.match(all.stdout, /Commands:/);
  assert.match(all.stdout, /Guides:/);
  assert.match(all.stdout, /agent-hooks/);
  const guides = sfd(["help", "-g"]);
  assert.doesNotMatch(guides.stdout, /Commands:/);
  assert.match(guides.stdout, /debug-logs/);
  const logs = sfd(["help", "logs", "get"]);
  assert.match(logs.stdout, /Filtered output/);
  assert.match(logs.stdout, /Tips for agents/);
  const guide = sfd(["help", "agent-hooks"]);
  assert.match(guide.stdout, /^# Agent hooks/m);
  assert.match(sfd(["help", "--help"]).stdout, /--guides\s+List guides only/);
  const unknown = sfd(["help", "nope"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Unknown help topic: nope/);
  assert.match(unknown.stderr, /sfd help -a/);
  assert.equal(unknown.stdout, "");
  assert.equal(existsSync(join(runtime, "sfd.sock")), false);
  assert.equal(existsSync(join(runtime, "sfd.pid")), false);
});

test("command help is specific for every registered command", () => {
  for (const entry of COMMANDS) {
    const args = [...entry.name.split(" "), "--help"];
    const result = sfd(args);
    assert.equal(result.status, 0, `${entry.name}: ${result.stderr}`);
    assert.equal(result.stderr, "", entry.name);
    if (entry.name === "hook") {
      assert.match(result.stdout, /Usage: sfd hook/);
    } else if (entry.name === "discover") {
      assert.match(result.stdout, /sfd discover/);
    } else {
      assert.ok(result.stdout.startsWith(`Usage: sfd ${entry.name}`), `${entry.name}: ${result.stdout}`);
      assert.ok(result.stdout.includes(entry.summary.split("\n")[0]), entry.name);
    }
  }
  for (const name of ["org list", "agents-snippet", "start", "stop", "status", "reload"]) {
    const result = sfd([...name.split(" "), "--help"]);
    assert.doesNotMatch(result.stdout, /-o, --target-org/, name);
  }
  for (const name of ["agents-snippet", "start", "stop", "reload"]) {
    const result = sfd([name, "--help"]);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /--json/, name);
    assert.match(result.stdout, /-h, --help/, name);
  }
  for (const name of ["query", "org list", "status"]) {
    const result = sfd([...name.split(" "), "--help"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--json/, name);
  }
  assert.match(sfd(["query", "--help"]).stdout, /-o, --target-org/);
  const all = sfd(["--help"]);
  assert.equal(all.status, 0);
  assert.match(all.stdout, /--version\s+Print the sfd version/);
  for (const { name } of COMMANDS) assert.ok(all.stdout.includes(name), name);
  const unknown = sfd(["bogus", "--help"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Unknown command: bogus/);
  assert.match(unknown.stderr, /Run sfd --help/);
  assert.equal(unknown.stdout, "");
});


test("invalid synchronous selectors fail before org resolution or daemon startup", () => {
  for (const selectors of [["-s", "S", "-n", "A"], ["-n", "A", "-n", "B"], ["-n", "A,B"], ["-t", "A.x", "-t", "B.y"],
    ["-t", "ns.A.x", "-t", "ns.B.y"], ["-n", "A", "-t", "B.x"], ["-l", "RunLocalTests", "-n", "A"], ["-l", "RunAllTestsInOrg"],
    ["-n", "A", "-s", ","], ["-n", "A", "--test-level="], []]) {
    const result = spawnSync(process.execPath, [bin, "test", "-y", ...selectors], {
      env: { ...env, SF_TARGET_ORG: "" }, encoding: "utf8"
    });
    assert.equal(result.status, 2, JSON.stringify(result));
    assert.match(result.stderr, /Synchronous/);
    assert.equal(result.stdout, "");
    assert.equal(existsSync(join(runtime, "sfd.pid")), false);
  }
});

test("auto-starts the daemon and runs a query against the resolved org", () => {
  const r = sfd(["query", "SELECT Id FROM Account"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).records, [{ org: "stub-org", q: "SELECT Id FROM Account" }]);
  assert.equal(r.stdout, JSON.stringify({ totalSize: 1, done: true, records: [{ org: "stub-org", q: "SELECT Id FROM Account" }] }, null, 2) + "\n");
  assert.equal(r.stderr, "");
  assert.match(sfd(["status"]).stdout, /running/);
});

test("apex reads stdin and exits 1 on a compile error", () => {
  const ok = sfd(["apex", "-o", "other"], "System.debug('hi');");
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, "OK\n[1] hi\n");
  const bad = sfd(["apex"], "bad code");
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /COMPILE ERROR/);
});

test("handler errors exit 1 and usage errors exit 2", () => {
  const failed = sfd(["test", "-n", "FooTest"]);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /ConnectionError: org unreachable/);
  assert.equal(sfd(["frobnicate"]).status, 2);
  assert.equal(sfd(["query", "--no-such-flag"]).status, 2);
});

test("stop shuts the daemon down", () => {
  assert.equal(sfd(["stop"]).status, 0);
  for (let i = 0; i < 50 && !/not running/.test(sfd(["status"]).stdout); i++) spawnSync("sleep", ["0.05"]);
  assert.match(sfd(["status"]).stdout, /not running/);
});

test("unreadable Apex and REST body files are usage errors with their paths", () => {
  const missing = join(runtime, "missing.apex");
  for (const args of [["apex", "-f", missing], ["apex", missing], ["rest", "/limits", "--body", `@${missing}`]]) {
    const result = sfd(args);
    assert.equal(result.status, 2, result.stderr);
    assert.ok(result.stderr.includes(missing));
    assert.doesNotMatch(result.stderr, /daemon error/);
  }
});

test("deploy splits comma-separated and repeated source directories before resolving", () => {
  const project = join(runtime, "project");
  mkdirSync(project);
  for (const name of ["one", "two", "three"]) mkdirSync(join(project, name));
  writeFileSync(join(project, "sfdx-project.json"), "{}");
  const result = spawnSync(process.execPath, [bin, "deploy", "-d", "one,two", "-d", "three", "--json"], { cwd: project, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).result.sourcePaths, ["one", "two", "three"].map(name => join(project, name)));
});


test("retrieve and tracking pass selectors and filters and preserve exit codes in text and JSON", () => {
  const project = join(runtime, "retrieve-project");
  mkdirSync(project);
  for (const name of ["one", "two"]) mkdirSync(join(project, name));
  writeFileSync(join(project, "sfdx-project.json"), "{}");
  writeFileSync(join(project, "package.xml"), "<Package/>");
  const run = args => spawnSync(process.execPath, [bin, ...args], { cwd: project, env, encoding: "utf8" });
  const paths = run(["retrieve", "-d", "one,two", "-w", "2", "--json"]);
  assert.equal(paths.status, 0, paths.stderr);
  assert.deepEqual(JSON.parse(paths.stdout).result.sourcePaths, ["one", "two"].map(name => join(project, name)));
  assert.equal(JSON.parse(paths.stdout).result.waitMinutes, 2);
  const manifest = run(["retrieve", "-x", "package.xml", "--json"]);
  assert.equal(manifest.status, 0, manifest.stderr);
  assert.equal(JSON.parse(manifest.stdout).result.manifest, join(project, "package.xml"));
  const metadata = run(["retrieve", "-m", "ApexClass:Foo,ApexClass:Bar", "--json"]);
  assert.deepEqual(JSON.parse(metadata.stdout).result.metadata, ["ApexClass:Foo", "ApexClass:Bar"]);
  assert.equal(run(["retrieve"]).status, 0);
  for (const json of [[], ["--json"]]) {
    const conflict = run(["retrieve", "-o", "conflict", ...json]);
    assert.equal(conflict.status, 1, conflict.stderr);
    assert.match(conflict.stdout, json.length ? /"success": false/ : /CONFLICTS/);
    assert.equal(run(["retrieve", "-o", "conflict", "--ignore-conflicts", ...json]).status, 0);
    for (const cmd of ["retrieve", "tracking"]) {
      const untracked = run([cmd, "-o", "untracked", ...json]);
      assert.equal(untracked.status, 2, untracked.stderr);
      assert.match(json.length ? untracked.stdout : untracked.stderr, /source tracking/);
    }
  }
  assert.equal(run(["tracking"]).stdout, "No changes.\n");
  const filters = run(["tracking", "--remote", "--conflicts", "--json"]);
  assert.equal(filters.status, 0, filters.stderr);
  for (const args of [["retrieve", "-d", "missing"], ["retrieve", "-x", "missing"], ["retrieve", "-d", "one", "-m", "ApexClass"],
    ["retrieve", "-x", "package.xml", "-m", "ApexClass"], ["retrieve", "-w", "0"], ["tracking", "--local", "--remote"]]) {
    assert.equal(run(args).status, 2, args.join(" "));
  }
});


test("logs renders lists, notices, filtered/raw/JSON bodies and validates arguments", () => {
  const list = sfd(["logs", "--count", "2", "--user", "agent"]);
  assert.equal(list.status, 0, list.stderr);
  assert.equal(list.stdout, "07L000000000001 2026-10-22 14:02:11 test Success 2.0 KB 30ms\n");
  assert.match(list.stderr, /sfd: enabled debug logging for agent until .*TraceFlag 7tf/);
  const noTrace = sfd(["logs", "--no-trace", "--limit", "3", "--json"]);
  assert.equal(noTrace.status, 0, noTrace.stderr);
  assert.equal(noTrace.stderr, "");
  assert.equal(JSON.parse(noTrace.stdout).result.noTrace, true);
  assert.equal(JSON.parse(noTrace.stdout).result.count, 3);
  const filtered = sfd(["logs", "get", "latest", "--no-trace"]);
  assert.equal(filtered.status, 0, filtered.stderr);
  assert.equal(filtered.stdout, "test Failed 30ms 2.0 KB\n[1] hello\n");
  const full = sfd(["logs", "get", "07L000000000001", "--full"]);
  assert.equal(full.status, 0, full.stderr);
  assert.equal(full.stdout, "x|EXECUTION_STARTED\nx|USER_DEBUG|[1]|DEBUG|hello\n");
  const json = sfd(["logs", "get", "latest", "--json"]);
  assert.equal(json.status, 0, json.stderr);
  assert.match(JSON.parse(json.stdout).result.body, /EXECUTION_STARTED/);
  for (const args of [["logs", "get"], ["logs", "other"], ["logs", "get", "latest", "extra"], ["logs", "--count", "0"], ["logs", "--count", "2.5"]]) {
    assert.equal(sfd(args).status, 2, args.join(" "));
  }
  const tests = sfd(["test", "-n", "FooTest", "--logs", "--no-trace"]);
  assert.equal(tests.status, 1, tests.stderr);
  assert.match(tests.stdout, /Logs:\n  07L000000000001\n    test Failed.*\n    \[1\] hello/);
  const testJson = sfd(["test", "--logs", "--no-trace", "--json"]);
  assert.equal(testJson.status, 1);
  assert.equal(JSON.parse(testJson.stdout).result.noTrace, true);
});


test("TraceFlag notices survive a subsequent log error in text and JSON", () => {
  for (const flags of [[], ["--json"]]) {
    const result = sfd(["logs", "get", "missing", ...flags]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /enabled debug logging for agent/);
    if (flags.length) assert.equal(JSON.parse(result.stdout).trace.id, "7tf");
    else assert.match(result.stderr, /No debug logs found/);
  }
});


test("query CSV and truncation trailers respect stdout, stderr and JSON modes", () => {
  const trailer = "… 5,011 more rows not shown (totalSize 5,012); raise --limit or narrow the query\n";
  const csv = sfd(["query", "rows", "--csv", "--limit", "1"]);
  assert.equal(csv.status, 0, csv.stderr);
  assert.equal(csv.stdout, "Name,Owner.Name\nA,User\n");
  assert.equal(csv.stderr, trailer);
  const uncapped = sfd(["query", "rows", "--csv"]);
  assert.equal(uncapped.status, 0, uncapped.stderr);
  assert.equal(uncapped.stdout, "Name,Owner.Name\nA,User\nB,\n");
  assert.equal(uncapped.stderr, "");
  const text = sfd(["query", "rows", "--limit", "1"]);
  assert.equal(text.status, 0, text.stderr);
  assert.ok(text.stdout.endsWith("\n" + trailer));
  assert.equal(JSON.parse(text.stdout.slice(0, -trailer.length)).records.length, 1);
  assert.equal(text.stderr, "");
  const json = sfd(["query", "rows", "--limit", "1", "--csv", "--json"]);
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).result.truncated, true);
  assert.equal(JSON.parse(json.stdout).result.records.length, 1);
  assert.equal(json.stderr, "");
  const empty = sfd(["query", "empty", "--csv"]);
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(empty.stdout, "");
  for (const limit of ["0", "abc", "-1", "1.5", "Infinity", "9007199254740992"]) {
    const result = sfd(["query", "rows", `--limit=${limit}`]);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /--limit must be a positive integer/);
    assert.equal(result.stdout, "");
  }
});

test("org list dispatches without a target org, renders text and returns the public JSON shape", () => {
  const list = sfd(["org", "list"]);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /\*  dev user Org/);
  const json = sfd(["org", "list", "--all", "--status", "--json"]);
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), { orgs: [{ alias: "all", username: "user", type: "Org", isDefault: true, status: "Connected" }] });
  for (const args of [["-o", "x"], ["extra"]]) assert.equal(sfd(["org", "list", ...args]).status, 2);
  const display = sfd(["org", "-o", "other", "--json"]);
  assert.equal(display.status, 0, display.stderr);
  assert.equal(JSON.parse(display.stdout).result.alias, "other");
});

test("metadata CLI renders types, members and details and passes selectors", () => {
  const types = sfd(["list-metadata-types"]);
  assert.equal(types.status, 0, types.stderr);
  assert.equal(types.stdout, "1 metadata types (API v67.0)\nApexClass\n");
  assert.equal(JSON.parse(sfd(["list-metadata-types", "--json"]).stdout).result.cached, true);
  assert.equal(sfd(["list-metadata", "-m", "Flow"]).stdout, "Name\n");
  assert.equal(sfd(["list-metadata", "-m", "Flow", "--details"]).stdout, "Name  unmanaged\n");
  const multiple = sfd(["list-metadata", "-m", "Flow,Layout", "-m", "ApexClass", "-o", "other", "--json"]);
  assert.equal(multiple.status, 0, multiple.stderr);
  assert.deepEqual(JSON.parse(multiple.stdout).result.types, ["Flow", "Layout", "ApexClass"]);
  assert.equal(JSON.parse(multiple.stdout).result.org, "other");
  const folder = sfd(["list-metadata", "-m", "Report", "--folder", "Public"]);
  assert.equal(folder.status, 0, folder.stderr);
  assert.equal(folder.stdout, "Public/Name\n");
  for (const args of [["list-metadata"], ["list-metadata", "-m", ","], ["list-metadata", "-m", "Report,Dashboard", "--folder", "x"]]) {
    assert.equal(sfd(args).status, 2);
  }
  for (const json of [[], ["--json"]]) {
    const bad = sfd(["list-metadata", "-m", "ApexClas", ...json]);
    assert.equal(bad.status, 2);
    assert.match(json.length ? bad.stdout : bad.stderr, /Did you mean ApexClass/);
  }
});

test('--sf-json prints envelopes without stderr and validates combinations', () => {
  for (const args of [['query', 'q'], ['describe', 'Account'], ['org'], ['org', 'list']]) {
    const result = sfd([...args, '--sf-json']);
    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.status, 0);
    assert.ok(Array.isArray(envelope.warnings));
    assert.equal(result.stderr, '');
  }
  const query = JSON.parse(sfd(['query', 'q', '--sf-json']).stdout);
  assert.deepEqual(query.result.records[0].attributes, { type: 'Account' });
  assert.deepEqual(query.warnings, []);
  assert.equal(JSON.parse(sfd(['describe', 'Account', '--sf-json']).stdout).result.full, true);
  const queryError = sfd(['query', 'bad', '--sf-json']);
  assert.equal(queryError.status, 1);
  assert.equal(queryError.stderr, '');
  assert.deepEqual(JSON.parse(queryError.stdout), { name: 'INVALID_FIELD', message: 'Invalid field', exitCode: 1, context: 'DataSoqlQueryCommand', data: { message: 'Invalid field', errorCode: 'INVALID_FIELD' }, warnings: [], code: '1', status: 1, commandName: 'DataSoqlQueryCommand' });
  const bad = sfd(['apex', '--sf-json'], 'bad code');
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout).name, 'executeCompileFailure');
  assert.equal(bad.stderr, '');
  for (const args of [['query', 'q', '--csv'], ['query', 'q', '--json'], ['query', 'q', '--limit', '1'], ['status'], ['test'], ['query'], ['hook', 'check', 'sf org display'], ['discover']]) {
    const result = sfd([...args, '--sf-json']);
    assert.equal(result.status, 2, result.stdout);
    assert.equal(JSON.parse(result.stdout).exitCode, 2);
    assert.equal(result.stderr, '');
  }
});

test('--sf-json daemon failure remains JSON with exit 3', async () => {
  const { createServer } = await import('node:net');
  const { spawn } = await import('node:child_process');
  const dir = join(runtime, 'bad-response');
  mkdirSync(dir);
  const server = createServer(socket => socket.once('data', () => socket.end('invalid JSON')));
  await new Promise(resolve => server.listen(socketPath(dir), resolve));
  try {
    const child = spawn(process.execPath, [bin, 'query', 'q', '--sf-json'], { env: { ...env, SFD_RUNTIME_DIR: dir } });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const status = await new Promise(resolve => child.on('close', resolve));
    assert.equal(status, 3, stderr);
    assert.equal(JSON.parse(stdout).exitCode, 3);
    assert.equal(stderr, '');
  } finally { await new Promise(resolve => server.close(resolve)); }
});


test("synchronous flags and selectors reach the daemon and preserve test exit codes", () => {
  assert.match(sfd(["test", "--help"]).stdout, /-y\/--synchronous/);
  for (const selectors of [["-n", "A"], ["-n", "A", "-n", "A"], ["-n", "A", "-t", "A.one"], ["-t", "ns.A.one,ns.A.two"]]) {
    const result = sfd(["test", "--synchronous", ...selectors, "-l", "RunSpecifiedTests", "-w", "2", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const { result: payload } = JSON.parse(result.stdout);
    assert.equal(payload.synchronous, true);
    assert.equal(payload.waitMinutes, 2);
    assert.equal(payload.testLevel, "RunSpecifiedTests");
  }
  const passed = sfd(["test", "-y", "-n", "A"]);
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(passed.stdout, "Tests Passed on stub-org: 1 ran, 1 passed, 0 failed in 12 ms\n");
  for (const json of [[], ["--json"]]) {
    const failed = sfd(["test", "-y", "-t", "A.one", "--logs", ...json]);
    assert.equal(failed.status, 1, failed.stderr);
  }
});


test("plugin CLI runs operations, previews and applies plans, reads files and stdin", () => {
  const first = sfd(["op", "echo.say", "--options-json", '{"text":"hi"}', "--json"]);
  assert.equal(first.status, 0, first.stderr);
  const envelope = JSON.parse(first.stdout); assert.equal(envelope.ok, true); assert.equal(envelope.data.text, "hi");
  assert.equal(JSON.parse(sfd(["op", "echo.say", "--json"]).stdout).data.pid, envelope.data.pid);
  const file = join(runtime, "options.json"); writeFileSync(file, '{"text":"file"}');
  assert.equal(JSON.parse(sfd(["op", "echo.say", "--options-json", `@${file}`]).stdout).text, "file");
  assert.equal(JSON.parse(sfd(["op", "echo.say", "--options-json", "-"], '{"text":"stdin"}').stdout).text, "stdin");
  assert.equal(JSON.parse(sfd(["op", "echo.write", "--plan"]).stdout).summary, "echo write");
  assert.equal(JSON.parse(sfd(["op", "echo.say"]).stdout).applied, 0);
  assert.equal(JSON.parse(sfd(["op", "echo.write"]).stdout).applied, 1);
  assert.equal(sfd(["op", "echo.overreach"]).status, 1);
  assert.equal(sfd(["op", "echo.say", "--plan"]).status, 2);
  assert.equal(sfd(["op", "echo.say", "--options-json", "bad"]).status, 2);
  const unknown = sfd(["op", "echo.sa"]); assert.equal(unknown.status, 1); assert.match(unknown.stderr, /echo.say/);
  const list = sfd(["plugin", "list", "--json"]); assert.equal(list.status, 0, list.stderr);
  assert.ok(JSON.parse(list.stdout).some(p => p.name === "sfd-plugin-echo" && p.rss > 0));
  assert.match(sfd(["op", "echo.slow"]).stderr, /progress: wait/);
  assert.equal(sfd(["op", "echo.slow", "--quiet"]).stderr, "");
  assert.equal(JSON.parse(sfd(["op", "echo.whoami", "-o", "alias"]).stdout).username, "alias@example.com");
});


test("plugin command dispatch, help, hook, snippet and generator", () => {
  const result = sfd(["echo", "say", "--text", "hi"]);
  assert.equal(result.status, 0, JSON.stringify(result));
  assert.equal(JSON.parse(result.stdout).text, "hi");
  const json = sfd(["echo", "say", "--text", "hi", "--json"]);
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).data.text, "hi");
  for (const args of [["echo", "say", "--help"], ["help", "echo", "say"]]) {
    const help = sfd(args); assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /--text.*required/);
  }
  assert.equal(sfd(["echo", "say"]).status, 2);
  assert.equal(sfd(["echo", "say", "--text", "hi", "--unknown"]).status, 2);
  assert.match(sfd(["agents-snippet"]).stdout, /sfd echo say/);
  const hook = sfd(["hook", "check", "sf echo say --text hi"]);
  assert.equal(hook.status, 0, hook.stderr);
  assert.match(hook.stdout, /sfd echo say/);
  const generated = sfd(["plugin", "init", env.SFD_PLUGIN_PATHS, "--ops", "echo.say"]);
  assert.equal(generated.status, 0, generated.stderr);
  assert.equal(JSON.parse(generated.stdout).apiVersion, 0);
  assert.match(generated.stderr, /review:/);
});

test("approval errors preserve exit 4, stderr, JSON and sf envelopes through daemon IPC", () => {
  const args = ["apex", "-o", "policy-prod"];
  const body = "System.debug('policy');";
  const first = sfd([...args, "--json"], body);
  assert.equal(first.status, 4, first.stderr);
  const response = JSON.parse(first.stdout);
  assert.equal(response.status, 4);
  assert.equal(response.approvalRequired.effect, "org-write");
  assert.equal(response.approvalRequired.orgType, "production");
  const hash = response.approvalRequired.hash;
  assert.match(hash, /^[a-f0-9]{12}$/);
  const text = sfd(args, body);
  assert.equal(text.status, 4);
  assert.match(text.stderr, /approval required: org-write on production/);
  assert.match(text.stderr, /plan:/);
  assert.ok(text.stderr.includes(`--confirm ${hash}`));
  const sf = sfd([...args, "--sf-json"], body);
  assert.equal(sf.status, 4);
  assert.equal(JSON.parse(sf.stdout).name, "ApprovalRequired");
  assert.equal(JSON.parse(sf.stdout).exitCode, 4);
  assert.equal(sf.stderr, "");
  assert.equal(sfd([...args, "--confirm", hash], body).status, 0);
  assert.equal(sfd([...args, "--confirm", hash], body).status, 4);
  const denied = sfd(["apex", "-o", "policy-deny", "--confirm", hash, "--json"], body);
  assert.equal(denied.status, 4);
  assert.equal(JSON.parse(denied.stdout).name, "PolicyDenied");
  assert.equal(JSON.parse(denied.stdout).approvalRequired, undefined);
});

test("direct plugin commands keep exit 4, the confirm hint and single-use --confirm", t => {
  // A private copy of the echo plugin with a direct write command and its own daemon.
  const root = mkdtempSync(join(tmpdir(), "sfd-echo-write-"));
  cpSync(env.SFD_PLUGIN_PATHS, root, { recursive: true });
  const table = JSON.parse(readFileSync(join(root, "cli.json"), "utf8"));
  table.commands.push({ operation: "echo.write", name: ["echo", "write"], summary: "Echo write", flags: [], formatter: "json" });
  writeFileSync(join(root, "cli.json"), JSON.stringify(table));
  const local = { ...env, SFD_RUNTIME_DIR: mkdtempSync(join(tmpdir(), "sfd-cli-direct-")), SFD_PLUGIN_PATHS: root };
  const sfd = (args, input) => spawnSync(process.execPath, [bin, ...args], { env: local, input, encoding: "utf8" });
  t.after(() => sfd(["stop"]));
  const args = ["echo", "write", "-o", "policy-prod"];
  const blocked = sfd(args);
  assert.equal(blocked.status, 4, blocked.stderr);
  const hash = /--confirm ([a-f0-9]{12})/.exec(blocked.stderr)?.[1];
  assert.ok(hash, blocked.stderr);
  const json = sfd([...args, "--json"]);
  assert.equal(json.status, 4);
  assert.equal(JSON.parse(json.stdout).approvalRequired.hash, hash);
  const preview = sfd([...args, "--plan"]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stderr, /policy: ask/);
  assert.equal(sfd([...args, "--confirm", hash]).status, 0);
  assert.equal(sfd([...args, "--confirm", hash]).status, 4);
});

test("plugin CLI --plan issues a hash and --confirm applies through the host gate", () => {
  const args = ["op", "echo.write", "-o", "policy-prod", "--options-json", '{"n":7}'];
  assert.equal(sfd(args).status, 4);
  const preview = sfd([...args, "--plan", "--json"]);
  assert.equal(preview.status, 0, preview.stderr);
  const { policy } = JSON.parse(preview.stdout);
  assert.equal(policy.decision, "ask");
  assert.equal(sfd([...args, "--confirm", policy.hash]).status, 0);
  assert.equal(sfd([...args, "--confirm", policy.hash]).status, 4);
});

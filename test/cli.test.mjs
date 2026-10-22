import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(new URL("../bin/sfd.mjs", import.meta.url));
const runtime = mkdtempSync(join(tmpdir(), "sfd-cli-"));
const sfRoot = mkdtempSync(join(tmpdir(), "sfd-sfroot-"));
writeFileSync(join(sfRoot, "package.json"), JSON.stringify({ name: "@salesforce/cli", version: "9.9.9" }));

const env = {
  ...process.env,
  SFD_RUNTIME_DIR: runtime,
  SFD_SF_ROOT: sfRoot,
  SFD_HANDLERS_MODULE: fileURLToPath(new URL("./fixtures/stub-handlers.mjs", import.meta.url)),
  SF_TARGET_ORG: "stub-org"
};
const sfd = (args, input) => spawnSync(process.execPath, [bin, ...args], { env, input, encoding: "utf8" });

test.after(() => sfd(["stop"]));

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

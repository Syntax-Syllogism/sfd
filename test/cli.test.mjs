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

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Real-org check: SFD_TEST_ORG=<alias> npm test
const org = process.env.SFD_TEST_ORG;
const bin = fileURLToPath(new URL("../bin/sfd.mjs", import.meta.url));
const sfd = (args, input) => spawnSync(process.execPath, [bin, "-o", org, ...args], { input, encoding: "utf8" });

test("query, apex and describe against a real org", { skip: !org && "set SFD_TEST_ORG to run" }, () => {
  const q = sfd(["query", "SELECT Id FROM User LIMIT 1"]);
  assert.equal(q.status, 0, q.stderr);
  assert.equal(JSON.parse(q.stdout).records.length, 1);

  const apex = sfd(["apex"], "System.debug(40 + 2);");
  assert.equal(apex.status, 0, apex.stderr);
  assert.match(apex.stdout, /\[1\] 42/);

  const d = sfd(["describe", "Account"]);
  assert.equal(d.status, 0, d.stderr);
  assert.ok(JSON.parse(d.stdout).fields.some(f => f.name === "Name"));
});


test("retrieve an existing Apex class into a temporary project", { skip: !org && "set SFD_TEST_ORG to run" }, t => {
  const query = sfd(["query", "SELECT Name FROM ApexClass WHERE NamespacePrefix = null LIMIT 1"]);
  assert.equal(query.status, 0, query.stderr);
  const name = JSON.parse(query.stdout).records[0]?.Name;
  if (!name) { t.skip("org has no unmanaged Apex class to retrieve"); return; }
  const project = mkdtempSync(join(tmpdir(), "sfd-retrieve-org-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(join(project, "force-app"));
  writeFileSync(join(project, "sfdx-project.json"), JSON.stringify({ packageDirectories: [{ path: "force-app", default: true }] }));
  const result = spawnSync(process.execPath, [bin, "retrieve", "-o", org, "-m", `ApexClass:${name}`, "--json"], { cwd: project, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).result.success, true);
  assert.ok(existsSync(join(project, "force-app", "main", "default", "classes", `${name}.cls`)));
});


test("enable tracing then fetch latest log after anonymous Apex", { skip: !org && "set SFD_TEST_ORG to run" }, () => {
  const enabled = sfd(["logs"]);
  assert.equal(enabled.status, 0, enabled.stderr);
  const apex = sfd(["apex"], "System.debug('sfd debug log check');");
  assert.equal(apex.status, 0, apex.stderr);
  const latest = sfd(["logs", "get", "latest"]);
  assert.equal(latest.status, 0, latest.stderr);
  assert.match(latest.stdout, /sfd debug log check/);
});

test("metadata listing against a real org", { skip: !org && "set SFD_TEST_ORG to run" }, () => {
  const types = sfd(["list-metadata-types", "--json"]);
  assert.equal(types.status, 0, types.stderr);
  assert.ok(JSON.parse(types.stdout).result.types.some(type => type.name === "ApexClass"));
  const members = sfd(["list-metadata", "-m", "ApexClass", "--json"]);
  assert.equal(members.status, 0, members.stderr);
  assert.ok(JSON.parse(members.stdout).result.groups[0].members.some(member => member.fullName));
});

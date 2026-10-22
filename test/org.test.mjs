import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

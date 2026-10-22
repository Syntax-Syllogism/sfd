import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findProjectDir, resolveTargetOrg } from "../src/project.mjs";

function tree() {
  const root = mkdtempSync(join(tmpdir(), "sfd-project-"));
  const home = join(root, "home");
  const project = join(home, "work", "proj");
  const nested = join(project, "force-app", "main");
  mkdirSync(nested, { recursive: true });
  mkdirSync(join(home, ".sf"), { recursive: true });
  writeFileSync(join(project, "sfdx-project.json"), "{}");
  return { home, project, nested };
}

const setOrg = (dir, org) => {
  mkdirSync(join(dir, ".sf"), { recursive: true });
  writeFileSync(join(dir, ".sf", "config.json"), JSON.stringify({ "target-org": org }));
};

test("findProjectDir walks up to the nearest sfdx-project.json", () => {
  const { home, project, nested } = tree();
  assert.equal(findProjectDir(nested), project);
  assert.equal(findProjectDir(home), undefined);
});

test("resolveTargetOrg prefers flag, then env, then local config, then global config", () => {
  const { home, project, nested } = tree();
  setOrg(home, "global-org");
  assert.equal(resolveTargetOrg(undefined, nested, {}, home), "global-org");
  setOrg(project, "local-org");
  assert.equal(resolveTargetOrg(undefined, nested, {}, home), "local-org");
  assert.equal(resolveTargetOrg(undefined, nested, { SF_TARGET_ORG: "env-org" }, home), "env-org");
  assert.equal(resolveTargetOrg("flag-org", nested, { SF_TARGET_ORG: "env-org" }, home), "flag-org");
});

test("resolveTargetOrg treats the home .sf/config.json as global, not local", () => {
  const { home, nested } = tree();
  assert.throws(() => resolveTargetOrg(undefined, nested, {}, home), /No target org/);
});

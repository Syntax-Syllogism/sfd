import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { discoverPlugins, sfDataDir, createDiscovery } from "../src/plugin/discover.mjs";

test("discover registry dependencies and links without importing; extra roots and only-mode", t => {
  const dir = mkdtempSync(join(tmpdir(), "sfd-discover-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  function plugin(root, manifest = {apiVersion: 0, operations: "./ops.mjs"}) {
    mkdirSync(root, {recursive: true});
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: root, version: "1.0.0", ...(manifest === null ? {} : { sfd: manifest }) }));
    writeFileSync(join(root, "ops.mjs"), "throw new Error('must not import');"); return root;
  }
  const user = plugin(join(dir, "node_modules", "user"));
  const link = plugin(join(dir, "linked"));
  const extra = plugin(join(dir, "extra"));
  const invalid = plugin(join(dir, "invalid"), {apiVersion: 7, operations: "./ops.mjs"});
  const newer = plugin(join(dir, "newer"), {apiVersion: 0, operations: "./ops.mjs", requires: {sfd: ">=99.0.0"}});
  const unsupported = plugin(join(dir, "range"), {apiVersion: 0, operations: "./ops.mjs", requires: {sfd: "^0.5.0"}});
  const plain = plugin(join(dir, "plain"), null);
  writeFileSync(join(dir, "package.json"), JSON.stringify({dependencies:{user:"*"}, oclif:{plugins:[{root:link,type:"link"},{root:user},{root:plain},{root:invalid},{root:newer},{root:unsupported}]}}));
  const env = { SF_DATA_DIR: dir, SFD_PLUGIN_PATHS: extra };
  const found = discoverPlugins({env}); assert.equal(found.length, 6);
  assert.equal(found.filter(p => p.root === user).length, 1);
  assert.match(found.find(p => p.root === invalid).problems.join(), /unsupported/);
  assert.match(found.find(p => p.root === newer).problems.join(), /requires sfd/);
  assert.match(found.find(p => p.root === unsupported).problems.join(), /only >=/);
  assert.deepEqual(discoverPlugins({env:{...env, SFD_PLUGIN_PATHS_ONLY:"1"}}).map(p => p.root), [extra]);
  assert.equal(discoverPlugins({env:{SF_DATA_DIR:join(dir,"absent")}}).length, 0);
  assert.equal(sfDataDir({XDG_DATA_HOME:dir}, "linux"), join(dir,"sf"));
  assert.equal(sfDataDir({LOCALAPPDATA:dir}, "win32"), join(dir,"sf"));
});

test("operations cannot escape root through a symlink", {skip:process.platform === "win32"}, t => {
  const dir = mkdtempSync(join(tmpdir(), "sfd-escape-")); t.after(() => rmSync(dir,{recursive:true,force:true}));
  const root=join(dir,"plugin"); mkdirSync(root); writeFileSync(join(dir,"outside.mjs"), "");
  symlinkSync(join(dir,"outside.mjs"), join(root,"ops.mjs"));
  writeFileSync(join(root,"package.json"), JSON.stringify({name:"escape",sfd:{apiVersion:0,operations:"./ops.mjs"}}));
  assert.match(discoverPlugins({env:{SFD_PLUGIN_PATHS_ONLY:"1",SFD_PLUGIN_PATHS:root}})[0].problems.join(), /inside/);
});


test("cached discovery refreshes package edits and registry installs", t => {
  const dir = mkdtempSync(join(tmpdir(),"sfd-cached-")); t.after(() => rmSync(dir,{recursive:true,force:true}));
  const root = join(dir,"plugin"); mkdirSync(root); writeFileSync(join(root,"ops.mjs"), "");
  const pkg = {name:"cached",version:"1.0.0",sfd:{apiVersion:0,operations:"./ops.mjs"}};
  const registry = join(dir,"package.json");
  writeFileSync(registry, '{}'); writeFileSync(join(root,"package.json"), JSON.stringify(pkg));
  const discover = createDiscovery({env:{SF_DATA_DIR:dir}});
  assert.deepEqual(discover(), []);
  writeFileSync(registry, JSON.stringify({oclif:{plugins:[{root}]}}));
  const first = discover(); assert.equal(first.length,1); assert.equal(discover(),first);
  pkg.version="1.0.10"; writeFileSync(join(root,"package.json"),JSON.stringify(pkg));
  assert.equal(discover()[0].version,"1.0.10");
  const cached = discover(); assert.notEqual(discover(true), cached);
});

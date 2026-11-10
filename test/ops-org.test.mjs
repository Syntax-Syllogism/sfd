import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { orgListFixture, sfCapture } from "./fixtures/sf-modules.mjs";

test("org list reads local primary users, resolves aliases/defaults, filters expiry and allows only public fields", async t => {
  const f = orgListFixture(t);
  f.fields.set("primary", { orgId: "00D000000000001AAA", instanceUrl: "https://example", isDevHub: true,
    accessToken: "access-secret", refreshToken: "refresh-secret", clientSecret: "client-secret" });
  f.fields.set("secondary", { orgId: "00D000000000001AAA" });
  f.fields.set("default-secondary", { orgId: "00D000000000001AAA", isSandbox: true, decryptFails: true });
  f.fields.set("unreadable", { unreadable: true });
  f.fields.set("expired", { expirationDate: "2000-01-01", devHubUsername: "primary" });
  f.fields.set("scratch", { expirationDate: "2099-01-01" });
  writeFileSync(join(f.home, ".sfdx", "00D000000000001AAA.json"), JSON.stringify({ usernames: ["primary", "secondary", "default-secondary"] }));
  f.aliases.set("primary", ["hub"]);
  f.aliases.set("default-secondary", ["dev", "other"]);
  f.defaults["target-org"] = "other";
  f.defaults["target-dev-hub"] = "primary";
  const warnings = f.warnings;
  const result = await f.handlers.orgList({});
  assert.equal(result.hiddenExpired, 1);
  assert.deepEqual(result.orgs.map(o => o.username), ["scratch", "default-secondary", "primary"]);
  assert.equal(result.orgs.find(o => o.username === "default-secondary").isDefault, true);
  assert.equal(result.orgs.find(o => o.username === "default-secondary").type, "Sandbox");
  assert.deepEqual(result.orgs.find(o => o.username === "primary"), {
    alias: "hub", username: "primary", orgId: "00D000000000001AAA", instanceUrl: "https://example",
    type: "DevHub", safetyType: "unknown", isDefault: false, isDefaultDevHub: true
  });
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(JSON.stringify([result, warnings]), /access-secret|refresh-secret|client-secret|list-secret|secret auth failure|accessToken|refreshToken|clientSecret/);
  assert.deepEqual(f.calls.creates, []);
  assert.equal((await f.handlers.orgList({ all: true })).orgs.length, 4);
  assert.deepEqual((await f.handlers.orgList({ all: true })).orgs.find(o => o.username === "expired").expired, true);
});

test("org list warnings use the request-scoped logger", async t => {
  const f = orgListFixture(t);
  f.fields.set("unreadable", { unreadable: true });
  const records = [];
  await f.handlers.orgList({}, { log: { warn: message => records.push({ reqId: "r42", message }) } });
  assert.deepEqual(records, [{ reqId: "r42", message: "orgList: skipping unreadable local authorization" }]);
  assert.deepEqual(f.warnings, []);
});

test("org list handles absent auth and invalidates state for login/logout stamps", async t => {
  const f = orgListFixture(t);
  f.setListingError(Object.assign(new Error(), { name: "NoAuthInfoFound" }));
  assert.deepEqual(await f.handlers.orgList({}), { orgs: [], hiddenExpired: 0 });
  f.setListingError(new Error("unexpected"));
  await assert.rejects(f.handlers.orgList({}), /unexpected/);
  f.setListingError(undefined);
  f.fields.set("first", {});
  await f.handlers.orgList({ status: true });
  assert.equal(f.calls.creates.length, 1);
  writeFileSync(join(f.home, ".sfdx", "new-user.json"), "{}");
  const future = new Date(Date.now() + 10000);
  utimesSync(join(f.home, ".sfdx"), future, future);
  f.fields.delete("first");
  f.fields.set("second", {});
  const result = await f.handlers.orgList({});
  assert.equal(f.calls.clears, 1);
  assert.equal(result.orgs[0].username, "second");
});

test("org list checks connections concurrently, bounds hangs and retries failed refreshes", async t => {
  const f = orgListFixture(t);
  for (const name of ["hanging", "working", "broken"]) f.fields.set(name, {});
  f.behavior.set("hanging", () => new Promise(() => {}));
  f.behavior.set("broken", () => { throw Object.assign(new Error("secret"), { name: "RefreshTokenAuthError" }); });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const resultPromise = f.handlers.orgList({ status: true });
  // Let the async auth/Org.create steps settle before advancing the deadline.
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls.refreshes.sort(), ["broken", "hanging", "working"]);
  t.mock.timers.tick(10000);
  const result = await resultPromise;
  assert.deepEqual(result.orgs.map(o => [o.username, o.status]), [
    ["broken", "RefreshTokenAuthError"], ["hanging", "Timeout"], ["working", "Connected"]
  ]);
  f.behavior.delete("hanging");
  f.behavior.delete("broken");
  await f.handlers.orgList({ status: true });
  assert.equal(f.calls.creates.filter(name => name === "working").length, 1);
  assert.equal(f.calls.creates.filter(name => name === "broken").length, 2);
  assert.equal(f.calls.creates.filter(name => name === "hanging").length, 2);
});

test("org list queries each Dev Hub once and uses live scratch status before filtering", async t => {
  const f = orgListFixture(t);
  for (const [username, orgId, hub] of [["active", "00D000000000001AAA", "hub"], ["expired", "00D000000000002AAA", "hub"], ["offline", "00D000000000003AAA", "bad-hub"]]) {
    f.fields.set(username, { orgId, expirationDate: "2099-01-01", devHubUsername: hub });
  }
  f.behavior.set("hub", () => ({ records: [
    { ScratchOrg: "00D000000000001", Status: "Active", ExpirationDate: "2099-02-01" },
    { ScratchOrg: "00D000000000002", Status: "Expired", ExpirationDate: "2000-01-01" }
  ] }));
  f.behavior.set("bad-hub", () => { throw new Error("unavailable"); });
  const result = await f.handlers.orgList({ status: true });
  assert.equal(f.calls.queries.length, 2);
  assert.match(f.calls.queries.find(q => q.username === "hub").query, /IN \('00D000000000001','00D000000000002'\)/);
  assert.deepEqual(f.calls.refreshes, []);
  assert.equal(result.hiddenExpired, 1);
  assert.equal(result.orgs.find(o => o.username === "active").status, "Active");
  assert.equal(result.orgs.find(o => o.username === "active").expirationDate, "2099-02-01");
  assert.equal(result.orgs.find(o => o.username === "offline").status, undefined);
});

test("org list retries Dev Hub limit errors and reports exhausted limits", async t => {
  const f = orgListFixture(t);
  f.fields.set("scratch", { orgId: "00D000000000001AAA", expirationDate: "2099-01-01", devHubUsername: "hub" });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let attempts = 0;
  const failure = () => Object.assign(new Error("quota"), { errorCode: "REQUEST_LIMIT_EXCEEDED" });
  f.behavior.set("hub", () => {
    if (++attempts === 1) throw failure();
    return { records: [{ ScratchOrg: "00D000000000001", Status: "Active" }] };
  });
  let pending = f.handlers.orgList({ status: true });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(1300);
  assert.equal((await pending).orgs[0].status, "Active");
  assert.equal(attempts, 2);
  attempts = 0;
  f.behavior.set("hub", () => { attempts++; throw failure(); });
  pending = f.handlers.orgList({ status: true });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(1300);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(3900);
  await assert.rejects(pending, /REQUEST_LIMIT_EXCEEDED: quota/);
  assert.equal(attempts, 3);
});

test("org list returns on a hung Dev Hub and reports late exhausted limits", async t => {
  const f = orgListFixture(t);
  const warnings = f.warnings;
  f.fields.set("scratch", { orgId: "00D000000000001AAA", expirationDate: "2099-01-01", devHubUsername: "hub" });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release, attempts = 0;
  f.behavior.set("hub", async () => {
    if (++attempts === 1) await new Promise(resolve => { release = resolve; });
    throw Object.assign(new Error("quota"), { errorCode: "REQUEST_LIMIT_EXCEEDED" });
  });
  let pending = f.handlers.orgList({ status: true });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(10000);
  assert.equal((await pending).orgs[0].status, "Timeout");
  release();
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(1300);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(3900);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(warnings[0], /REQUEST_LIMIT_EXCEEDED/);
  assert.equal(attempts, 3);

  f.behavior.set("hub", async () => {
    await new Promise(resolve => { release = resolve; });
    throw new Error("unavailable");
  });
  pending = f.handlers.orgList({ status: true });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(10000);
  assert.equal((await pending).orgs[0].status, "Timeout");
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(warnings.length, 1);
});

test('raw org list preserves sf fields, enriches scratch rows, and excludes auth secrets', async t => {
  const { sfEnvelope } = await import('../src/sf-json.mjs');
  const f = orgListFixture(t);
  const expected = sfCapture('org-list');
  const { nonScratchOrgs, scratchOrgs } = expected.result;
  const computed = ['accessToken', 'alias', 'lastUsed', 'isDefaultUsername', 'isDefaultDevHubUsername', 'defaultMarker', 'connectedStatus', 'signupUsername', 'createdBy', 'createdDate', 'devHubOrgId', 'devHubId', 'attributes', 'orgName', 'edition', 'status', 'isExpired', 'namespace'];
  for (const entry of [...nonScratchOrgs, ...scratchOrgs]) {
    f.fields.set(entry.username, { ...Object.fromEntries(Object.entries(entry).filter(([key]) => !computed.includes(key))), accessToken: 'access-secret', refreshToken: 'refresh-secret', clientSecret: 'client-secret', sfdxAuthUrl: 'force://secret' });
    f.aliases.set(entry.username, [entry.alias]);
    const file = join(f.home, '.sfdx', `${entry.username}.json`);
    writeFileSync(file, '{}');
    utimesSync(file, new Date(entry.lastUsed), new Date(entry.lastUsed));
  }
  f.defaults['target-dev-hub'] = nonScratchOrgs[0].username;
  f.behavior.set(nonScratchOrgs[0].username, () => ({ records: scratchOrgs.map(row => ({ ScratchOrg: row.orgId.slice(0, 15), SignupUsername: row.signupUsername, CreatedBy: { Username: row.createdBy }, CreatedDate: row.createdDate, OrgName: row.orgName, Edition: row.edition, Status: row.status, ExpirationDate: row.expirationDate, Namespace: row.namespace, attributes: row.attributes })) }));
  // The live hub supplies its own id; it is not a ScratchOrgInfo field.
  f.calls.hubId = nonScratchOrgs[0].orgId;
  const result = await f.handlers.orgList({ all: true, status: true, raw: true });
  const actual = sfEnvelope('orgList', { status: 0, result });
  assert.deepEqual(actual, expected);
  assert.doesNotMatch(JSON.stringify(actual), /access-secret|refresh-secret|client-secret|force:\/\//);
});

for (const name of ['org-display-nonscratch', 'org-display-scratch']) test(`raw display handler: ${name}`, async t => {
  const { sfEnvelope } = await import('../src/sf-json.mjs');
  const f = orgListFixture(t);
  const expected = sfCapture(name), row = expected.result;
  f.fields.set(row.username, { orgId: row.id, username: row.username, instanceUrl: row.instanceUrl, instanceApiVersion: row.apiVersion, clientId: row.clientId, devHubUsername: row.devHubId,
    accessToken: 'access-secret', refreshToken: 'refresh-secret', clientSecret: 'client-secret', sfdxAuthUrl: 'force://secret' });
  f.aliases.set(row.username, [row.alias]);
  if (row.devHubId) f.behavior.set(row.devHubId, () => ({ records: [{ Status: row.status, ExpirationDate: row.expirationDate, CreatedBy: { Username: row.createdBy }, Edition: row.edition, OrgName: row.orgName, CreatedDate: row.createdDate, SignupUsername: row.signupUsername }] }));
  const result = await f.handlers.org({ org: row.username, raw: true });
  assert.deepEqual(sfEnvelope('org', { status: 0, result }), expected);
  assert.doesNotMatch(JSON.stringify(result), /access-secret|refresh-secret|client-secret|force:\/\//);
});

test("org list holds timed-out slots until the work settles", async t => {
  const f = orgListFixture(t);
  const releases = [];
  for (let i = 0; i < 6; i++) {
    const name = `org${i}`;
    f.fields.set(name, {});
    f.behavior.set(name, () => new Promise(resolve => releases.push(resolve)));
  }
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = f.handlers.orgList({ status: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.refreshes.length, 4);
  t.mock.timers.tick(10000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.refreshes.length, 4);
  releases[0](); releases[1]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.refreshes.length, 6);
  t.mock.timers.tick(10000);
  const result = await pending;
  assert.ok(result.orgs.every(org => org.status === "Timeout"));
  releases.forEach(resolve => resolve());
});

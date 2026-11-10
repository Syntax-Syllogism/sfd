import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, deferred } from "./fixtures/sf-modules.mjs";

test("deploy options omit test keys unless requested and tests imply their level", async () => {
  const { handlers, calls } = fixture();
  await handlers.deploy({});
  assert.deepEqual(calls.deploys[0].apiOptions, { checkOnly: false, rollbackOnError: true });
  await handlers.deploy({ tests: ["One", "Two"] });
  assert.deepEqual(calls.deploys[1].apiOptions, { checkOnly: false, rollbackOnError: true, testLevel: "RunSpecifiedTests", runTests: ["One", "Two"] });
  await handlers.deploy({ testLevel: "RunLocalTests" });
  assert.equal(calls.deploys[2].apiOptions.testLevel, "RunLocalTests");
  assert.equal(Object.hasOwn(calls.deploys[2].apiOptions, "runTests"), false);
});

test("concurrent deploys serialize and read fresh project configuration", async () => {
  const { handlers, calls, state, projectFile } = fixture();
  await Promise.all([handlers.deploy({ metadata: ["ApexClass"] }), handlers.deploy({})]);
  assert.equal(state.maxActive, 1);
  writeFileSync(projectFile, JSON.stringify({ sourceApiVersion: "67.0", packageDirectories: ["two"] }));
  await handlers.deploy({ metadata: ["ApexClass"] });
  assert.equal(calls.builds[0].sourceapiversion, "66.0");
  assert.equal(calls.builds[2].sourceapiversion, "67.0");
  assert.deepEqual(calls.builds[2].metadata.directoryPaths, ["two"]);
});

test("source tracking updates only after successful real deploys to tracking orgs", async () => {
  for (const success of [false, true]) for (const checkOnly of [false, true]) for (const tracks of [false, true]) {
    const { handlers, calls, state } = fixture();
    Object.assign(state, { success, tracks });
    await handlers.deploy({ checkOnly });
    assert.equal(calls.tracking, Number(success && !checkOnly && tracks));
  }
});

for (const operation of ["deploy", "retrieve"]) {
  test(`${operation} disconnect releases the project queue and skips tracking`, async () => {
    const { handlers, state, calls, home, messages } = fixture();
    const poll = deferred();
    const started = deferred();
    state[`${operation}Poll`] = () => { started.resolve(); return poll.promise; };
    const controller = new AbortController();
    const request = handlers[operation]({ org: "dev", projectDir: home, metadata: ["ApexClass:Foo"] }, { signal: controller.signal });
    await started.promise;
    controller.abort();
    await assert.rejects(request, { name: "Aborted" });
    // The library poll is still pending; the next project request must run anyway.
    state.active = 0;
    await handlers.tracking({ projectDir: home });
    assert.match(messages[0], new RegExp(`${operation}.*dev.*${operation}-123.*source tracking not updated`));
    poll.resolve();
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(calls.tracking, 0);
    assert.equal(calls.retrieveTracking, 0);
  });
}

test("disconnected queued project work never starts", async () => {
  const { handlers, state, calls } = fixture();
  const poll = deferred();
  const started = deferred();
  state.deployPoll = () => { started.resolve(); return poll.promise; };
  const first = handlers.deploy({});
  await started.promise;
  const controller = new AbortController();
  const second = handlers.deploy({}, { signal: controller.signal });
  controller.abort();
  poll.resolve();
  await first;
  await assert.rejects(second, { name: "Aborted" });
  assert.equal(calls.deploys.length, 1);
});

test("retrieve builds selectors, merges source, polls and updates tracking only on success", async () => {
  for (const tracks of [false, true]) for (const success of [false, true]) {
    const { handlers, calls, state, home } = fixture();
    Object.assign(state, { tracks, success });
    const result = await handlers.retrieve({ projectDir: home, metadata: ["ApexClass:Foo"], waitMinutes: 7 });
    assert.equal(result.success, success);
    assert.deepEqual(calls.builds[0].metadata, { metadataEntries: ["ApexClass:Foo"], directoryPaths: ["one"] });
    assert.equal(calls.builds[0].sourceapiversion, "66.0");
    assert.equal(calls.retrieves[0].output, join(home, "one"));
    assert.equal(calls.retrieves[0].merge, true);
    assert.equal(calls.retrieves[0].format, "source");
    assert.deepEqual(calls.polls[0], { frequency: 2000, timeout: 420000 });
    assert.equal(calls.retrieveTracking, Number(tracks && success));
    assert.ok(calls.trackingOptions.every(o => !o.subscribeSDREvents && o.ignoreLocalCache));
  }
  const { handlers, calls, home } = fixture();
  await handlers.retrieve({ projectDir: home, manifest: "/package.xml" });
  assert.deepEqual(calls.builds[0].manifest, { manifestPath: "/package.xml", directoryPaths: ["one"] });
  await handlers.retrieve({ projectDir: home, sourcePaths: ["/classes"] });
  assert.deepEqual(calls.builds[1].sourcepath, ["/classes"]);
});

test("retrieve refuses selected conflicts before writes, and ignore-conflicts bypasses refusal", async () => {
  const { handlers, state, calls, home } = fixture();
  state.conflicts = [{ type: "ApexClass", name: "Foo", filenames: [join(home, "Foo.cls")] }];
  const conflict = await handlers.retrieve({ projectDir: home, metadata: ["ApexClass:Foo"] });
  assert.equal(conflict.success, false);
  assert.equal(conflict.conflicts[0].path, "Foo.cls");
  assert.equal(conflict.conflicts[0].state, "Conflict");
  assert.equal(calls.retrieves.length, 0);
  await handlers.retrieve({ projectDir: home });
  assert.equal(calls.deletes, 0);
  await handlers.retrieve({ projectDir: home, metadata: ["ApexClass:Foo"], ignoreConflicts: true });
  assert.equal(calls.retrieves.length, 1);
  state.conflicts[0].name = "Unselected";
  await handlers.retrieve({ projectDir: home, metadata: ["ApexClass:Foo"] });
  assert.equal(calls.retrieves.length, 2);
});

test("retrieve handles remote changes, deletions, empty sets and non-tracked orgs", async () => {
  const { handlers, state, calls, home } = fixture();
  await handlers.retrieve({ projectDir: home });
  assert.equal(calls.deletes, 1);
  assert.equal(calls.retrieveTracking, 1);
  state.size = 0;
  const empty = await handlers.retrieve({ projectDir: home });
  assert.equal(empty.success, true);
  assert.equal(empty.message, "No remote changes to retrieve.");
  state.deletedFiles = [{ state: "Deleted", type: "ApexClass", fullName: "Old", filePath: join(home, "Old.cls") }];
  const deleted = await handlers.retrieve({ projectDir: home });
  assert.equal(deleted.files[0].state, "Deleted");
  assert.equal(deleted.files[0].path, "Old.cls");
  assert.equal(calls.retrieves.length, 1);
  await assert.rejects(handlers.retrieve({ projectDir: home, metadata: ["Missing"] }), /Nothing to retrieve/);
  state.tracks = false;
  await assert.rejects(handlers.retrieve({ projectDir: home }), { name: "UsageError" });
});

test("tracking resolves status rows, filters origins, includes deletions and reports conflicts", async () => {
  const { handlers, state, calls, home } = fixture();
  state.rows = [
    { state: "add", origin: "local", type: "ApexClass", fullName: "New", filePath: join(home, "New.cls") },
    { state: "delete", origin: "remote", type: "ApexClass", fullName: "Old" },
    { state: "modify", origin: "local", ignored: true, type: "ApexClass", fullName: "Ignored" }
  ];
  state.conflicts = Array.from({ length: 2 }, () => ({ type: "ApexClass", name: "Foo", filenames: ["Foo.cls"] }));
  const result = await handlers.tracking({ projectDir: home });
  assert.equal(result.local.length, 1);
  assert.equal(result.local[0].path, "New.cls");
  assert.equal(result.remote[0].state, "delete");
  assert.equal(result.conflicts[0].fullName, "Foo");
  assert.equal((await handlers.tracking({ projectDir: home, local: true })).remote.length, 0);
  assert.equal((await handlers.tracking({ projectDir: home, remote: true })).local.length, 0);
  assert.deepEqual(calls.changes, [{ local: true, remote: true }, { local: true, remote: false }, { local: false, remote: true }]);
  const conflicts = await handlers.tracking({ projectDir: home, conflicts: true });
  assert.deepEqual(conflicts.local, []);
  assert.equal(conflicts.conflicts.length, 1);
  assert.equal(calls.changes.length, 3);
  state.tracks = false;
  await assert.rejects(handlers.tracking({ projectDir: home }), { name: "UsageError" });
});

test("retrieves, tracking and deploys share the project queue", async () => {
  const { handlers, state, home } = fixture();
  await Promise.all([handlers.retrieve({ projectDir: home, metadata: ["ApexClass:Foo"] }), handlers.deploy({}), handlers.tracking({ projectDir: home })]);
  assert.equal(state.maxActive, 1);
});

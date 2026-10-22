import test from "node:test";
import assert from "node:assert/strict";
import {
  compactDescribe, compactQuery, formatApex, formatDeploy, formatTests, stripAttributes, summarizeDeploy, summarizeTests
} from "../src/format.mjs";

test("compactQuery strips attributes at every depth", () => {
  const result = compactQuery({
    totalSize: 1, done: true,
    records: [{ attributes: { type: "Account" }, Name: "A", Owner: { attributes: { type: "User" }, Name: "U" } }]
  });
  assert.deepEqual(result, { totalSize: 1, done: true, records: [{ Name: "A", Owner: { Name: "U" } }] });
  assert.equal(stripAttributes(null), null);
});

test("compactDescribe keeps the fields an agent needs", () => {
  const d = compactDescribe({
    name: "X__c", label: "X", keyPrefix: "a00", custom: true, createable: true, updateable: true, deletable: true,
    fields: [
      { name: "Id", type: "id", label: "Id", length: 18, nillable: false, createable: false, updateable: false },
      { name: "Kind__c", type: "picklist", label: "Kind", nillable: false, createable: true, updateable: true, defaultedOnCreate: false,
        picklistValues: [{ value: "A", active: true }, { value: "B", active: false }] },
      { name: "Parent__c", type: "reference", label: "Parent", nillable: true, createable: true, updateable: true, referenceTo: ["Account"] },
      { name: "Calc__c", type: "string", label: "Calc", nillable: true, createable: false, updateable: false, calculated: true }
    ],
    childRelationships: [{ relationshipName: "Kids__r", childSObject: "Kid__c", field: "X__c" }, { relationshipName: null }]
  });
  assert.deepEqual(d.fields[1], { name: "Kind__c", type: "picklist", label: "Kind", picklistValues: ["A"], required: true });
  assert.deepEqual(d.fields[2].referenceTo, ["Account"]);
  assert.equal(d.fields[3].formula, true);
  assert.equal(d.fields[3].readOnly, true);
  assert.deepEqual(d.childRelationships, ["Kids__r (Kid__c.X__c)"]);
});

test("formatApex keeps debug and fatal lines, or the full log on request", () => {
  const logs = [
    "12:00:00.1 (1)|EXECUTION_STARTED",
    "12:00:00.1 (2)|USER_DEBUG|[3]|DEBUG|hello",
    "12:00:00.1 (3)|FATAL_ERROR|System.NullPointerException: boom"
  ].join("\n");
  const failed = { compiled: true, success: false, logs, diagnostic: [{ exceptionMessage: "boom", exceptionStackTrace: "AnonymousBlock: line 3" }] };
  assert.equal(formatApex(failed), "EXCEPTION\n  ✖ boom\n    AnonymousBlock: line 3\n[3] hello\nFATAL: System.NullPointerException: boom");
  assert.match(formatApex({ compiled: true, success: true, logs }, { fullLog: true }), /EXECUTION_STARTED/);
  assert.equal(
    formatApex({ compiled: false, success: false, diagnostic: [{ compileProblem: "Unexpected token", lineNumber: 1, columnNumber: 9 }] }),
    "COMPILE ERROR\n  ✖ Unexpected token [1:9]"
  );
});

test("summarizeDeploy and formatDeploy report component, test and coverage failures", () => {
  const summary = summarizeDeploy({
    id: "0Af1", status: "Failed", success: false, checkOnly: true,
    numberComponentsDeployed: 0, numberComponentsTotal: 2, numberTestsCompleted: 1, numberTestsTotal: 2, numberTestErrors: 1,
    details: {
      componentFailures: { componentType: "ApexClass", fullName: "Foo", problem: "Missing ;", lineNumber: 4, columnNumber: 2 },
      runTestResult: {
        failures: [{ name: "FooTest", methodName: "itWorks", message: "Assertion failed" }],
        codeCoverageWarnings: { name: "Foo", message: "Test coverage of selected Apex Class is 0%" }
      }
    }
  });
  assert.equal(formatDeploy(summary, "dev"), [
    "FAILED (Failed) dev (0Af1)",
    "  ✖ ApexClass Foo: Missing ; [4:2]",
    "  ✖ test FooTest.itWorks: Assertion failed",
    "  ✖ coverage Foo: Test coverage of selected Apex Class is 0%"
  ].join("\n"));

  const ok = summarizeDeploy({ id: "0Af2", status: "Succeeded", success: true, checkOnly: false, numberComponentsDeployed: 3, numberComponentsTotal: 3, numberTestsTotal: 0 });
  assert.equal(formatDeploy(ok, "dev"), "Deployed 3/3 components to dev (0Af2)");
});

test("summarizeTests and formatTests list failures and coverage", () => {
  const summary = summarizeTests({
    summary: { outcome: "Failed", testRunId: "707", testsRan: 2, passing: 1, failing: 1, skipped: 0, testExecutionTimeInMs: 50, testRunCoverage: "80%", orgWideCoverage: "70%" },
    tests: [
      { fullName: "FooTest.a", outcome: "Pass" },
      { fullName: "FooTest.b", outcome: "Fail", message: "nope", stackTrace: "Class.FooTest.b: line 9\nline 2" }
    ],
    codecoverage: [{ name: "Foo", percentage: "80%", uncoveredLines: [7, 8] }]
  });
  assert.equal(formatTests(summary, "dev"), [
    "Tests Failed on dev: 2 ran, 1 passed, 1 failed in 50 ms (707)",
    "Coverage: run 80%, org-wide 70%",
    "  ✖ FooTest.b: nope",
    "    Class.FooTest.b: line 9",
    "    line 2",
    "   80% Foo uncovered: 7,8"
  ].join("\n"));
});

test("compact query retains continuation for incomplete results", () => {
  assert.deepEqual(compactQuery({ totalSize: 100001, done: false, records: [], nextRecordsUrl: "/next" }),
    { totalSize: 100001, done: false, records: [], nextRecordsUrl: "/next" });
});

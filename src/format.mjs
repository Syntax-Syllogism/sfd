// Compact, token-friendly renderings of Salesforce results.

const asArray = x => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);

export function stripAttributes(value) {
  if (Array.isArray(value)) return value.map(stripAttributes);
  if (value === null || typeof value !== "object") return value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    if (key !== "attributes") out[key] = stripAttributes(inner);
  }
  return out;
}

export function compactQuery(result) {
  return { totalSize: result.totalSize, done: result.done, ...(result.nextRecordsUrl ? { nextRecordsUrl: result.nextRecordsUrl } : {}), records: stripAttributes(result.records ?? []) };
}

export function compactDescribe(d) {
  return {
    name: d.name, label: d.label, keyPrefix: d.keyPrefix, custom: d.custom,
    createable: d.createable, updateable: d.updateable, deletable: d.deletable,
    fields: d.fields.map(f => {
      const field = { name: f.name, type: f.type, label: f.label };
      if (f.length) field.length = f.length;
      if (f.referenceTo?.length) field.referenceTo = f.referenceTo;
      if (f.picklistValues?.length) field.picklistValues = f.picklistValues.filter(p => p.active).map(p => p.value);
      if (!f.nillable && f.createable && !f.defaultedOnCreate) field.required = true;
      if (!f.updateable) field.readOnly = true;
      if (f.calculated) field.formula = true;
      return field;
    }),
    childRelationships: d.childRelationships.filter(c => c.relationshipName).map(c => `${c.relationshipName} (${c.childSObject}.${c.field})`)
  };
}

const loc = d => (d.lineNumber ? ` [${d.lineNumber}:${d.columnNumber ?? ""}]` : "");

export function formatApex(result, { fullLog = false } = {}) {
  const lines = [];
  if (!result.compiled) {
    lines.push("COMPILE ERROR");
    for (const d of asArray(result.diagnostic)) lines.push(`  ✖ ${d.compileProblem ?? d.exceptionMessage}${loc(d)}`);
    return lines.join("\n");
  }
  lines.push(result.success ? "OK" : "EXCEPTION");
  if (!result.success) {
    for (const d of asArray(result.diagnostic)) {
      lines.push(`  ✖ ${d.exceptionMessage}`);
      if (d.exceptionStackTrace) lines.push(`    ${d.exceptionStackTrace}`);
    }
  }
  const log = result.logs ?? "";
  if (fullLog) {
    lines.push(log);
  } else {
    // Keep only USER_DEBUG and fatal lines; the rest of a debug log is noise for agents.
    for (const line of log.split("\n")) {
      const m = line.match(/\|USER_DEBUG\|\[(\d+)\]\|\w+\|(.*)$/);
      if (m) lines.push(`[${m[1]}] ${m[2]}`);
      else if (/\|FATAL_ERROR\|/.test(line)) lines.push(line.replace(/^.*\|FATAL_ERROR\|/, "FATAL: "));
    }
  }
  return lines.join("\n");
}

export function formatDeploy(summary, org) {
  const action = summary.checkOnly ? "Validated" : "Deployed";
  const tests = summary.numberTestsTotal > 0
    ? `, tests ${summary.numberTestsCompleted}/${summary.numberTestsTotal}${summary.numberTestErrors ? ` (${summary.numberTestErrors} failed)` : ""}`
    : "";
  const head = summary.success
    ? `${action} ${summary.numberComponentsDeployed}/${summary.numberComponentsTotal} components${tests} to ${org} (${summary.id})`
    : `FAILED (${summary.status}) ${org} (${summary.id})`;
  const lines = [head];
  for (const c of summary.componentFailures) lines.push(`  ✖ ${c.type} ${c.fullName}: ${c.problem}${loc(c)}`);
  for (const t of summary.testFailures) lines.push(`  ✖ test ${t.name}.${t.methodName}: ${t.message}`);
  for (const w of summary.coverageWarnings ?? []) lines.push(`  ✖ coverage${w.name ? ` ${w.name}` : ""}: ${w.message}`);
  if (summary.errorMessage && !summary.componentFailures.length) lines.push(`  ${summary.errorMessage}`);
  return lines.join("\n");
}

// Reduce an SDR DeployResult response to the fields formatDeploy and --json callers need.
export function summarizeDeploy(response) {
  const details = response.details ?? {};
  return {
    id: response.id,
    status: response.status,
    success: response.success,
    checkOnly: response.checkOnly,
    numberComponentsDeployed: response.numberComponentsDeployed,
    numberComponentsTotal: response.numberComponentsTotal,
    numberComponentErrors: response.numberComponentErrors,
    numberTestsCompleted: response.numberTestsCompleted,
    numberTestsTotal: response.numberTestsTotal,
    numberTestErrors: response.numberTestErrors,
    errorMessage: response.errorMessage,
    componentFailures: asArray(details.componentFailures).map(c => ({
      type: c.componentType, fullName: c.fullName, problem: c.problem, lineNumber: c.lineNumber, columnNumber: c.columnNumber
    })),
    testFailures: asArray(details.runTestResult?.failures).map(t => ({
      name: t.name, methodName: t.methodName, message: t.message, stackTrace: t.stackTrace
    })),
    coverageWarnings: asArray(details.runTestResult?.codeCoverageWarnings).map(w => ({ name: w.name, message: w.message }))
  };
}

export function summarizeTests(result) {
  const s = result.summary;
  return {
    outcome: s.outcome, testRunId: s.testRunId, testsRan: s.testsRan, passing: s.passing, failing: s.failing,
    skipped: s.skipped, testExecutionTimeInMs: s.testExecutionTimeInMs,
    testRunCoverage: s.testRunCoverage, orgWideCoverage: s.orgWideCoverage,
    failures: asArray(result.tests).filter(t => t.outcome !== "Pass" && t.outcome !== "Skip").map(t => ({
      name: t.fullName ?? `${t.apexClass?.name}.${t.methodName}`, outcome: t.outcome, message: t.message, stackTrace: t.stackTrace
    })),
    setupFailures: asArray(result.setup).filter(s => s.message).map(s => ({ name: s.fullName, message: s.message, stackTrace: s.stackTrace })),
    coverage: result.codecoverage
      ? result.codecoverage.map(c => ({ name: c.name, percentage: c.percentage, uncoveredLines: c.uncoveredLines }))
      : undefined
  };
}

export function formatTests(summary, org) {
  const parts = [`${summary.testsRan} ran`, `${summary.passing} passed`, `${summary.failing} failed`];
  if (summary.skipped) parts.push(`${summary.skipped} skipped`);
  const lines = [`Tests ${summary.outcome} on ${org}: ${parts.join(", ")} in ${summary.testExecutionTimeInMs} ms (${summary.testRunId})`];
  if (summary.testRunCoverage) lines.push(`Coverage: run ${summary.testRunCoverage}, org-wide ${summary.orgWideCoverage}`);
  for (const s of summary.setupFailures) lines.push(`  ✖ setup ${s.name}: ${s.message}`);
  for (const f of summary.failures) {
    lines.push(`  ✖ ${f.name}: ${f.message}`);
    if (f.stackTrace) lines.push(`    ${f.stackTrace.replace(/\n/g, "\n    ")}`);
  }
  for (const c of summary.coverage ?? []) {
    lines.push(`  ${c.percentage.padStart(4)} ${c.name}${c.uncoveredLines.length ? ` uncovered: ${c.uncoveredLines.join(",")}` : ""}`);
  }
  return lines.join("\n");
}

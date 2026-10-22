import { relative, resolve } from "node:path";

// Compact, token-friendly renderings of Salesforce results.

export const asArray = x => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);

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

export function flattenRecord(record, prefix = "") {
  const out = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "attributes") continue;
    const column = prefix + key;
    if (value === null || typeof value !== "object") out[column] = value;
    else if (Array.isArray(value.records)) out[column] = JSON.stringify(stripAttributes(value.records));
    else Object.assign(out, flattenRecord(value, column + "."));
  }
  return out;
}

export function toCsv(records) {
  if (!records.length) return "";
  const rows = records.map(record => flattenRecord(record));
  const keys = [...new Set(rows.flatMap(row => Object.keys(row)))];
  // A null parent supplies empty cells for its dotted columns, not an extra column.
  const columns = keys.filter(key => !keys.some(other => other.startsWith(key + ".")) || rows.some(row => row[key] != null));
  const escape = value => {
    const text = value == null ? "" : String(value);
    return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
  };
  return [columns.map(escape).join(","), ...rows.map(row => columns.map(key => escape(row[key])).join(","))].join("\n");
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
    lines.push(...filterLog(log, { apexOnly: true }));
  }
  return lines.join("\n");
}

// Anonymous Apex retains its original two-event rendering.
export function filterLog(text, { apexOnly = false } = {}) {
  const lines = [];
  let inLimits = false;
  for (const line of text.split(/\r?\n/)) {
    const debug = line.match(/\|USER_DEBUG\|\[(\d+|EXTERNAL)\]\|\w+\|(.*)$/);
    if (debug && (!apexOnly || debug[1] !== "EXTERNAL")) { lines.push(`[${debug[1]}] ${debug[2]}`); continue; }
    if (/\|FATAL_ERROR\|/.test(line)) { lines.push(line.replace(/^.*\|FATAL_ERROR\|/, "FATAL: ")); continue; }
    if (apexOnly) continue;
    const event = line.match(/\|(EXCEPTION_THROWN|VALIDATION_FAIL|VALIDATION_ERROR|FLOW_ELEMENT_ERROR)(?:\|(.*))?$/);
    if (event) {
      const label = event[1] === "EXCEPTION_THROWN" ? "EXCEPTION" : event[1].startsWith("FLOW") ? "FLOW" : "VALIDATION";
      lines.push(`${label} ${(event[2] ?? "").replaceAll("|", " ")}`.trimEnd());
      continue;
    }
    if (line.includes("|LIMIT_USAGE_FOR_NS|")) { inLimits = true; continue; }
    if (inLimits && /^\s*Number of |^\s*(Maximum CPU time|Maximum heap size)/.test(line)) {
      const usage = line.match(/^\s*(.+?):\s*(\d+) out of (\d+)/);
      if (usage && Number(usage[3]) > 0 && Number(usage[2]) >= Number(usage[3]) / 2) {
        const name = usage[1].replace(/^Number of /, "").replace(/ queries$/, "").replace(/^Maximum /, "");
        lines.push(`LIMIT ${name} ${usage[2]}/${usage[3]}`);
      }
    } else if (line.includes("|")) inLimits = false;
  }
  if (apexOnly) return lines;
  const deduped = [];
  for (let i = 0; i < lines.length;) {
    let end = i + 1;
    while (lines[end] === lines[i]) end++;
    deduped.push(lines[i] + (end - i > 1 ? ` ×${end - i}` : ""));
    i = end;
  }
  return deduped;
}

const logSize = bytes => bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes ?? 0} B`;

export function formatLog(log) {
  return [`${log.operation} ${log.status} ${log.duration ?? 0}ms ${logSize(log.length)}`, ...filterLog(log.body)].join("\n");
}

export function formatLogList(rows) {
  return rows.length ? rows.map(row => `${row.Id} ${row.StartTime.replace("T", " ").replace(/\.\d+Z$/, "")} ${row.Operation} ${row.Status} ${logSize(row.LogLength)} ${row.DurationMilliseconds}ms`).join("\n") : "No debug logs found.";
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
  if (summary.logs?.length) {
    lines.push("Logs:");
    for (const log of summary.logs) {
      lines.push(`  ${log.id}`);
      if (log.body !== undefined) lines.push(...formatLog(log).split("\n").map(line => `    ${line}`));
    }
  }
  return lines.join("\n");
}

// Normalize both SDR file responses and STL change/status rows at the boundary.
export function summarizeChanges(changes, projectDir, state) {
  const files = changes.flatMap(c => (c.filenames?.length ? c.filenames : [c.filePath]).map(path => ({
    state: state ?? c.state ?? (c.deleted ? "Deleted" : c.modified ? "Changed" : "Add"),
    type: c.type, fullName: c.fullName ?? c.name,
    path: path ? relative(projectDir, resolve(projectDir, path)) : undefined,
    ...(c.problem ? { problem: c.problem } : {})
  })));
  return [...new Map(files.map(f => [JSON.stringify([f.state, f.type, f.fullName, f.path, f.problem]), f])).values()];
}

export function summarizeRetrieve(result, projectDir) {
  const response = result.response;
  const files = summarizeChanges(result.getFileResponses(), projectDir);
  return {
    success: Boolean(response.success) && !files.some(f => f.state === "Failed" || f.problem),
    status: response.status, id: response.id, files,
    warnings: asArray(response.messages), conflicts: [], errorMessage: response.errorMessage
  };
}

function componentLines(files, conflict = false) {
  // Collapse only a source file's companion XML; retain bundle files and all failures.
  const paths = new Set(files.filter(f => !f.problem).map(f => `${f.type}:${f.fullName}:${f.path}`));
  return files.filter(f => f.problem || !f.path?.endsWith("-meta.xml") ||
    !paths.has(`${f.type}:${f.fullName}:${f.path.slice(0, -9)}`)).map(f => {
    const state = String(f.state).toLowerCase();
    const mark = conflict ? "! conflict" : f.problem || state === "failed" ? "✖" :
      ["add", "added", "created"].includes(state) ? "+" : ["delete", "deleted"].includes(state) ? "-" : "~";
    return `  ${mark} ${f.type} ${f.fullName}${f.path ? ` ${f.path}` : ""}${f.problem ? `: ${f.problem}` : ""}`;
  });
}

export function formatRetrieve(summary, org) {
  const count = new Set(summary.conflicts.map(c => `${c.type}:${c.fullName}`)).size;
  const head = count
    ? `CONFLICTS: ${count} component${count === 1 ? "" : "s"} changed both locally and in ${org}; rerun with --ignore-conflicts to overwrite`
    : summary.message ?? (summary.success
      ? `Retrieved ${summary.files.length} files from ${org}${summary.id ? ` (${summary.id})` : ""}`
      : `FAILED (${summary.status}) ${org}${summary.id ? ` (${summary.id})` : ""}`);
  const lines = [head, ...componentLines(summary.files), ...componentLines(summary.conflicts, true)];
  for (const warning of summary.warnings) lines.push(`  ! ${typeof warning === "string" ? warning : warning.problem ?? JSON.stringify(warning)}`);
  if (summary.errorMessage) lines.push(`  ✖ ${summary.errorMessage}`);
  return lines.join("\n");
}

export function formatTracking(summary) {
  const lines = [];
  for (const section of ["local", "remote", "conflicts"]) {
    if (summary[section].length) lines.push(section, ...componentLines(summary[section], section === "conflicts"));
  }
  return lines.join("\n") || "No changes.";
}

export function formatOrgList({ orgs, hiddenExpired = 0 }) {
  const aliasWidth = Math.max(1, ...orgs.map(org => (org.alias ?? "-").length));
  const userWidth = Math.max(1, ...orgs.map(org => org.username.length));
  const lines = orgs.map(org => {
    const marker = `${org.isDefault ? "*" : " "}${org.isDefaultDevHub ? "H" : " "}`;
    const expiry = org.type === "Scratch" ? org.expired ? " EXPIRED" : org.expirationDate ? ` expires ${org.expirationDate.slice(0, 10)}` : "" : "";
    return `${marker} ${(org.alias ?? "-").padEnd(aliasWidth)} ${org.username.padEnd(userWidth)} ${org.type}${expiry}${org.status ? ` ${org.status}` : ""}`;
  });
  if (hiddenExpired) lines.push(`(${hiddenExpired} expired scratch org(s) hidden; use --all)`);
  if (!lines.length) lines.push("No authenticated orgs. Run: sf org login web -a <alias>");
  return lines.join("\n");
}

export function formatMetadataTypes({ types, apiVersion }) {
  return [`${types.length} metadata types (API v${apiVersion})`, ...types.map(type => {
    const children = type.children.slice(0, 6);
    if (type.children.length > 6) children.push(`…+${type.children.length - 6}`);
    return `${type.name}${type.inFolder ? " (folder)" : ""}${children.length ? ` [${children.join(", ")}]` : ""}`;
  })].join("\n");
}

export function formatMetadataList({ groups }, { details = false } = {}) {
  return groups.map(group => {
    const header = group.folders
      ? `${group.folderType} (${group.members.length}): use --folder <name> to list members`
      : groups.length > 1 ? `${group.type} (${group.members.length}):` : "";
    const lines = group.members.map(member => details ? [member.fullName, member.lastModifiedDate?.slice(0, 10),
      member.lastModifiedByName, member.namespacePrefix ? `ns:${member.namespacePrefix}` : "", member.manageableState].filter(Boolean).join("  ") : member.fullName);
    if (!lines.length) lines.push("(none)");
    return header ? [header, ...lines.map(line => `  ${line}`)].join("\n") : lines.join("\n");
  }).join("\n");
}

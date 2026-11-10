import { EFFECTS } from "./effects.mjs";
import { summarizeTests } from "../format.mjs";
import { LOG_CLOCK_SKEW_MS, abortable, afterTrace, currentUser, disconnected, logBody, logRows, soqlString, throwIfAborted } from "../sf-util.mjs";

// Apex tests count as reads because their data changes roll back. Backoff stays
// off so a request-limit error does not start a second test run.
/** @type {import("../types.js").BuiltinOp<import("../types.js").TestArgs>} */
export default {
  name: "test", effects: EFFECTS.test, retry: "safe", backoff: false, project: false, policy: true,
  run: async (ctx, { org, classNames, tests, suiteNames, testLevel, synchronous, codeCoverage, logs, noTrace, waitMinutes = 60 }) => {
    const { session, conn, Duration, signal, warn } = ctx;
    const user = logs ? await currentUser(conn) : undefined;
    const trace = logs ? await session.traceFor(conn, org, user, noTrace) : undefined;
    return afterTrace(trace, async () => {
      const { TestService } = ctx.apex();
      const service = new TestService(conn);
      const level = testLevel ?? (classNames?.length || tests?.length || suiteNames?.length ? "RunSpecifiedTests" : "RunLocalTests");
      // apex-node takes comma-separated strings, as the sf flags do.
      const csv = (/** @type {string[] | undefined} */ list) => (list?.length ? list.join(",") : undefined);
      const payload = synchronous
        ? await service.buildSyncPayload("RunSpecifiedTests", csv(tests), csv([...new Set(classNames)]))
        : await service.buildAsyncPayload(level, csv(tests), csv(classNames), csv(suiteNames));
      const startedAt = new Date(Math.floor((Date.now() - LOG_CLOCK_SKEW_MS) / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
      const logWindow = logs ? `LogUserId = ${soqlString(user.id)} AND StartTime >= ${startedAt}` : undefined;
      const before = logs
        ? (await conn.query(`SELECT Id FROM ApexLog WHERE ${logWindow} ORDER BY StartTime DESC LIMIT 200`)).records.map((/** @type {any} */ row) => row.Id)
        : [];
      throwIfAborted(signal);
      const testStartedAt = new Date().toISOString();
      /** @type {string | undefined} */
      let testRunId;
      let reportedIdAfterAbort = false;
      const progress = { report: (/** @type {any} */ event) => {
        if (event?.testRunId) testRunId = event.testRunId;
        if (signal?.aborted && testRunId && !reportedIdAfterAbort) {
          reportedIdAfterAbort = true;
          disconnected(warn, "test", org, `test run ${testRunId}`);
        }
      } };
      const run = synchronous
        ? service.runTestSynchronous(payload, Boolean(codeCoverage))
        : service.runTestAsynchronous(payload, Boolean(codeCoverage), false, progress, undefined, Duration.minutes(waitMinutes));
      const result = await abortable(run, signal, () => disconnected(warn, "test", org,
        testRunId ? `test run ${testRunId}` : `test run started at ${testStartedAt} (id unavailable)`));
      throwIfAborted(signal);
      /** @type {Record<string, any>} */
      const summary = summarizeTests(result);
      if (logs) {
        // Pad both bounds for clock skew, rounding outward to whole-second SOQL literals.
        const finishedAt = new Date(Math.ceil((Date.now() + LOG_CLOCK_SKEW_MS) / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
        const exclusion = before.length ? ` AND Id NOT IN (${before.map(soqlString).join(", ")})` : "";
        const rows = await logRows(conn, `${logWindow} AND StartTime <= ${finishedAt}${exclusion}`, 10);
        summary.logs = summary.failing > 0 || summary.failures.length || summary.setupFailures.length
          ? await Promise.all(rows.map(row => logBody(conn, row))) : rows.map(row => ({ id: row.Id }));
      }
      return summary;
    });
  }
};

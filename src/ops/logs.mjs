import { EFFECTS } from "./effects.mjs";
import { afterTrace, currentUser, logCount, logRows, soqlString } from "../sf-util.mjs";

/** @type {import("../types.js").BuiltinOp<import("../types.js").LogsArgs>} */
export default {
  name: "logs", effects: EFFECTS.logs, retry: "safe", project: false, policy: true,
  run: async ({ session, conn }, { org, count = 10, user, noTrace }) => {
    logCount(count);
    const trace = await session.traceFor(conn, org, await currentUser(conn), noTrace);
    return afterTrace(trace, async () => ({
      records: await logRows(conn, user ? `LogUser.Username = ${soqlString(user)}` : "", count)
    }));
  }
};

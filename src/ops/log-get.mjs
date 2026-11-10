import { EFFECTS } from "./effects.mjs";
import { UsageError } from "../usage-error.mjs";
import { afterTrace, currentUser, logBody, logRows, soqlString } from "../sf-util.mjs";

/** @type {import("../types.js").BuiltinOp<import("../types.js").LogGetArgs>} */
export default {
  name: "logGet", effects: EFFECTS.logGet, retry: "safe", project: false, policy: true,
  run: async ({ session, conn }, { org, id, noTrace }) => {
    if (id !== "latest" && !/^07L[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?$/.test(id)) throw new UsageError("logs get needs an ApexLog ID or latest.");
    const user = await currentUser(conn);
    const trace = await session.traceFor(conn, org, user, noTrace);
    return afterTrace(trace, async () => {
      const rows = await logRows(conn, id === "latest" ? `LogUserId = ${soqlString(user.id)}` : `Id = ${soqlString(id)}`, 1);
      if (!rows.length) throw new Error("No debug logs found.");
      return logBody(conn, rows[0]);
    });
  }
};

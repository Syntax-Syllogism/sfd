import { EFFECTS } from "./effects.mjs";
import { compactQuery } from "../format.mjs";

/** @type {import("../types.js").BuiltinOp<import("../types.js").QueryArgs>} */
export default {
  name: "query", effects: EFFECTS.query, retry: "safe", project: false, policy: true,
  run: async ({ conn }, { q, tooling, all, raw, limit }) => {
    const api = tooling ? conn.tooling : conn;
    const result = await api.query(q, { scanAll: Boolean(all) });
    while (!result.done && (limit === undefined || result.records.length < limit)) {
      if (!result.nextRecordsUrl) throw new Error("Incomplete query result: missing nextRecordsUrl.");
      const page = await api.queryMore(result.nextRecordsUrl);
      result.records.push(...page.records);
      result.done = page.done;
      result.nextRecordsUrl = page.nextRecordsUrl;
    }
    const truncated = limit !== undefined && (!result.done || result.records.length > limit);
    if (truncated) result.records = result.records.slice(0, limit);
    /** @type {Record<string, any>} */
    const output = raw ? result : compactQuery(result);
    if (truncated) output.truncated = true;
    return output;
  }
};

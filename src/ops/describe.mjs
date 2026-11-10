import { EFFECTS } from "./effects.mjs";
import { compactDescribe } from "../format.mjs";

/** @type {import("../types.js").BuiltinOp<import("../types.js").DescribeArgs>} */
export default {
  name: "describe", effects: EFFECTS.describe, retry: "safe", project: false, policy: true,
  run: async ({ conn }, { sobject, tooling, raw }) => {
    const d = await (tooling ? conn.tooling : conn).describe(sobject);
    return raw ? d : compactDescribe(d);
  }
};

import { EFFECTS } from "./effects.mjs";

/** @type {import("../types.js").BuiltinOp<import("../types.js").ApexArgs>} */
export default {
  name: "apex", effects: EFFECTS.apex, retry: "never", project: false, policy: true,
  run: async ({ conn, apex }, { body, raw }) => {
    const result = await new (apex().ExecuteService)(conn).executeAnonymous({ apexCode: body });
    if (!raw) return result;
    const diagnostic = result.diagnostic?.[0];
    return { ...result, ...(diagnostic ? { compileProblem: diagnostic.compileProblem, exceptionMessage: diagnostic.exceptionMessage, exceptionStackTrace: diagnostic.exceptionStackTrace, line: diagnostic.lineNumber, column: diagnostic.columnNumber } : {}) };
  }
};

import { EFFECTS } from "./effects.mjs";

/** @type {import("../types.js").BuiltinOp} */
export default {
  name: "reload", effects: EFFECTS.reload, retry: "safe", project: false, policy: false, needsOrg: false,
  run: async ({ session }) => {
    await session.invalidate("all");
    return { reloaded: true };
  }
};

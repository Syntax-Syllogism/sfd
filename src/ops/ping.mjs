import { EFFECTS } from "./effects.mjs";

/** @type {import("../types.js").BuiltinOp} */
export default {
  name: "ping", effects: EFFECTS.ping, retry: "safe", project: false, policy: false, needsOrg: false,
  run: async () => ({ pong: true })
};

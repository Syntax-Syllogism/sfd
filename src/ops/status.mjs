import { EFFECTS } from "./effects.mjs";

/** @type {import("../types.js").BuiltinOp} */
export default {
  name: "status", effects: EFFECTS.status, retry: "safe", project: false, policy: false, needsOrg: false,
  run: async ({ session }) => ({
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    orgs: session.cachedOrgs(),
    apiUsage: session.apiUsage()
  })
};

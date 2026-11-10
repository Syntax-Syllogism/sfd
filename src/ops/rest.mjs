import { EFFECTS, restEffects } from "./effects.mjs";

/** @type {import("../types.js").BuiltinOp<import("../types.js").RestArgs>} */
export default {
  name: "rest", effects: EFFECTS.rest, project: false, policy: true,
  // Only reads may repeat after a session expiry.
  retry: ({ method, body }) => restEffects({ method, body })[0] === "read" ? "safe" : "never",
  run: ({ conn }, { method, url, body, headers }) => conn.request({
    method, url, body: body === undefined || typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers }
  })
};

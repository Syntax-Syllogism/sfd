// Effects of every built-in operation. The descriptors in src/ops/*.mjs use
// these functions, and builtinEffects in src/policy.mjs reads them for the
// agent hook, so this module must stay free of heavy imports.

/** @typedef {import("../types.js").Effect} Effect */
/** @typedef {(args?: Record<string, unknown>) => Effect[]} EffectsFn */

/** @type {EffectsFn} */
const read = () => ["read"];
/** @type {EffectsFn} */
const orgWrite = () => ["org-write"];
/** @type {EffectsFn} */
const localWrite = () => ["local-write"];

/**
 * REST GET/HEAD are reads, DELETE is destructive, and everything else is an org write.
 * Without a method, a body implies POST.
 * @type {EffectsFn}
 */
export function restEffects(args = {}) {
  const method = (/** @type {string | undefined} */ (args.method) ?? (args.body === undefined ? "GET" : "POST")).toUpperCase();
  return [method === "DELETE" ? "destructive" : ["GET", "HEAD"].includes(method) ? "read" : "org-write"];
}

/** @type {Readonly<Record<string, EffectsFn>>} */
export const EFFECTS = Object.freeze({
  ping: read, status: read, reload: read, org: read, orgList: read,
  query: read, apex: orgWrite, rest: restEffects, describe: read,
  listMetadataTypes: read, listMetadata: read,
  deploy: orgWrite, retrieve: localWrite, tracking: read,
  logs: read, logGet: read, test: read
});

/**
 * Effects for a built-in operation; unknown operations count as reads.
 * @param {string} op
 * @param {Record<string, unknown>} [args]
 * @returns {Effect[]}
 */
export function opEffects(op, args = {}) {
  return (Object.hasOwn(EFFECTS, op) ? EFFECTS[op] : read)(args);
}

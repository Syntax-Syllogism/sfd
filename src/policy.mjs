import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, statSync, unlinkSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { UsageError } from "./usage-error.mjs";
import { opEffects } from "./ops/effects.mjs";

/**
 * Decisions (`allow`, `ask`, `deny`) by org type, then effect, plus org-type overrides by username or alias.
 * @typedef {{ version: number, rules: Record<string, Record<string, string>>, orgs: Record<string, string> }} Policy
 */
/** @typedef {{ env?: NodeJS.ProcessEnv, home?: string }} PolicyOptions */

const effects = ["read", "local-write", "org-write", "destructive"];
const types = ["scratch", "sandbox", "production"];
/** @type {Record<string, number>} */
const rank = { allow: 0, ask: 1, deny: 2 };
const ttl = 10 * 60_000;
/**
 * @param {string} write
 * @param {string} destructive
 * @returns {Record<string, string>}
 */
const rules = (write, destructive) => ({ read: "allow", "local-write": "allow", "org-write": write, destructive });
/** @type {Policy} */
export const DEFAULT_POLICY = { version: 1, rules: {
  scratch: rules("allow", "allow"), sandbox: rules("allow", "ask"), production: rules("ask", "ask")
}, orgs: {} };
/** @param {any} value */
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * @param {PolicyOptions} [options]
 * @returns {Policy}
 */
export function loadPolicy({ env = process.env, home = homedir() } = {}) {
  const file = env.SFD_POLICY ?? join(home, ".config", "sfd", "policy.json");
  let input;
  try { input = JSON.parse(readFileSync(file, "utf8")); }
  catch (e) {
    if (e.code === "ENOENT") return structuredClone(DEFAULT_POLICY);
    throw new UsageError(`Cannot load policy ${file}: ${e.message}`);
  }
  const invalid = () => { throw new UsageError(`Invalid policy ${file}: expected version 1, rules by org type/effect, and org type overrides`); };
  if (!object(input) || input.version !== 1 || Object.keys(input).some(k => !["version", "rules", "orgs"].includes(k))) invalid();
  if (input.rules !== undefined && !object(input.rules)) invalid();
  if (input.orgs !== undefined && !object(input.orgs)) invalid();
  const policy = structuredClone(DEFAULT_POLICY);
  for (const [type, values] of Object.entries(input.rules ?? {})) {
    if (!types.includes(type) || !object(values)) invalid();
    for (const [effect, decision] of Object.entries(values)) {
      if (!effects.includes(effect) || !Object.hasOwn(rank, decision)) invalid();
      policy.rules[type][effect] = decision;
    }
  }
  for (const [org, type] of Object.entries(input.orgs ?? {})) {
    if (!types.includes(type)) invalid();
    Object.defineProperty(policy.orgs, org, { value: type, enumerable: true });
  }
  return policy;
}

/**
 * @param {PolicyOptions} [options]
 * @returns {() => Policy}
 */
export function policyLoader(options = {}) {
  /** @type {string | undefined} */
  let stamp;
  /** @type {Policy | undefined} */
  let policy;
  return () => {
    const file = (options.env ?? process.env).SFD_POLICY ?? join(options.home ?? homedir(), ".config", "sfd", "policy.json");
    let next;
    try { const s = statSync(file); next = `${file}:${s.mtimeMs}:${s.ctimeMs}:${s.size}`; }
    catch (e) { if (e.code !== "ENOENT") throw new UsageError(`Cannot stat policy: ${e.message}`); next = `${file}:missing`; }
    if (next !== stamp) { policy = loadPolicy(options); stamp = next; }
    return /** @type {Policy} */ (policy);
  };
}

/**
 * The declared effects of a built-in operation, from its descriptor (`src/ops/effects.mjs`).
 * @param {string} op
 * @param {{ method?: string, body?: unknown, [key: string]: unknown }} [args]
 * @returns {string[]}
 */
export function builtinEffects(op, args = {}) {
  return opEffects(op, args);
}

// An absent username or alias is looked up as the key "undefined", which no override uses.
/**
 * @param {string | undefined} type
 * @param {Policy} policy
 * @param {string | undefined} username
 * @param {string | undefined} alias
 * @returns {string}
 */
export function effectiveOrgType(type, policy, username, alias) {
  return (Object.hasOwn(policy.orgs, /** @type {string} */ (username)) ? policy.orgs[/** @type {string} */ (username)] : undefined)
    ?? (Object.hasOwn(policy.orgs, /** @type {string} */ (alias)) ? policy.orgs[/** @type {string} */ (alias)] : undefined) ?? type ?? "unknown";
}

/**
 * @param {string[]} declared
 * @param {string} orgType
 * @param {Policy} [policy]
 * @returns {{ decision: string, effect: string }}
 */
export function decide(declared, orgType, policy = DEFAULT_POLICY) {
  const row = policy.rules[types.includes(orgType) ? orgType : "production"];
  return declared.reduce((result, effect) => {
    if (!effects.includes(effect)) throw new UsageError(`Unknown effect: ${effect}`);
    const decision = row[effect];
    return rank[decision] > rank[result.decision] ? { decision, effect } : result;
  }, { decision: "allow", effect: declared[0] ?? "read" });
}

/**
 * @param {any} value
 * @returns {any}
 */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, stable(value[k])]));
  return value;
}
/** @param {unknown} input */
export function confirmHash(input) {
  return createHash("sha256").update(JSON.stringify(stable(input))).digest("hex").slice(0, 12);
}
/**
 * @param {string} dir
 * @param {string} hash
 */
function confirmFile(dir, hash) {
  if (!/^[a-f0-9]{12}$/.test(hash)) throw new UsageError("Invalid confirmation hash");
  return join(dir, "confirm", hash);
}
/**
 * @param {string} dir
 * @param {string} hash
 */
export function issueConfirm(dir, hash) {
  mkdirSync(join(dir, "confirm"), { recursive: true, mode: 0o700 });
  // Repeated requests must not extend an existing approval's lifetime.
  const file = confirmFile(dir, hash);
  try { if (Date.now() - statSync(file).mtimeMs >= ttl) unlinkSync(file); } catch (e) { if (e.code !== "ENOENT") throw e; }
  try { writeFileSync(file, "", { flag: "wx", mode: 0o600 }); } catch (e) { if (e.code !== "EEXIST") throw e; }
  return new Date(statSync(file).mtimeMs + ttl).toISOString();
}
/**
 * @param {string} dir
 * @param {string} hash
 * @param {number} [now]
 */
export function consumeConfirm(dir, hash, now = Date.now()) {
  const file = confirmFile(dir, hash);
  // Rename atomically claims the token, even across processes.
  const claimed = `${file}.${randomUUID()}`;
  try { renameSync(file, claimed); } catch (e) { if (e.code === "ENOENT") return false; throw e; }
  try { const issued = Math.floor(statSync(claimed).mtimeMs); return now >= issued && now - issued < ttl; }
  finally { unlinkSync(claimed); }
}

/**
 * @typedef {object} PolicyCheck
 * @property {string} operation
 * @property {string} [username]
 * @property {string} [alias]
 * @property {unknown} options
 * @property {any} [plan] A plugin plan; its `summary` replaces the generated one.
 * @property {string[]} effects
 * @property {string} [orgType]
 * @property {Policy} policy
 * @property {string} runtimeDir
 * @property {string} [confirm]
 * @property {boolean} [preview]
 */

/** @param {PolicyCheck} check */
export function checkPolicy({ operation, username, alias, options, plan = null, effects: declared, orgType = "unknown", policy, runtimeDir, confirm, preview = false }) {
  orgType = effectiveOrgType(orgType, policy, username, alias);
  const decision = decide(declared, orgType, policy);
  const summary = plan?.summary ?? `${operation} ${JSON.stringify(options)}`;
  const details = { ...decision, orgType, summary, ...(plan ? { plan } : {}) };
  if (decision.decision === "allow") return details;
  if (decision.decision === "deny") {
    if (preview) return details;
    throw Object.assign(new Error(`policy denied: ${decision.effect} on ${orgType} org ${alias ?? ""} (${username ?? "no org"})`), details,
      { name: "PolicyDenied", errorCode: "policy-denied", exitCode: 4 });
  }
  const hash = confirmHash({ operation, username, options, plan });
  if (!preview && confirm === hash && consumeConfirm(runtimeDir, hash)) return details;
  const expiresAt = issueConfirm(runtimeDir, hash);
  const approvalRequired = { ...details, hash, expiresAt };
  if (preview) return approvalRequired;
  throw Object.assign(new Error(`approval required: ${decision.effect} on ${orgType} org ${alias ?? ""} (${username ?? "no org"})`),
    approvalRequired, { name: "ApprovalRequired", errorCode: "approval-required", exitCode: 4, approvalRequired });
}

/**
 * @param {string} dir
 * @param {unknown} entries
 */
export function writeOrgTypes(dir, entries) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "org-types.json");
  const temp = `${file}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, JSON.stringify(entries), { mode: 0o600 }); renameSync(temp, file); }
  finally { try { unlinkSync(temp); } catch (e) { if (e.code !== "ENOENT") throw e; } }
}

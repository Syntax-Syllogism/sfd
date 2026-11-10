import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { EFFECTS } from "./effects.mjs";
import { checkPolicy, decide, effectiveOrgType } from "../policy.mjs";
import { limiter, LIMIT_ERRORS } from "../limit.mjs";
import { rawListEntry, scratchDetails, soqlString, withDeadline } from "../sf-util.mjs";

// Lists local authorizations without opening a connection first; it applies
// the policy itself, against the most restricted listed org.
/** @type {import("../types.js").BuiltinOp<import("../types.js").OrgListArgs | undefined>} */
export default {
  name: "orgList", effects: EFFECTS.orgList, retry: "safe", project: false, policy: false, needsOrg: false,
  run: async ({ session, core, home, getPolicy, warn }, { all = false, status = false, raw = false, confirm } = {}) => {
    await session.refreshIfAuthChanged();
    const state = await core.StateAggregator.getInstance();
    const config = await core.ConfigAggregator.create();
    await config.reload();
    const isDefault = (/** @type {string} */ username, /** @type {string} */ key) => {
      const value = config.getPropertyValue(key);
      return value === username || state.aliases.getAll(username).includes(value);
    };
    /** @type {{ username: string }[]} */
    let authorizations;
    try { authorizations = await core.AuthInfo.listAllAuthorizations() ?? []; }
    catch (error) {
      if (error.name !== "NoAuthInfoFound") throw error;
      authorizations = [];
    }
    const entries = await Promise.all(authorizations.map(async ({ username }) => {
      try {
        const auth = await core.AuthInfo.create({ username });
        let fields;
        try { fields = auth.getFields(true); } catch { fields = auth.getFields(); }
        const defaultOrg = isDefault(username, "target-org");
        if (fields.orgId && !defaultOrg) {
          let primary;
          try { primary = JSON.parse(readFileSync(join(home, ".sfdx", `${fields.orgId}.json`), "utf8")).usernames?.[0]; }
          catch (error) { if (error.code !== "ENOENT") throw error; }
          if (primary && primary !== username) return undefined;
        }
        const scratch = Boolean(fields.expirationDate || fields.devHubUsername);
        /** @type {Record<string, any>} */
        const org = {
          alias: state.aliases.getAll(username)[0] ?? null, username,
          orgId: fields.orgId, instanceUrl: fields.instanceUrl,
          safetyType: scratch ? "scratch" : session.cachedType(username) ?? "unknown",
          type: scratch ? "Scratch" : fields.isDevHub ? "DevHub" : fields.isSandbox ? "Sandbox" : "Org",
          isDefault: defaultOrg, isDefaultDevHub: isDefault(username, "target-dev-hub")
        };
        if (scratch) {
          if (fields.expirationDate) org.expirationDate = fields.expirationDate;
          org.expired = Boolean(fields.expirationDate && fields.expirationDate.slice(0, 10) < new Date().toISOString().slice(0, 10));
        }
        /** @type {string | undefined} */
        let lastUsed;
        if (raw) {
          try { lastUsed = statSync(join(home, ".sfdx", `${username}.json`)).atime.toISOString(); }
          catch { /* Some auth providers do not have a local file. */ }
        }
        return { org, devHubUsername: fields.devHubUsername, ...(raw ? { raw: rawListEntry(fields, org, lastUsed) } : {}) };
      } catch {
        // Never log auth fields or vendor error messages, which can contain secrets.
        warn("orgList: skipping unreadable local authorization");
        return undefined;
      }
    }));
    /** @type {{ org: Record<string, any>, devHubUsername?: string, raw?: Record<string, any> }[]} */
    const readable = entries.filter(Boolean);
    if (status || raw) {
      const run = limiter(4);
      // Return the deadline result while the limiter retains the underlying work.
      /** @type {(fn: () => Promise<any>, options?: { reportLateLimit?: boolean }) => Promise<{ result?: any, error?: any }>} */
      const check = (fn, { reportLateLimit = false } = {}) => new Promise(resolve => {
        run(async () => {
          const work = Promise.resolve().then(fn);
          try { resolve({ result: await withDeadline(() => work) }); }
          catch (error) {
            resolve({ error });
            if (reportLateLimit && error.name === "Timeout") {
              work.catch(workError => {
                const code = workError.errorCode ?? workError.name;
                if (LIMIT_ERRORS.has(code)) warn(`orgList: Dev Hub query exhausted retries: ${code}`);
              });
            }
          }
          await work.catch(() => {});
        });
      });
      /** @type {Map<string, Record<string, any>[]>} */
      const hubs = new Map();
      const checks = readable.filter(({ org }) => status && org.type !== "Scratch").map(async ({ org }) => {
        try {
          const { error } = await check(async () => (await session.getOrg(org.username)).refreshAuth());
          if (error) throw error;
          org.status = "Connected";
        } catch (error) {
          session.forgetOrg(org.username);
          org.status = error.name;
        }
      });
      for (const entry of readable) {
        if (entry.org.type !== "Scratch" || !entry.devHubUsername || !entry.org.orgId) continue;
        if (!hubs.has(entry.devHubUsername)) hubs.set(entry.devHubUsername, []);
        /** @type {Record<string, any>[]} */ (hubs.get(entry.devHubUsername)).push(entry.org);
      }
      await Promise.all([...checks, ...[...hubs].map(async ([hub, scratchOrgs]) => {
        try {
          const checked = await check(async () => {
            return session.withConn(hub, async (conn, org) => {
              const result = await conn.query(`SELECT ScratchOrg, Status, ExpirationDate${raw ? ", CreatedBy.Username, CreatedDate, SignupUsername, Edition, OrgName, Namespace" : ""} FROM ScratchOrgInfo WHERE ScratchOrg IN (${scratchOrgs.map(o => soqlString(o.orgId.slice(0, 15))).join(",")})`);
              if (raw) result.records = result.records.map((/** @type {any} */ row) => ({ ...row, devHubOrgId: org.getOrgId() }));
              return result;
            }, { retry: true });
          }, { reportLateLimit: true });
          if (checked.error) throw checked.error;
          const result = checked.result;
          for (const org of scratchOrgs) {
            const row = result.records.find((/** @type {any} */ r) => r.ScratchOrg?.slice(0, 15) === org.orgId.slice(0, 15));
            if (!row) continue;
            if (raw) {
              const data = /** @type {Record<string, any>} */ (readable.find(entry => entry.org === org)?.raw);
              Object.assign(data, scratchDetails(row), {
                attributes: row.attributes, devHubId: row.devHubOrgId, devHubOrgId: row.devHubOrgId,
                isExpired: row.Status === "Expired" || row.Status === "Deleted"
              });
            }
            org.status = row.Status;
            if (row.ExpirationDate) org.expirationDate = row.ExpirationDate;
            org.expired = row.Status === "Expired" || row.Status === "Deleted";
          }
        } catch (error) {
          if (LIMIT_ERRORS.has(error.errorCode ?? error.name)) throw error;
          if (error.name === "Timeout") for (const org of scratchOrgs) org.status = "Timeout";
          // Local scratch details remain useful when a Dev Hub is unavailable.
        }
      })]);
    }
    const listed = readable.map(entry => entry.org);
    const visible = all ? listed : listed.filter(org => !org.expired);
    visible.sort((a, b) => (a.alias ?? "").localeCompare(b.alias ?? "") || a.username.localeCompare(b.username));
    const policy = getPolicy();
    const restricted = visible.map(org => ({ org, type: effectiveOrgType(org.safetyType, policy, org.username, org.alias) }))
      .map(entry => ({ ...entry, decision: decide(["read"], entry.type, policy).decision }))
      .sort((a, b) => ["deny", "ask", "allow"].indexOf(a.decision) - ["deny", "ask", "allow"].indexOf(b.decision))[0];
    checkPolicy({ operation: "orgList", username: restricted?.org.username, alias: restricted?.org.alias,
      orgType: restricted?.type, effects: ["read"], policy, runtimeDir: session.runtimeDir(), confirm,
      options: { all, status, usernames: visible.map(org => org.username) } });
    return { orgs: raw ? visible.map(org => {
      const data = /** @type {Record<string, any>} */ (readable.find(entry => entry.org === org)?.raw);
      if (org.type !== "Scratch" && org.status) data.connectedStatus = org.status;
      return data;
    }) : visible, hiddenExpired: listed.length - visible.length };
  }
};

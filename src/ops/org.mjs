import { EFFECTS } from "./effects.mjs";
import { pick } from "../sf-json.mjs";
import { scratchDetails, soqlString, withDeadline } from "../sf-util.mjs";

/** @type {import("../types.js").BuiltinOp<import("../types.js").OrgArgs>} */
export default {
  name: "org", effects: EFFECTS.org, retry: "safe", project: false, policy: true,
  run: async ({ session, core, conn, org: o }, { org, raw }) => {
    if (!raw) return { type: await session.orgType(org), alias: org, username: o.getUsername(), orgId: o.getOrgId(), instanceUrl: conn.instanceUrl, apiVersion: conn.getApiVersion() };
    const auth = await core.AuthInfo.create({ username: o.getUsername() });
    const fields = auth.getFields();
    const state = await core.StateAggregator.getInstance();
    /** @type {Record<string, any>} */
    const result = { ...pick(fields, "instanceUrl username clientId expirationDate"), id: fields.orgId, apiVersion: fields.instanceApiVersion ?? conn.getApiVersion(), alias: state.aliases.getAll(o.getUsername())[0] };
    if (fields.devHubUsername) {
      result.devHubId = fields.devHubUsername;
      const hub = await session.getOrg(fields.devHubUsername);
      const rows = await withDeadline(() => hub.getConnection().query(`SELECT Status, ExpirationDate, CreatedBy.Username, Edition, OrgName, CreatedDate, SignupUsername FROM ScratchOrgInfo WHERE ScratchOrg = ${soqlString(fields.orgId.slice(0, 15))}`));
      const row = rows.records.find((/** @type {any} */ r) => r.SignupUsername === fields.username) ?? rows.records[0];
      if (row) Object.assign(result, scratchDetails(row), { edition: row.Edition ?? undefined, namespace: row.Namespace ?? undefined });
    } else {
      try { await withDeadline(() => o.refreshAuth()); result.connectedStatus = "Connected"; }
      catch (error) { result.connectedStatus = error.name; }
    }
    return result;
  }
};

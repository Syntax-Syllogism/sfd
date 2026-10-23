export const SF_JSON_COMMANDS = new Set(['query', 'describe', 'apex', 'org', 'org list']);
export const REDACTED_TOKEN = "[REDACTED] Use 'sf org auth show-access-token' to view";
export const orgWarnings = command => [`Secrets are now hidden from 'sf ${command}' command output. Use the 'sf org auth' commands instead. As a temporary workaround, you can set SF_TEMP_SHOW_SECRETS=true to render these secrets. This workaround will be removed in an upcoming release.`];
export function pick(source, fields) {
  return Object.fromEntries(fields.split(' ').filter(key => source[key] !== undefined).map(key => [key, source[key]]));
}
const displayFields = 'id devHubId apiVersion instanceUrl username clientId status connectedStatus expirationDate createdBy edition namespace orgName createdDate signupUsername alias';
const listFields = 'alias clientId connectedStatus defaultMarker instanceApiVersion instanceApiVersionLastRetrieved instanceName instanceUrl isDefaultDevHubUsername isDefaultUsername isDevHub isSandbox isScratch lastUsed loginUrl name namespacePrefix orgEdition orgId tracksSource trailExpirationDate username attributes created createdBy createdDate createdOrgInstance devHubId devHubOrgId devHubUsername edition expirationDate isExpired namespace orgName signupUsername status';
export const orgEntry = raw => ({ ...pick(raw, listFields), accessToken: REDACTED_TOKEN });
export const sfJson = {
  query(raw) { const result = { ...raw }; if (result.done) delete result.nextRecordsUrl; return result; },
  describe: raw => raw,
  apex(raw) {
    return { success: raw.success, compiled: raw.compiled, compileProblem: raw.compileProblem ?? '', exceptionMessage: raw.exceptionMessage ?? '', exceptionStackTrace: raw.exceptionStackTrace ?? '', line: raw.line ?? -1, column: raw.column ?? -1, logs: raw.logs ?? '' };
  },
  org: raw => ({ ...pick(raw, displayFields), accessToken: REDACTED_TOKEN }),
  orgList(raw) {
    const result = { other: [], sandboxes: [], nonScratchOrgs: [], devHubs: [], scratchOrgs: [] };
    for (const data of raw.orgs) {
      const entry = orgEntry(data);
      if (entry.isScratch) result.scratchOrgs.push(entry);
      else {
        result.nonScratchOrgs.push(entry);
        if (entry.isDevHub) result.devHubs.push(entry);
        if (entry.isSandbox) result.sandboxes.push(entry);
        if (!entry.isDevHub && !entry.isSandbox) result.other.push(entry);
      }
    }
    return result;
  }
};
const contexts = { query: 'DataSoqlQueryCommand', describe: 'Describe', apex: 'Run', org: 'OrgDisplayCommand', orgList: 'OrgListCommand' };
export function sfError(command, error, exitCode = 1) {
  const name = error.errorCode ?? error.name ?? 'Error';
  const context = contexts[command] ?? command;
  return { name, message: error.message, exitCode, context, ...(error.data ? { data: error.data } : error.errorCode ? { data: { message: error.message, errorCode: error.errorCode } } : {}), ...(error.actions ? { actions: error.actions } : {}), warnings: [], code: error.errorCode ? '1' : name, status: exitCode, commandName: context };
}
export function sfEnvelope(command, response) {
  if (response.status !== 0) return sfError(command, response, response.name === 'UsageError' || response.name === 'NamedOrgNotFoundError' ? 2 : 1);
  const result = sfJson[command](response.result);
  if (command === 'apex' && (!result.compiled || !result.success)) {
    result.line = String(result.line); result.column = String(result.column);
    const name = result.compiled ? 'executeRuntimeFailure' : 'executeCompileFailure';
    const message = result.compiled ? `Execution failed at this code:\n\n${result.exceptionMessage}` : `Compilation failed at Line ${result.line} column ${result.column} with the error:\n\n${result.compileProblem}`;
    return sfError(command, { name, message, data: result });
  }
  return { status: 0, result, warnings: command === 'org' || command === 'orgList' ? orgWarnings(command === 'org' ? 'org display' : 'org list') : [] };
}

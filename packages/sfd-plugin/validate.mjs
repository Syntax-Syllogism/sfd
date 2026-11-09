export const API_VERSIONS = Object.freeze([0]);
export const EFFECTS = Object.freeze(["read", "local-write", "org-write", "destructive"]);
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = value => typeof value === "string" && value.trim().length > 0;
const relativePath = value => typeof value === "string" && value.startsWith("./") &&
  value.length > 2 && !value.includes("\\") && !value.includes("\0") && !value.split("/").includes("..");

export function validateManifest(manifest) {
  if (!isObject(manifest)) return ["manifest must be an object"];
  const problems = [];
  if (!API_VERSIONS.includes(manifest.apiVersion)) problems.push("manifest.apiVersion is unsupported");
  for (const field of ["operations", "cli"]) {
    if ((field === "operations" || field in manifest) && !relativePath(manifest[field])) {
      problems.push(`manifest.${field} must be a ./ relative path without .. segments`);
    }
  }
  if ("requires" in manifest) {
    if (!isObject(manifest.requires)) problems.push("manifest.requires must be an object");
    else if ("sfd" in manifest.requires && typeof manifest.requires.sfd !== "string") {
      problems.push("manifest.requires.sfd must be a string");
    }
  }
  return problems;
}

export function validateOperationModule(mod) {
  if (isObject(mod) && "default" in mod) mod = mod.default;
  if (!isObject(mod)) return ["module must be an object"];
  const problems = [];
  if (!API_VERSIONS.includes(mod.apiVersion)) problems.push("module.apiVersion is unsupported");
  if (!Array.isArray(mod.operations) || mod.operations.length === 0) {
    problems.push("module.operations must be a non-empty array");
    return problems;
  }
  const ids = new Set();
  for (const [index, op] of mod.operations.entries()) {
    const id = isObject(op?.descriptor) && typeof op.descriptor.id === "string" ? op.descriptor.id : `operations[${index}]`;
    const report = message => problems.push(`${id}: ${message}`);
    if (!isObject(op)) { report("operation must be an object"); continue; }
    if (!["read", "write"].includes(op.kind)) report("kind must be read or write");
    for (const method of op.kind === "read" ? ["run"] : op.kind === "write" ? ["plan", "apply"] : []) {
      if (typeof op[method] !== "function") report(`${method} must be a function`);
    }
    const d = op.descriptor;
    if (!isObject(d)) { report("descriptor must be an object"); continue; }
    if (typeof d.id !== "string" || !/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(d.id)) report("descriptor.id must be a lowercase namespaced id");
    if (ids.has(d.id)) report("descriptor.id must be unique within the module");
    ids.add(d.id);
    for (const field of ["title", "summary"]) if (!nonempty(d[field])) report(`descriptor.${field} must be a non-empty string`);
    if (typeof d.summary === "string" && (d.summary.length > 120 || /[\r\n\u2028\u2029]/.test(d.summary))) report("descriptor.summary must be one line of at most 120 characters");
    if (!Array.isArray(d.effects) || d.effects.length === 0) report("descriptor.effects must be a non-empty array");
    else {
      for (const effect of d.effects) if (!EFFECTS.includes(effect)) report(`descriptor.effects contains unknown effect ${typeof effect === "string" ? JSON.stringify(effect) : String(effect)}`);
      if (new Set(d.effects).size !== d.effects.length) report("descriptor.effects contains duplicates");
      if (op.kind === "read" && d.effects.some(e => !["read", "local-write"].includes(e))) report("descriptor.effects for a read may only contain read and local-write");
      if (op.kind === "write" && !d.effects.some(e => ["org-write", "destructive"].includes(e))) report("descriptor.effects for a write must include org-write or destructive");
    }
    if (!["required", "optional", "none"].includes(d.requiresOrg)) report("descriptor.requiresOrg must be required, optional or none");
    if (typeof d.requiresProject !== "boolean") report("descriptor.requiresProject must be a boolean");
    if (!["safe", "unsafe"].includes(d.retry)) report("descriptor.retry must be safe or unsafe");
    if (op.kind === "write" && d.retry === "safe") problems.push(`warning: ${id}: descriptor.retry is safe for a write; ensure replay is safe`);
    if (typeof d.optionsSchema?.safeParse !== "function") report("descriptor.optionsSchema.safeParse must be a function");
    if ("cliId" in d && !nonempty(d.cliId)) report("descriptor.cliId must be a non-empty string");
    if ("paged" in d && typeof d.paged !== "boolean") report("descriptor.paged must be a boolean");
  }
  return problems;
}

export function effectsExceeding(ceiling, planEffects) {
  if (planEffects === undefined) return [];
  if (!Array.isArray(planEffects)) throw new TypeError("plan.effects must be an array");
  return [...new Set(planEffects.filter(effect => !ceiling.includes(effect)))];
}

// Operations are optional for static consumers such as the rewrite hook.
export function validateCliTable(table, operations) {
  if (!isObject(table)) return ["CLI table must be an object"];
  const problems = [];
  if (table.apiVersion !== 0) problems.push("CLI apiVersion must be 0");
  if (!Array.isArray(table.commands)) return [...problems, "commands must be an array"];
  const descriptors = operations?.map(op => op.descriptor ?? op);
  const names = new Set();
  for (const command of table.commands) {
    if (!isObject(command)) { problems.push("command must be an object"); continue; }
    const report = message => problems.push(`${command.operation}: ${message}`);
    const words = value => Array.isArray(value) && value.length > 0 && value.every(word => typeof word === "string" && /^[a-z][a-z0-9-]*$/.test(word));
    if (typeof command.operation !== "string" || !/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(command.operation)) report("invalid operation id");
    if (!words(command.name) || command.name[0] !== command.operation?.split?.(".")[0]) report("name must start with the operation namespace");
    const name = command.name?.join?.(" ");
    if (names.has(name)) report("duplicate command name");
    names.add(name);
    for (const field of ["summary", "agentTip", "docs"]) {
      if ((field === "summary" || field in command) && (!nonempty(command[field]) || /[\r\n\u2028\u2029]/.test(command[field]))) report(`${field} must be a non-empty single line`);
    }
    const descriptor = descriptors?.find(d => d.id === command.operation);
    if (descriptors && !descriptor) report("operation does not exist");
    if (command.sf !== undefined && (!words(command.sf) || (descriptor && command.sf.join(":") !== descriptor.cliId))) report("sf must match cliId words");
    const formatter = command.formatter;
    if (formatter !== undefined && !["table", "csv", "summary", "json"].includes(formatter) && !(isObject(formatter) && relativePath(formatter.module))) report("invalid formatter or module path");
    if (!Array.isArray(command.flags)) { report("flags must be an array"); continue; }
    const flags = new Set(), chars = new Set();
    const shape = descriptor?.optionsSchema?.shape;
    if (descriptor && !shape) problems.push(`warning: ${command.operation}: options schema shape unavailable; option keys unchecked`);
    for (const flag of command.flags) {
      if (!isObject(flag)) { report("flag must be an object"); continue; }
      if (typeof flag.name !== "string" || !/^[a-z][a-z0-9-]*$/.test(flag.name) || flags.has(flag.name)) report("invalid or duplicate flag name");
      flags.add(flag.name);
      if (flag.char !== undefined && (!/^[A-Za-z]$/.test(flag.char) || chars.has(flag.char))) report("invalid or duplicate flag char");
      if (flag.char !== undefined) chars.add(flag.char);
      if (!["string", "boolean", "integer", "file", "directory"].includes(flag.type)) report("invalid flag type");
      for (const key of ["required", "multiple"]) if (flag[key] !== undefined && typeof flag[key] !== "boolean") report(`${key} must be boolean`);
      if (flag.name === "confirm") report("confirm is reserved by host and cannot be declared");
      if (["target-org", "api-version"].includes(flag.name) && flag.option !== undefined) report("reserved flag must omit option");
      if (flag.option !== undefined && (!nonempty(flag.option) || (shape && !Object.hasOwn(shape, flag.option)))) report(`unknown option key ${flag.option}`);
      const host = { "target-org": "o", help: "h" };
      if (Object.hasOwn(host, flag.name) && flag.char !== undefined && flag.char !== host[flag.name]) report("host flag has conflicting char");
      if (["o", "h"].includes(flag.char) && host[flag.name] !== flag.char) report("flag char is reserved by host");
      if (["json", "plan", "help", "quiet"].includes(flag.name) && (flag.type !== "boolean" || flag.option !== undefined || flag.multiple)) report("host boolean flag cannot map an option or repeat");
      if (["target-org", "api-version"].includes(flag.name) && (flag.type !== "string" || flag.multiple)) report("host value flag must be a single string");
    }
  }
  return problems;
}

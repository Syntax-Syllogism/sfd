import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { validateManifest, validateOperationModule, validateCliTable } from "../../packages/sfd-plugin/validate.mjs";
import { containedPath } from "./cli-table.mjs";

/** @param {string} root @param {{ops?: string[], write?: boolean}} [config] */
export async function initCliTable(root, { ops, write = false } = {}) {
  root = resolve(root);
  const packageFile = join(root, "package.json");
  const pkg = JSON.parse(readFileSync(packageFile, "utf8"));
  const errors = validateManifest(pkg.sfd);
  if (errors.length) throw new Error(errors.join("; "));
  const imported = await import(pathToFileURL(containedPath(root, pkg.sfd.operations)).href);
  const mod = imported.default ?? imported;
  const invalid = validateOperationModule(mod).filter(p => !p.startsWith("warning: "));
  if (invalid.length) throw new Error(invalid.join("; "));
  const review = [];
  /** @type {any} */
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(root, "oclif.manifest.json"), "utf8")); }
  catch (error) {
    if (/** @type {any} */ (error).code !== "ENOENT") throw error;
    review.push("run your build to produce oclif.manifest.json");
  }
  if (ops) for (const id of ops) if (!mod.operations.some((/** @type {any} */ op) => op.descriptor.id === id)) throw new Error(`Unknown operation: ${id}`);
  const commands = mod.operations.filter((/** @type {any} */ op) => !ops || ops.includes(op.descriptor.id)).map((/** @type {any} */ op) => {
    const d = op.descriptor;
    const shape = d.optionsSchema.shape;
    const source = manifest?.commands?.[d.cliId]?.flags;
    if (manifest && !source) review.push(`${d.id}: command absent from manifest; generating schema flags`);
    const flags = source ?? Object.fromEntries(Object.keys(shape ?? {}).map(key => [key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`), { type: "option" }]));
    const generated = [];
    for (const [name, flag] of Object.entries(flags)) {
      if (["json", "flags-dir", "loglevel"].includes(name)) continue;
      const option = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const type = ["boolean", "integer", "file", "directory"].includes(flag.type) ? flag.type :
        ["integer", "file", "directory"].includes(flag.optionType) ? flag.optionType : "string";
      /** @type {any} */
      const result = { name, type, ...(flag.char ? { char: flag.char } : {}),
        ...(flag.multiple ? { multiple: true } : {}), ...(flag.required ? { required: true } : {}) };
      if (!["target-org", "api-version"].includes(name)) {
        if (shape && Object.hasOwn(shape, option)) result.option = option;
        else review.push(`${d.id}: flag --${name} has no option key`);
      }
      if (flag.exclusive || flag.dependsOn || flag.relationships) review.push(`${d.id}: --${name} has flag relationships; review manually`);
      if (flag.parse || flag.parser) review.push(`${d.id}: --${name} has a custom parse function`);
      generated.push(result);
    }
    review.push(`${d.id}: tighten agentTip; review default summary formatter and custom parsers omitted by the manifest`);
    return { operation: d.id, name: (d.cliId ?? d.id.replaceAll(".", ":")).split(":"), summary: d.summary,
      agentTip: `${generated.filter(f => f.required).map(f => `--${f.name} <value>`).join(" ")}: ${d.summary}`,
      ...(d.cliId ? { sf: d.cliId.split(":") } : {}), flags: generated, formatter: "summary" };
  });
  const table = { apiVersion: 0, commands };
  const problems = validateCliTable(table, mod.operations);
  if (problems.some(p => !p.startsWith("warning: "))) throw new Error(problems.join("; "));
  review.push(...problems);
  if (write) {
    writeFileSync(join(root, "cli.json"), JSON.stringify(table, null, 2) + "\n");
    pkg.sfd.cli = "./cli.json";
    writeFileSync(packageFile, JSON.stringify(pkg, null, 2) + "\n");
  }
  return { table, review };
}

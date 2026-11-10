import { EFFECTS } from "./effects.mjs";
import { asArray } from "../format.mjs";
import { limiter } from "../limit.mjs";
import { UsageError } from "../usage-error.mjs";
import { metadataSuggestion } from "../sf-util.mjs";

/** @type {import("../types.js").BuiltinOp<import("../types.js").ListMetadataArgs>} */
export default {
  name: "listMetadata", effects: EFFECTS.listMetadata, retry: "safe", project: false, policy: true,
  run: async ({ session, conn, state }, args) => {
    const { org, folder } = args;
    // One limiter per request, so retried attempts wait for earlier chunks to settle.
    const run = /** @type {ReturnType<typeof limiter>} */ (state.limit ??= limiter(2));
    const types = [...new Set(args.types ?? [])];
    if (!types.length) throw new UsageError("list-metadata needs -m <Type>.");
    if (folder !== undefined && types.length > 1) throw new UsageError("--folder requires exactly one metadata type.");
    const description = await session.metadataTypes(org, conn);
    const known = new Set(description.types.flatMap(t => [t.name, ...t.children]));
    const groups = types.map(type => {
      if (!known.has(type)) {
        const suggestion = metadataSuggestion(type, [...known].sort());
        throw new UsageError(`Unknown metadata type: ${type}.${suggestion ? ` Did you mean ${suggestion}?` : ""}`);
      }
      const folders = folder === undefined && Boolean(description.types.find(t => t.name === type)?.inFolder);
      const folderType = known.has(`${type}Folder`) ? `${type}Folder` : type === "EmailTemplate" ? "EmailFolder" : `${type}Folder`;
      return { type, ...(folders ? { folders: true, folderType } : {}), members: /** @type {object[]} */ ([]) };
    });
    const queries = groups.map((/** @type {{ type: string, folderType?: string }} */ group) => ({ type: group.folderType ?? group.type, ...(folder !== undefined ? { folder } : {}) }));
    /** @type {object[][]} */
    const chunks = [];
    for (let i = 0; i < queries.length; i += 3) chunks.push(queries.slice(i, i + 3));
    const settled = await Promise.allSettled(chunks.map(chunk => run(() => conn.metadata.list(chunk, description.apiVersion))));
    const failure = settled.find(result => result.status === "rejected");
    if (failure) throw failure.reason;
    const results = settled.map(result => /** @type {PromiseFulfilledResult<any>} */ (result).value);
    const members = results.flatMap(asArray);
    for (const group of /** @type {{ type: string, folderType?: string, members: object[] }[]} */ (groups)) {
      group.members = members.filter((/** @type {any} */ member) => member.type === (group.folderType ?? group.type)).map((/** @type {any} */ member) => ({
        fullName: member.fullName, lastModifiedDate: member.lastModifiedDate, lastModifiedByName: member.lastModifiedByName,
        namespacePrefix: member.namespacePrefix, manageableState: member.manageableState
      })).sort((a, b) => a.fullName.localeCompare(b.fullName));
    }
    return { groups };
  }
};

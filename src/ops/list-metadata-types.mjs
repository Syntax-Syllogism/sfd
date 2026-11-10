import { EFFECTS } from "./effects.mjs";

/** @type {import("../types.js").BuiltinOp<import("../types.js").ListMetadataTypesArgs>} */
export default {
  name: "listMetadataTypes", effects: EFFECTS.listMetadataTypes, retry: "safe", project: false, policy: true,
  run: ({ session, conn }, { org }) => session.metadataTypes(org, conn)
};

// The built-in operations, in the order the daemon registers them. Each module
// exports a descriptor (`BuiltinOp` in src/types.d.ts); src/handlers.mjs wraps
// them with the policy gate, the project queue and the org connection.
import ping from "./ping.mjs";
import status from "./status.mjs";
import reload from "./reload.mjs";
import org from "./org.mjs";
import orgList from "./org-list.mjs";
import query from "./query.mjs";
import apex from "./apex.mjs";
import rest from "./rest.mjs";
import describe from "./describe.mjs";
import listMetadataTypes from "./list-metadata-types.mjs";
import listMetadata from "./list-metadata.mjs";
import deploy from "./deploy.mjs";
import retrieve from "./retrieve.mjs";
import tracking from "./tracking.mjs";
import logs from "./logs.mjs";
import logGet from "./log-get.mjs";
import test from "./test.mjs";

/** @type {readonly import("../types.js").BuiltinOp[]} */
export const ops = Object.freeze([ping, status, reload, org, orgList, query, apex, rest, describe,
  listMetadataTypes, listMetadata, deploy, retrieve, tracking, logs, logGet, test]);

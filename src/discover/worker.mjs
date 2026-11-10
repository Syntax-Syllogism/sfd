import { parentPort, workerData } from "node:worker_threads";
import { read as claude } from "./claude.mjs";
import { read as codex } from "./codex.mjs";
import { read as gemini } from "./gemini.mjs";
import { classify } from "./index.mjs";

/** @type {import("./shared.mjs").ScanStats} */
const stats = {};
/** @type {object[]} */
const observations = [];
const { agent, ...options } = workerData;
/** @type {Record<string, typeof claude>} */
const readers = { claude, codex, gemini };
for await (const record of readers[agent]({ ...options, stats })) {
  const classification = classify(record.command);
  if (classification) observations.push({
    agent, session: record.session, durationMs: record.durationMs,
    outputChars: record.outputChars, classification
  });
}
parentPort.postMessage({ observations, stats });

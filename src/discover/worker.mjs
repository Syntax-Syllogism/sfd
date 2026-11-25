import { parentPort, workerData } from "node:worker_threads";
import { read as claude } from "./claude.mjs";
import { read as codex } from "./codex.mjs";
import { read as gemini } from "./gemini.mjs";
import { observe } from "./index.mjs";

/** @type {import("./shared.mjs").ScanStats} */
const stats = {};
/** @type {object[]} */
const observations = [];
const { agent, catalog, ...options } = workerData;
/** @type {Record<string, typeof claude>} */
const readers = { claude, codex, gemini };
for await (const record of readers[agent]({ ...options, stats })) {
  const observation = observe(record.command, catalog);
  if (observation) observations.push({
    agent, session: record.session, durationMs: record.durationMs,
    outputChars: record.outputChars, ...observation
  });
}
parentPort.postMessage({ observations, stats });

// @ts-check
import { existsSync } from "node:fs";
import { pluginFingerprint } from "./protocol.mjs";
import { failure } from "./envelope.mjs";
/** @param {ReturnType<typeof import('./supervisor.mjs').createSupervisor>} supervisor */
export function createRegistry(supervisor) {
  /** @type {Map<string, {fingerprint: string, operations: any[]}>} */
  const cache = new Map();
  /** @param {import('./discover.mjs').PluginInfo} plugin */
  async function descriptors(plugin) {
    const fingerprint = pluginFingerprint([plugin]);
    if (cache.get(plugin.root)?.fingerprint !== fingerprint) {
      const reply = await supervisor.describe(plugin);
      if (reply.ok === false) return { operations: [], error: reply };
      if (reply.problems?.length) return { operations: [], error: failure("invalid-plugin", reply.problems.join("; ")) };
      cache.set(plugin.root, { fingerprint, operations: reply.operations });
    }
    return { operations: cache.get(plugin.root)?.operations ?? [] };
  }
  return {
    /** @param {string} id */
    async lookup(id) {
      const plugins = supervisor.refresh();
      for (const [root, cached] of cache) {
        if (!existsSync(root) && cached.operations.some(o => o.id === id)) {
          cache.delete(root);
          return { names: [], error: failure("plugin-missing", `Plugin root was removed: ${root}`) };
        }
      }
      const prefix = id.split(".")[0];
      const preferred = plugins.find(p => p.name.split("/").at(-1)?.replace(/-plugin$/, "").replace(/^sfd-plugin-/, "") === prefix);
      const names = [];
      // Describe the likely owner first. Earlier candidates still need checking to
      // make duplicate IDs deterministic, independent of the order of requests.
      const preferredReply = preferred ? await descriptors(preferred) : undefined;
      if (preferredReply?.error) return { names, error: preferredReply.error };
      for (const plugin of plugins) {
        const reply = plugin === preferred ? preferredReply : await descriptors(plugin);
        if (reply?.error) continue;
        const operations = reply?.operations ?? [];
        names.push(...operations.map(o => o.id));
        const descriptor = operations.find(o => o.id === id);
        if (descriptor) return { plugin, descriptor, names };
      }
      return { names };
    }
  };
}

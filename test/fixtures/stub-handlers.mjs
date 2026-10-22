// Stand-in for src/handlers.mjs so the CLI and daemon lifecycle can be tested without an org.
export function createHandlers() {
  return {
    ping: async () => ({ pong: true }),
    status: async () => ({ pid: process.pid, uptimeSeconds: 0, orgs: [] }),
    reload: async () => ({ reloaded: true }),
    query: async ({ org, q }) => ({ totalSize: 1, done: true, records: [{ org, q }] }),
    apex: async ({ body }) => body.includes("bad")
      ? { compiled: false, success: false, diagnostic: [{ compileProblem: "Unexpected token", lineNumber: 1, columnNumber: 1 }] }
      : { compiled: true, success: true, logs: "x|USER_DEBUG|[1]|DEBUG|hi" },
    deploy: async ({ sourcePaths }) => ({ success: true, sourcePaths }),
    test: async () => { throw Object.assign(new Error("org unreachable"), { name: "ConnectionError" }); }
  };
}

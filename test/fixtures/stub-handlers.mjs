// Stand-in for src/handlers.mjs so the CLI and daemon lifecycle can be tested without an org.
export function createHandlers() {
  return {
    org: async ({ org }) => ({ alias: org }),
    orgList: async args => {
      if ("org" in args) throw new Error("Unexpected target org");
      return { orgs: [{ alias: args.all ? "all" : "dev", username: "user", type: "Org", isDefault: true,
        ...(args.status ? { status: "Connected" } : {}) }], hiddenExpired: 0 };
    },
    listMetadataTypes: async () => ({ types: [{ name: "ApexClass", inFolder: false, children: [] }], apiVersion: "67.0", cached: true }),
    listMetadata: async args => {
      if (args.types.includes("ApexClas")) throw Object.assign(new Error("Unknown metadata type: ApexClas. Did you mean ApexClass?"), { name: "UsageError" });
      return { ...args, groups: args.types.map(type => ({ type, members: [{ fullName: args.folder ? `${args.folder}/Name` : "Name", manageableState: "unmanaged" }] })) };
    },
    ping: async () => ({ pong: true }),
    status: async () => ({ pid: process.pid, uptimeSeconds: 0, orgs: [] }),
    reload: async () => ({ reloaded: true }),
    query: async ({ org, q, limit }) => {
      if (q === "empty") return { totalSize: 0, done: true, records: [] };
      if (q === "rows") {
        const records = [{ Name: "A", Owner: { Name: "User" } }, { Name: "B", Owner: null }];
        return { totalSize: 5012, done: false, records: records.slice(0, limit), ...(limit ? { truncated: true } : {}) };
      }
      return { totalSize: 1, done: true, records: [{ org, q }] };
    },
    apex: async ({ body }) => body.includes("bad")
      ? { compiled: false, success: false, diagnostic: [{ compileProblem: "Unexpected token", lineNumber: 1, columnNumber: 1 }] }
      : { compiled: true, success: true, logs: "x|USER_DEBUG|[1]|DEBUG|hi" },
    deploy: async ({ sourcePaths }) => ({ success: true, sourcePaths }),
    retrieve: async args => {
      if (args.org === "untracked") throw Object.assign(new Error("retrieve needs -d, -m or -x on an org without source tracking."), { name: "UsageError" });
      return { ...args, success: args.org !== "conflict" || Boolean(args.ignoreConflicts), status: "Succeeded", files: [], warnings: [],
        conflicts: args.org === "conflict" && !args.ignoreConflicts ? [{ type: "ApexClass", fullName: "Foo" }] : [] };
    },
    tracking: async args => {
      if (args.org === "untracked") throw Object.assign(new Error("tracking requires an org with source tracking."), { name: "UsageError" });
      return { ...args, local: [], remote: [], conflicts: [] };
    },
    logs: async args => ({ ...args, records: [{ Id: "07L000000000001", StartTime: "2026-10-22T14:02:11.000Z", Operation: "test", Status: "Success", LogLength: 2048, DurationMilliseconds: 30 }],
      trace: args.noTrace ? undefined : { username: "agent", id: "7tf", expires: "2026-10-22T14:32:11.000Z" } }),
    logGet: async args => {
      if (args.id === "missing") throw Object.assign(new Error("No debug logs found."), {
        trace: { username: "agent", id: "7tf", expires: "2026-10-22T14:32:11.000Z" }
      });
      return ({ ...args, id: "07L000000000001", operation: "test", status: "Failed", duration: 30, length: 2048,
      body: "x|EXECUTION_STARTED\n" + "x|USER_DEBUG|[1]|DEBUG|hello" });
    },
    test: async args => {
      if (args.logs) return { ...args, testsRan: 1, passing: 0, failing: 1, outcome: "Failed", setupFailures: [], failures: [],
        logs: [{ id: "07L000000000001", operation: "test", status: "Failed", body: "x|USER_DEBUG|[1]|DEBUG|hello" }] };
      throw Object.assign(new Error("org unreachable"), { name: "ConnectionError" }); }
  };
}

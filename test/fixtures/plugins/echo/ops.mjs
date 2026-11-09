let applied = 0;
let active = 0;
let maximum = 0;
let retries = new Set();
const schema = { shape: { text: {}, loud: {}, tag: {}, planCount: {}, applyCount: {} }, safeParse(value) { return value && typeof value === "object" && !Array.isArray(value) && value.invalid !== true
  ? { success: true, data: value } : { success: false, error: { issues: [{ path: [], message: "Expected options object" }] } }; } };
const read = (id, run, extra = {}) => ({ kind: "read", descriptor: { id: `echo.${id}`, title: id, summary: id,
  effects: ["read"], requiresOrg: "none", requiresProject: false, retry: "safe", optionsSchema: schema, ...extra }, run });
const write = (id, effects) => ({ kind: "write", descriptor: { ...read(id).descriptor, effects: ["org-write"], retry: "unsafe" },
  async plan(conn, options) { return { effects, summary: "echo write", n: options.n ?? 1 }; },
  async apply(conn, plan) { return { n: plan.n, applied: ++applied }; } });
export default { apiVersion: 0, operations: [
  read("say", async (conn, options, ctx) => ({ text: options.text, pid: process.pid, path: ctx.resolvePath("file"), applied }), { cliId: "echo:say" }),
  read("slow", async (conn, options, ctx) => {
    ctx.onProgress({ phase: "wait", done: 0, total: 1 });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, options.ms ?? 100);
      const abort = () => { clearTimeout(timer); reject(Object.assign(new Error("Aborted"), { code: "aborted" })); };
      if (ctx.signal.aborted) abort(); else ctx.signal.addEventListener("abort", abort, { once: true });
    });
    return "done";
  }),
  read("hang", async () => new Promise(() => {})),
  read("crash", async () => process.exit(1)),
  read("whoami", async conn => ({ username: conn.getUsername(), build: conn.build }), { requiresOrg: "required" }),
  read("retry", async (conn, options, ctx) => {
    if (!retries.has(options.key)) {
      retries.add(options.key);
      if (options.count !== undefined) ctx.reportFailures(options.count);
      throw Object.assign(new Error("expired"), { errorCode: options.errorCode ?? "INVALID_SESSION_ID" });
    }
    return { build: conn.build };
  }, { requiresOrg: "required" }),
  read("unsafe", async () => { throw Object.assign(new Error("expired"), { name: "INVALID_AUTH_HEADER" }); }, { requiresOrg: "required", retry: "unsafe" }),
  read("project", async (conn, options, ctx) => {
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, 30)); active--;
    return { maximum, projectRoot: ctx.projectRoot };
  }, { requiresProject: true }),
  read("paged", async () => ({ items: [1], total: 2, truncated: true }), { paged: true }),
  read("failures", async (conn, options, ctx) => { ctx.reportFailures(options.count); return "read"; }),
  { kind: "write", descriptor: { ...read("partial").descriptor, effects: ["org-write"], retry: "unsafe" },
    async plan(conn, options, ctx) {
      ctx.notice("plan notice");
      if (options.planCount !== undefined) ctx.reportFailures(options.planCount);
      return { effects: ["org-write"], summary: "partial write", applyCount: options.applyCount };
    },
    async apply(conn, plan, ctx) {
      if (plan.applyCount !== undefined) ctx.reportFailures(plan.applyCount);
      return { applied: true };
    } },
  write("write", ["org-write"]), write("overreach", ["destructive"])
] };

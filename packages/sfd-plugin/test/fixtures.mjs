export const schema = { safeParse: data => ({ success: true, data }) };
export function readOperation(descriptor = {}) {
  return {
    kind: "read",
    descriptor: { id: "test.list", title: "List", summary: "List records", effects: ["read"], requiresOrg: "none", requiresProject: false, retry: "safe", optionsSchema: schema, ...descriptor },
    run: async (_conn, options) => options,
  };
}
export function writeOperation(descriptor = {}) {
  return {
    ...readOperation({ effects: ["org-write"], retry: "unsafe", ...descriptor }),
    kind: "write", plan: async () => ({ summary: "Change records" }), apply: async () => "applied",
  };
}
export const moduleOf = (...operations) => ({ apiVersion: 0, operations });

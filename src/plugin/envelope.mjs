// @ts-check
/** @param {unknown} error @param {string} [retry] */
export function errorEnvelope(error, retry = "unsafe") {
  const e = /** @type {any} */ (error) ?? {};
  return { ok: false, code: String(e.code ?? e.errorCode ?? e.name ?? "error"),
    message: String(e.message ?? error), actions: e.actions ?? [],
    retryable: e.retryable ?? (retry === "safe" ? "safe" : "no") };
}
/** @param {string} code @param {string} message */
export function failure(code, message) { return errorEnvelope({ code, message }); }
/** @param {any} data @param {string[]} warnings @param {number} failures */
export function success(data, warnings = [], failures = 0) {
  return { ok: true, data, warnings,
    ...(failures > 0 ? { failures } : {}),
    ...(typeof data?.total === "number" ? { total: data.total } : {}),
    ...(typeof data?.truncated === "boolean" ? { truncated: data.truncated } : {}) };
}

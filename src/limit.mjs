/**
 * @param {number} max
 * @returns {<T>(fn: () => T | Promise<T>) => Promise<T>}
 */
export function limiter(max) {
  if (!Number.isSafeInteger(max) || max < 1) throw new RangeError("Concurrency must be a positive integer.");
  let active = 0;
  /** @type {{ fn: () => unknown, resolve: (value: any) => void, reject: (reason: unknown) => void }[]} */
  const queue = [];
  const next = () => {
    while (active < max && queue.length) {
      const { fn, resolve, reject } = queue.shift();
      active++;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next(); });
    }
  };
  return (/** @type {() => any} */ fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

export const LIMIT_ERRORS = new Set(["REQUEST_LIMIT_EXCEEDED", "ConcurrentPerOrgLongTxn", "ExceededQuota"]);

/**
 * @template T
 * @param {() => T | Promise<T>} fn
 * @param {{ retries?: number, base?: number, sleep?: (ms: number) => Promise<unknown>, random?: () => number }} [options]
 * @returns {Promise<T>}
 */
export async function withBackoff(fn, { retries = 2, base = 1000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), random = Math.random } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (error) {
      if (!LIMIT_ERRORS.has(error.errorCode ?? error.name) || attempt >= retries) throw error;
      await sleep(base * 3 ** attempt * (0.7 + 0.6 * random()));
    }
  }
}

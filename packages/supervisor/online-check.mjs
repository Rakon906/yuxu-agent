export const DEFAULT_ONLINE_CHECK_MS = 30 * 60 * 1000;

export function onlineCheckInterval(value = DEFAULT_ONLINE_CHECK_MS) {
  const ms = Number(value);
  if (!Number.isSafeInteger(ms) || ms < 60000 || ms > 86400000) throw new Error('Invalid online check interval');
  return ms;
}

/** Idle checks share a 30-minute cache. Actual publication can demand a fresh check. */
export function cachedOnlineCheck(check, { intervalMs = DEFAULT_ONLINE_CHECK_MS, now = Date.now } = {}) {
  intervalMs = onlineCheckInterval(intervalMs);
  let lastAt = -Infinity, value = false, pending = null;
  return async ({ force = false } = {}) => {
    if (pending) return pending;
    if (!force && now() >= lastAt && now() - lastAt < intervalMs) return value;
    pending = (async () => {
      try { value = await check() === true; }
      catch { value = false; }
      lastAt = now();
      return value;
    })();
    try { return await pending; }
    finally { pending = null; }
  };
}

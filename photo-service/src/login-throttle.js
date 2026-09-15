/**
 * Login throttling counts failed attempts only.
 *
 * A district office shares one external address, so counting successful logins as
 * well would lock a whole office out after ten normal sign-ins. Brute force is still
 * bounded because failures keep the bucket alive for the whole window.
 */
export function createLoginThrottle({ limit = 10, windowMs = 15 * 60 * 1000, now = Date.now } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer');
  if (!Number.isSafeInteger(windowMs) || windowMs < 1) throw new TypeError('windowMs must be a positive integer');
  const attempts = new Map();

  function currentBucket(key) {
    const bucket = attempts.get(key);
    if (!bucket) return null;
    if (now() - bucket.started > windowMs) {
      attempts.delete(key);
      return null;
    }
    return bucket;
  }

  return {
    allowed(key) {
      const bucket = currentBucket(key);
      return !bucket || bucket.count < limit;
    },
    recordFailure(key) {
      const bucket = currentBucket(key);
      if (bucket) bucket.count += 1;
      else attempts.set(key, { count: 1, started: now() });
    },
    clear(key) {
      attempts.delete(key);
    },
    get trackedKeys() {
      return attempts.size;
    },
  };
}

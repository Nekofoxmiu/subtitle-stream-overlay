export function sanitizeRemoteIdentity(value, { lower = false } = {}) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return lower ? trimmed.toLowerCase() : trimmed;
}

export function normalizeRemoteStatus(value) {
  const normalized = sanitizeRemoteIdentity(value, { lower: true });
  if (!normalized) return 'unknown';
  if (normalized === 'playing' || normalized === 'play' || normalized === 'streaming') return 'playing';
  if (normalized === 'paused' || normalized === 'pause' || normalized === 'pausing' || normalized === 'stopped' || normalized === 'stop' || normalized === 'stopping') return 'paused';
  if (normalized === 'waiting' || normalized === 'buffering' || normalized === 'loading' || normalized === 'idle' || normalized === 'pending' || normalized === 'queued' || normalized === 'queue' || normalized === 'ready' || normalized === 'connecting') return 'unknown';
  if (normalized === 'finished' || normalized === 'ending' || normalized === 'ended' || normalized === 'complete' || normalized === 'completed') return 'paused';
  return normalized;
}

export function normalizeRemoteUrl(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    url.hash = '';
    return url.toString();
  } catch {
    return trimmed;
  }
}

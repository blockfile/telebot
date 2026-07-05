export type Liveness = boolean | 'unknown';

const UA = { 'user-agent': 'Mozilla/5.0 (compatible; TrenchesScanner/1.0)' };

export async function checkUrlAlive(url: string, fetchFn: typeof fetch = fetch): Promise<Liveness> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchFn(url, { redirect: 'follow', signal: AbortSignal.timeout(5000), headers: UA });
      if (res.status === 404 || res.status === 410) return false;
      if (res.ok) return true;
    } catch {
      // retry once
    }
  }
  return 'unknown';
}

export async function checkXExists(handle: string, fetchFn: typeof fetch = fetch): Promise<Liveness> {
  if (handle.startsWith('community:')) return 'unknown';
  try {
    const url = `https://publish.twitter.com/oembed?url=${encodeURIComponent(`https://twitter.com/${handle}`)}`;
    const res = await fetchFn(url, { signal: AbortSignal.timeout(5000), headers: UA });
    if (res.status === 404) return false;
    if (res.ok) return true;
  } catch {
    // fall through
  }
  return 'unknown';
}

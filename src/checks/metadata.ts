import type { TokenMeta } from '../types'

export function ipfsToHttp(uri: string): string {
  return uri.startsWith('ipfs://') ? `https://ipfs.io/ipfs/${uri.slice('ipfs://'.length)}` : uri
}

export function extractMeta(json: unknown): TokenMeta {
  const j = (json ?? {}) as Record<string, unknown>
  const pick = (k: string): string | undefined => {
    const v = j[k]
    return typeof v === 'string' && v.trim() ? v.trim() : undefined
  }
  return { twitter: pick('twitter'), telegram: pick('telegram'), website: pick('website'), image: pick('image') }
}

/**
 * Best-effort token image URL for a mint, straight from pump.fun's v3 API (`image_uri`, usually an
 * ipfs.io URL — the same source the bonding-phase cards use, and one Telegram CAN fetch, unlike
 * GMGN's Cloudflare-walled logos). Used by the graduation monitor, which only has the mint (no
 * creation-event metadata URI). Returns undefined on any failure → the caller sends text-only.
 * A browser UA is required (the API 403s the default node UA).
 */
export async function fetchPumpImageUri(mint: string, fetchFn: typeof fetch = fetch): Promise<string | undefined> {
  try {
    const res = await fetchFn(`https://frontend-api-v3.pump.fun/coins/${mint}`, {
      headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return undefined;
    const j = (await res.json()) as { image_uri?: unknown };
    return typeof j.image_uri === 'string' && j.image_uri ? ipfsToHttp(j.image_uri) : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchMeta(uri: string, fetchFn: typeof fetch = fetch): Promise<TokenMeta | 'unknown'> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchFn(ipfsToHttp(uri), { signal: AbortSignal.timeout(5000) })
      if (!res.ok) continue
      return extractMeta(await res.json())
    } catch {
      // retry once
    }
  }
  return 'unknown'
}

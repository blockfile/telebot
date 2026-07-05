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
  return { twitter: pick('twitter'), telegram: pick('telegram'), website: pick('website') }
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

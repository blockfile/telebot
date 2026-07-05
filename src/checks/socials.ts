const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/
const RESERVED = new Set(['home', 'search', 'explore', 'intent', 'share', 'hashtag', 'i', 'settings'])

export function normalizeTwitterHandle(input: string): string | null {
  const s = input.trim()
  if (!s) return null
  if (/^@?[A-Za-z0-9_]{1,15}$/.test(s)) return s.replace(/^@/, '').toLowerCase()

  let url: URL
  try {
    url = new URL(s.startsWith('http') ? s : `https://${s}`)
  } catch {
    return null
  }
  if (!/(^|\.)(twitter|x)\.com$/.test(url.hostname)) return null

  const parts = url.pathname.split('/').filter(Boolean)
  if (parts[0] === 'i' && parts[1] === 'communities' && parts[2]) return `community:${parts[2]}`
  if (parts[0] && !RESERVED.has(parts[0].toLowerCase()) && HANDLE_RE.test(parts[0])) {
    return parts[0].toLowerCase()
  }
  return null
}

export function normalizeUrl(s: string): string {
  return s.startsWith('http://') || s.startsWith('https://') ? s : `https://${s}`
}

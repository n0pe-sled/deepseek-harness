/**
 * Per-instance loopback origin hosts for the dsh-app scheme.
 *
 * The harness client classifies a page as loopback-trusted only when
 * `location.hostname` is `localhost`, `[::1]`, or a `127.x.y.z` literal
 * (packages/client/connection/src/loopback-hostname.ts). Every settings
 * surface — Models, Plugins, General — reads through that flag: a non-loopback
 * page puts the describe mirror in process-local 'memory' mode and the UI
 * reports "settings are unavailable in this browser". The content view
 * proxies bytes over the custom scheme, so the origin must still carry a
 * loopback-classified host for those surfaces to work.
 *
 * Each instance gets a stable `127.a.b.c` host: distinct origins per
 * instance keep per-origin state (localStorage, service worker scope)
 * isolated, while the loopback literal keeps every surface in host mode.
 */

/** FNV-1a, 32-bit. Stable across runs and platforms. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/**
 * Derive a loopback host for an instance id, skipping hosts already taken.
 * Deterministic for a given (id, taken) pair; the salt only kicks in on a
 * hash collision, so unrelated instances keep their derived host across
 * app restarts and set changes.
 * @param id - instance id.
 * @param taken - hosts already assigned to other instances.
 * @returns a `127.a.b.c` host (full dotted quad) with a, b and c in 1..254.
 */
export function deriveLoopbackHost(id: string, taken: ReadonlySet<string>): string {
  for (let salt = 0; ; salt += 1) {
    const hash = fnv1a(salt === 0 ? id : `${id}#${String(salt)}`)
    const a = (hash % 254) + 1
    const b = (((hash >>> 8) % 254) + 1)
    const c = (((hash >>> 16) % 254) + 1)
    const host = `127.${String(a)}.${String(b)}.${String(c)}`
    if (!taken.has(host)) return host
  }
}

/**
 * Whether a hostname is loopback-classified the way the harness client
 * classifies it (localhost, [::1], or any 127/8 dotted quad). Mirrors
 * packages/client/connection/src/loopback-hostname.ts for app-side checks.
 * @param hostname - WHATWG URL hostname.
 * @returns true when the harness would treat the page as loopback.
 */
export function isLoopbackClassified(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

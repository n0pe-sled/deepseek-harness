/**
 * The harness's readiness line, parsed in one place.
 *
 * `dsh web` prints `dsh web: http://127.0.0.1:<port>` once it is listening. The
 * port is ephemeral (`--port 0`), so this line is the only way to learn it, and
 * both the local supervisor and the remote provisioner depend on reading it
 * identically. The harness can also print an `(LAN: http://...)` variant, which
 * is deliberately not matched: neither launch shape binds a LAN address, and a
 * tunnel terminus must be loopback.
 */

/** Matches the loopback readiness line anywhere in a chunk of output. */
const READY_URL = /dsh web: (http:\/\/(?:127\.0\.0\.1|localhost):(\d+))/u

/** The readiness URL from one line or output chunk, or undefined. */
export function parseReadyUrl(line: string): string | undefined {
  return READY_URL.exec(line)?.[1]
}

/** The port from one readiness line, or undefined. */
export function parseReadyPort(line: string): number | undefined {
  const match = READY_URL.exec(line)
  const raw = match?.[2]
  if (raw === undefined) return undefined
  const port = Number.parseInt(raw, 10)
  return Number.isSafeInteger(port) && port > 0 && port <= 65535 ? port : undefined
}

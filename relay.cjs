/**
 * Loopback relay for the dsh sandbox image.
 *
 * The harness deliberately refuses `--host 0.0.0.0` (a safety guard against
 * exposing the web UI to the network), so a container publishing its harness
 * port directly looks healthy while every proxied connection is reset: the
 * server is bound to the container's own loopback and the forwarded
 * connection arrives on eth0. The fix, verified end to end in the previous
 * session's probe, is a second listener on 0.0.0.0 *inside the same
 * container* that shovels bytes to the loopback harness. Docker publishes
 * this port; the harness keeps its loopback bind and its trust fence.
 *
 * ~10 lines on purpose: no extra package, nothing to build.
 */
const net = require('node:net')

const HARNESS_PORT = Number(process.env.HARNESS_PORT ?? 3000)
const RELAY_PORT = Number(process.env.RELAY_PORT ?? 3081)

net
  .createServer((client) => {
    const upstream = net.connect(HARNESS_PORT, '127.0.0.1')
    client.pipe(upstream)
    upstream.pipe(client)
    client.on('error', () => upstream.destroy())
    upstream.on('error', () => client.destroy())
  })
  .listen(RELAY_PORT, '0.0.0.0', () => {
    console.log(`sandbox relay 0.0.0.0:${RELAY_PORT} -> 127.0.0.1:${HARNESS_PORT}`)
  })

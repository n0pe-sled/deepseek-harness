#!/usr/bin/env bash
# Container entrypoint for the dsh sandbox image.
#
# Duties, in order:
#   1. Seed /data (DSH_HOME) from the image's baked profile on first boot only,
#      so user state survives upgrades (the seed never overwrites).
#   2. Start the harness on container loopback (its only supported bind).
#   3. Start the 0.0.0.0 relay (relay.cjs) and stay in the foreground.
#
# docker run must run this image in the FOREGROUND (no -d) or follow
# `docker logs -f`: the harness's readiness line ("dsh web: http://...") is
# what supervisors parse, and it flows to container stdout.
#
# bash is used deliberately: `wait -n` exits as soon as either child dies, so
# the container falls over with both processes instead of limping on half-dead.
set -euo pipefail

HARNESS_PORT="${HARNESS_PORT:-3000}"
RELAY_PORT="${RELAY_PORT:-3081}"
export HARNESS_PORT RELAY_PORT

if [ ! -e /data/.dsh-seeded ]; then
  echo "sandbox: seeding /data from the image profile"
  mkdir -p /data
  cp -a /opt/seed-home/. /data/
  touch /data/.dsh-seeded
fi

# `web` is an alias for `--profile web`, which is exactly the profile the image
# seeds its plugins into — so this boots the full web UI with every plugin. No
# parent `--profile` may be passed: the web subcommand rejects one (it IS the
# profile selector). A home seeded without that profile still boots, because
# the harness initializes it from the web template.
node /opt/harness/lib/bin.js web --port "$HARNESS_PORT" --no-open &
HARNESS_PID=$!
node /opt/relay.cjs &
RELAY_PID=$!

cleanup() {
  kill "$HARNESS_PID" "$RELAY_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup TERM INT EXIT

wait -n "$HARNESS_PID" "$RELAY_PID"

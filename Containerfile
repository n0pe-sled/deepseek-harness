# syntax=docker/dockerfile:1
#
# dsh sandbox image: the fork's harness closure, every plugin pre-installed
# into a "sandbox" profile, and the loopback relay that makes the published
# port actually work (see relay.cjs for why a plain port publish is not enough).
#
# The build context is prepared by scripts/prepare-context.mjs:
#
#   build/closure-amd64/    linux-x64-glibc harness closure (TARGETARCH amd64)
#   build/closure-arm64/    linux-arm64-glibc harness closure (TARGETARCH arm64)
#   build/plugins-src/      every plugin, built (lib/ present)
#   build/seed-home/        a $DSH_HOME whose sandbox profile lists all plugins
#
# Per-arch closures are staged by CI on the runner (the staging script's
# worktree path handles foreign targets without emulation), so the image build
# itself runs no cross-arch code and buildx only assembles two thin layers.
FROM node:22-bookworm-slim

COPY build/closure-${TARGETARCH}/ /opt/harness/
COPY build/plugins-src/ /opt/plugins/
COPY build/seed-home/ /opt/seed-home/
COPY relay.cjs /opt/relay.cjs
COPY entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh /opt/relay.cjs \
  && mkdir -p /data \
  && chown node:node /data

ENV DSH_HOME=/data \
    NODE_ENV=production

# The published port is the relay's (3081); the harness itself (3000) stays on
# container loopback. Healthcheck talks to the harness directly: the relay can
# only be proven from outside the container, which is the supervisor's job.
EXPOSE 3081
HEALTHCHECK --interval=10s --timeout=5s --start-period=120s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/host.describe').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/entrypoint.sh"]

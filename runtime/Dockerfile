# Fullbeam resolves and records the built image digest before accepting execution.
# Node base digest resolved from Docker Hub registry on 2026-09-18.
FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates procps && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 agent && useradd --uid 10001 --gid 10001 --create-home agent \
 && groupadd --gid 10002 verifier && useradd --uid 10002 --gid 10002 --create-home verifier \
 && groupadd --gid 10003 application && useradd --uid 10003 --gid 10003 --create-home application \
 && npm install --global --ignore-scripts @openai/codex@0.125.0 \
 && mkdir -p /opt/fullbeam /var/lib/fullbeam /workspace \
 && chmod 711 /var/lib/fullbeam && chmod 755 /opt/fullbeam /workspace
COPY --chown=root:root package.json package-lock.json /opt/fullbeam/
RUN npm ci --prefix /opt/fullbeam --ignore-scripts --no-audit --no-fund
COPY --chown=root:root supervisor.mjs /opt/fullbeam/supervisor.mjs
RUN chmod 444 /opt/fullbeam/supervisor.mjs && codex --version
ENV PORT=8080
EXPOSE 8080
USER root
CMD ["node", "/opt/fullbeam/supervisor.mjs", "serve"]

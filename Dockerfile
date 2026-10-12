# You only get one slot: the site, the Node server and Archipelago's
# MultiServer in one image. Build from a checkout with submodules:
#   git submodule update --init vendor/archipelago
#   docker build -t you-only-get-one-slot .

ARG NODE_VERSION=24
ARG PYTHON_VERSION=3.12

# --- the site: AP bundle for the browser + the Vite build ---------------------
FROM node:${NODE_VERSION}-bookworm AS web
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN test -f vendor/archipelago/MultiServer.py || { echo "vendor/archipelago is empty — run: git submodule update --init vendor/archipelago" >&2; exit 1; }
RUN ./pack.sh && npm run build

# --- the server's runtime dependencies ----------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS server-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- MultiServer: Archipelago with its server-side requirements ---------------
FROM python:${PYTHON_VERSION}-slim-bookworm AS ap
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /ap
COPY vendor/archipelago/ ./
# The client GUI (kivy) and Windows-only packages aren't needed to host.
RUN grep -vE '^(kivy|kivymd|Pymem|pyshortcuts)\b' requirements.txt > /tmp/requirements.txt \
 && python -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt "setuptools>=75,<81" \
 && /opt/venv/bin/cythonize -b -i _speedups.pyx \
 && rm -rf build test docs
# MultiServer loads every world at startup; the seed is Crystal only, and some
# others need packages not installed here (their import errors fill the log).
RUN find worlds -mindepth 1 -maxdepth 1 \( -type d -o -name '*.apworld' \) \
      ! -name generic ! -name _bizhawk ! -name pokemon_crystal -exec rm -rf {} +

# --- runtime ------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS node-bin

FROM python:${PYTHON_VERSION}-slim-bookworm
COPY --from=node-bin /usr/local/bin/node /usr/local/bin/node
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home-dir /app --shell /usr/sbin/nologin yogos \
 && mkdir -p /data && chown yogos:yogos /data
WORKDIR /app
COPY --from=ap /opt/venv /opt/venv
# MultiServer writes its logs and a default host.yaml next to itself.
COPY --from=ap --chown=yogos:yogos /ap /app/archipelago
COPY --from=server-deps /app/node_modules /app/node_modules
COPY --from=web /src/dist /app/dist
COPY package.json /app/
COPY shared /app/shared
COPY server/src /app/server/src

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    STATIC_DIR=/app/dist \
    AP_DIR=/app/archipelago \
    PYTHON=/opt/venv/bin/python \
    SKIP_REQUIREMENTS_UPDATE=1 \
    PYTHONUNBUFFERED=1

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Starts as root only to make /data writable, then runs as yogos (see the
# entrypoint).
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server/src/main.ts"]

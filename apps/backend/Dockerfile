# Multi-stage: build-base (python3+make+g++) só na imagem de build pra compilar
# better-sqlite3. Runtime fica enxuto.
#
# Não compilamos o TS: o pacote @assistant/shared é source-only (main aponta
# pra src/index.ts), então tsx resolve TypeScript em runtime — funciona com
# qualquer estrutura de workspace sem precisar emitir dist/.

FROM node:22-alpine AS builder

WORKDIR /workspace

# Toolchain pra compilar better-sqlite3 (native via gyp).
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/backend ./apps/backend

# --ignore-scripts pula postinstall hooks (que tentariam lifecycle do shared).
# Depois rebuild só do better-sqlite3 — único módulo nativo que precisamos.
RUN npm ci --workspaces --include-workspace-root --ignore-scripts \
 && npm rebuild better-sqlite3 --build-from-source

# ===== Runtime =====
FROM node:22-alpine

WORKDIR /app

# tini = init pid 1. procps = `ps` GNU (o BusyBox não tem as flags que as
# métricas do servidor usam pra listar processos).
RUN apk add --no-cache tini procps

# Copia node_modules (com tsx + better-sqlite3 já compilado), packages, backend
# e os configs de workspace que tsx precisa pra resolver os imports.
COPY --from=builder /workspace/node_modules ./node_modules
COPY --from=builder /workspace/packages ./packages
COPY --from=builder /workspace/apps/backend ./apps/backend
COPY --from=builder /workspace/package.json ./package.json
COPY --from=builder /workspace/tsconfig.base.json ./tsconfig.base.json

# Volume pra persistir o SQLite entre restarts.
VOLUME /app/data

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV DB_PATH=/app/data/pixxel.db
# Memória, planos de estudo, registros e estado das integrações (migrar a
# ~/pixxel antiga pra ./data/pixxel no host).
ENV PIXXEL_DATA_DIR=/app/data/pixxel

WORKDIR /app/apps/backend

# tini = init pid 1, recebe SIGTERM corretamente
ENTRYPOINT ["/sbin/tini", "--"]
# tsx loader resolve TS em runtime (esm import hook). Não precisa de tsc build.
CMD ["node", "--import", "tsx/esm", "src/server.ts"]

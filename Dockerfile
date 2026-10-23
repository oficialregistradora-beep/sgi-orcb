# SGI-ORCB — imagem de produção (Cloud Run ou qualquer host com Docker)
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Dependências de produção (sem as de desenvolvimento): os scripts de migração e de carga rodam fora do servidor web
# e precisam das bibliotecas (zod, pg…) que o modo standalone só inclui empacotadas dentro do próprio servidor.
FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=8080 HOSTNAME=0.0.0.0
RUN useradd --system --uid 10001 sgi
COPY --from=prod-deps --chown=sgi /app/node_modules ./node_modules
COPY --from=build --chown=sgi /app/.next/standalone ./
COPY --from=build --chown=sgi /app/.next/static ./.next/static
COPY --from=build --chown=sgi /app/db ./db
COPY --from=build --chown=sgi /app/src ./src
COPY --from=build --chown=sgi /app/scripts ./scripts
USER sgi
EXPOSE 8080
# Migrations: executar como job separado (node --experimental-strip-types scripts/migrate.ts) com credencial de proprietário.
CMD ["node", "server.js"]

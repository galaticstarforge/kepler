FROM node:20-alpine AS builder
RUN npm install -g pnpm@9.15.4
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/core/package.json ./packages/core/
RUN pnpm install --frozen-lockfile --filter @keplerforge/core...

COPY packages/shared/ ./packages/shared/
COPY packages/core/ ./packages/core/
RUN pnpm --filter @keplerforge/core... build

FROM node:20-alpine
RUN addgroup kepler && adduser -G kepler -D kepler
WORKDIR /app
COPY --from=builder /app/packages/core/package.json ./
RUN sed -i '/@keplerforge\/shared/d' package.json && npm install --omit=dev
COPY --from=builder --chown=kepler:kepler /app/packages/core/dist ./dist
USER kepler
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8080/health || exit 1
CMD ["node", "dist/index.js"]

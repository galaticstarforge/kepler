FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY dist/ ./dist/

FROM node:20-alpine
RUN addgroup kepler && adduser -G kepler -D kepler
WORKDIR /app
COPY --from=builder --chown=kepler:kepler /app /app
USER kepler
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8080/health || exit 1
CMD ["node", "dist/index.js"]

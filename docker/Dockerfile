# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0
WORKDIR /app

# Copy production deps and source
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY proto ./proto
COPY src ./src
COPY tools ./tools
COPY views ./views
COPY public ./public

# Drop privileges; group-root ownership lets arbitrary (OpenShift) UIDs read the app
RUN addgroup -S app && adduser -S app -G app && chown -R app:0 /app && chmod -R g=u /app
USER app

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1

CMD ["node", "src/server.js"]

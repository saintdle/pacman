# syntax=docker/dockerfile:1.7

# Keep build and runtime on Debian 13 so the runtime base receives current security updates.
FROM node:22-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY proto ./proto
COPY src ./src
COPY tools ./tools
COPY views ./views
COPY public ./public
COPY demo-fixtures ./demo-fixtures

# OpenShift may assign any UID. The app runs read-only and every runtime file
# must be readable without relying on a particular group membership.
RUN chmod -R a+rX /app \
  && rm -f /app/tools/check-container-image-contract.js /app/tools/smoke-container-images.js

FROM gcr.io/distroless/nodejs22-debian13:nonroot AS runtime
ARG APP_VERSION=dev
ARG COMMIT_SHA=unknown
ARG BUILD_DATE=unknown
ENV NODE_ENV=production \
    PATH="/nodejs/bin:${PATH}" \
    PORT=8080 \
    HOST=0.0.0.0 \
    APP_VERSION=$APP_VERSION \
    COMMIT_SHA=$COMMIT_SHA \
    BUILD_DATE=$BUILD_DATE
LABEL org.opencontainers.image.version=$APP_VERSION \
      org.opencontainers.image.revision=$COMMIT_SHA \
      org.opencontainers.image.created=$BUILD_DATE
WORKDIR /app

COPY --from=build --chown=0:0 /app /app
USER 65532:65532

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 CMD ["/nodejs/bin/node", "tools/healthcheck.js"]
ENTRYPOINT ["/nodejs/bin/node"]
CMD ["src/server.js"]

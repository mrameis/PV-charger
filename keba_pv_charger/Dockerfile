FROM node:20-bookworm-slim AS build
WORKDIR /app
# Build-Tools für better-sqlite3 (native Bindings)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY public ./public
RUN mkdir -p /data
ENV NODE_ENV=production
ENV DB_PATH=/data/history.db

ARG BUILD_VERSION=1.0.0
ARG BUILD_ARCH=amd64
LABEL \
  io.hass.version="${BUILD_VERSION}" \
  io.hass.type="app" \
  io.hass.arch="${BUILD_ARCH}"

EXPOSE 8080
CMD ["node", "dist/server.js"]

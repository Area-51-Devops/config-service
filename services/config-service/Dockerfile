FROM node:20-alpine
WORKDIR /usr/src/app

# Upgrade all OS packages to latest patched versions..
RUN apk update && apk upgrade --no-cache

COPY config-service/package*.json ./
RUN (npm ci --omit=dev || npm install --omit=dev) && \
  npm cache clean --force && \
  rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY config-service/src ./src
COPY shared ./shared

EXPOSE 3008
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:3008/health/startup || exit 1
CMD ["node", "src/index.js"]

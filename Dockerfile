# ---- 1. Függőségek + editor bundle ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# dev függőségek (emojibase-data) csak a buildhez kellenek, a végén kikerülnek
RUN npm ci
COPY build ./build
COPY lib/prism-extend.js ./lib/prism-extend.js
RUN npx --yes esbuild@0.25 build/editor-entry.js --bundle --minify --format=iife \
      --outfile=/app/public-vendor/toastui-editor-all.min.js \
 && node build/emoji-build.js /app/public-vendor/emoji.json \
 && npm prune --omit=dev

# ---- 2. Runtime ----
FROM node:22-alpine
RUN apk add --no-cache git tini ca-certificates
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/public-vendor ./public/vendor-built
COPY . .
RUN chmod +x askpass.sh && mkdir -p /data && chown node:node /data

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080

USER node
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]

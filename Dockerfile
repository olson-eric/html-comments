# syntax=docker/dockerfile:1
# Pinned by digest so the base image can't change underneath the tag;
# Dependabot bumps the digest when node:22-alpine is updated.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

ENV NODE_ENV=production \
    PORT=4747 \
    HOST=0.0.0.0 \
    HTML_DIR=/content \
    COMMENTS_DIR=/comments

WORKDIR /app

COPY package.json package-lock.json ./
# Optional: build with `--secret id=npmrc,src=<path to .npmrc>` to install
# through a private registry or proxy. The file is mounted only for this step
# and never stored in a layer; the cache mount keeps npm's download cache out
# of the image too. Without the secret, packages come from the public registry.
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

COPY server.js LICENSE README.md ./
COPY public/ ./public/

# /content is the served directory (mount your files here, read-only is fine);
# /comments holds the comment JSON and must be writable.
RUN mkdir -p /content /comments && chown node:node /content /comments

USER node
EXPOSE 4747

# /health is always served at the root, even with BASE_PATH set.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO /dev/null "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "server.js"]

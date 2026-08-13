# Pinned by digest so the base image can't change underneath the tag;
# Dependabot bumps the digest when node:22-alpine is updated.
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

ENV NODE_ENV=production \
    PORT=4747 \
    HOST=0.0.0.0 \
    HTML_DIR=/content \
    COMMENTS_DIR=/comments

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

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

# Pinned by digest so the base image can't change underneath the tag;
# Dependabot bumps the digest when node:22-alpine is updated.
FROM node:26-alpine@sha256:aadf416b2cdce311a8811ba3f0608a61b77dbf997500e2eafe781b51f6a0b019

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

FROM node:22-alpine

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

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO /dev/null "http://127.0.0.1:${PORT}/api/root" || exit 1

CMD ["node", "server.js"]

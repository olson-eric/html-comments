# Welcome to html-comments

This is a sample document, here so a bare `docker compose up` (or
`node server.js`) has something to serve out of the box.

Try it out:

1. Select some of this text.
2. Click **Comment** and leave a note.
3. Read it back through the JSON API:

```bash
curl -s "http://localhost:4747/api/file/comments?path=welcome" | jq
```

To serve your own files instead, point `HTML_DIR` at a directory of
`.html`, `.md`, or image files.

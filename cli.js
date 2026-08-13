#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_SERVER = process.env.HTML_COMMENTS_URL || 'http://localhost:4747';
const DEFAULT_HEADERS = process.env.HTML_COMMENTS_TOKEN
  ? { Authorization: `Bearer ${process.env.HTML_COMMENTS_TOKEN}` }
  : {};
const DEFAULT_AUTHOR = process.env.HTML_COMMENTS_AUTHOR || 'agent';
const COMMANDS = new Set(['serve', 'list', 'show', 'poll', 'reply', 'resolve', 'publish', 'updates', 'open', 'help']);

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(code, message, hint, exitCode = 1) {
  output({ error: { code, message, ...(hint ? { hint } : {}) } });
  process.exitCode = exitCode;
}

function takeOption(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function takeFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function apiUrl(server, route, query = {}) {
  const base = server.replace(/\/+$/, '');
  const url = new URL(`${base}/${route.replace(/^\/+/, '')}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== null && value !== undefined) url.searchParams.set(key, value);
  }
  return url;
}

async function request(server, route, options = {}, query = {}) {
  let response;
  try {
    response = await fetch(apiUrl(server, route, query), {
      ...options,
      headers: { ...DEFAULT_HEADERS, ...(options.headers || {}) },
    });
  } catch (error) {
    const wrapped = new Error(`Cannot reach ${server}: ${error.cause?.message || error.message}`);
    wrapped.code = 'SERVER_UNREACHABLE';
    throw wrapped;
  }
  if (response.status === 204) return null;
  const type = response.headers.get('content-type') || '';
  const body = type.includes('json') ? await response.json() : await response.text();
  if (!response.ok) {
    const message = typeof body === 'object' && body?.error ? body.error : String(body || response.statusText);
    const error = new Error(message);
    error.code = `HTTP_${response.status}`;
    throw error;
  }
  return body;
}

function encodePath(value) {
  return value.split('/').map(encodeURIComponent).join('/');
}

function help() {
  output({
    description: 'Review HTML, markdown, and image artifacts with human comments and an agent-friendly workflow.',
    server: DEFAULT_SERVER,
    commands: {
      'html-comments': 'Show documents needing attention and queued feedback',
      'html-comments serve [dir]': 'Start the review server',
      'html-comments list [--status open|resolved|uncommented|all]': 'List documents',
      'html-comments show <doc>': 'Show a document and its comment threads',
      'html-comments poll [--timeout seconds]': 'Wait for a feedback batch',
      'html-comments reply <doc> <comment-id> <text> [--resolve]': 'Reply, optionally resolving atomically',
      'html-comments resolve <doc> <comment-id>': 'Resolve a comment thread',
      'html-comments publish <file> [--to path]': 'Publish or update an artifact',
      'html-comments updates [--since ISO-time]': 'Read activity',
      'html-comments open <doc>': 'Print the browser review URL',
    },
    options: {
      '--server <url>': 'Override HTML_COMMENTS_URL',
      HTML_COMMENTS_TOKEN: 'Optional bearer token sent without displaying it',
      HTML_COMMENTS_AUTHOR: 'Reply author when no verified proxy identity is present (default: agent)',
    },
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) return help();
  const server = takeOption(args, '--server', DEFAULT_SERVER);
  let command = args.shift();

  // Preserve the original executable shorthand: `html-comments ./artifacts`.
  if (command && !COMMANDS.has(command) && (command.startsWith('.') || command.includes('/') || fs.existsSync(command))) {
    args.unshift(command);
    command = 'serve';
  }

  if (command && !COMMANDS.has(command)) throw new Error(`unknown command: ${command}`);

  if (!command) {
    const home = await request(server, '/api/agent/home');
    home.next_step = home.counts.queuedReviews
      ? 'Run `html-comments poll` to receive queued feedback.'
      : home.counts.needingReview
        ? 'Run `html-comments show <doc>` to inspect open comments.'
        : 'No documents need attention. Run `html-comments list --status all` to browse everything.';
    return output(home);
  }

  if (command === 'help') return help();
  if (command === 'serve') {
    if (args.length > 1) throw new Error('usage: html-comments serve [dir]');
    const child = spawn(process.execPath, [path.join(__dirname, 'server.js'), ...(args[0] ? [args[0]] : [])], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', (code, signal) => {
      if (signal) process.kill(process.pid, signal);
      else process.exitCode = code || 0;
    });
    return;
  }

  if (command === 'list') {
    const status = takeOption(args, '--status', 'open');
    const limit = takeOption(args, '--limit', '50');
    if (args.length) throw new Error(`unknown argument: ${args[0]}`);
    const result = await request(server, '/api/documents', {}, { status, limit });
    result.next_step = result.count
      ? 'Run `html-comments show <doc>` to inspect a document.'
      : `No ${status} documents found.`;
    return output(result);
  }

  if (command === 'show') {
    const doc = args.shift();
    if (!doc || args.length) throw new Error('usage: html-comments show <doc>');
    const result = await request(server, '/api/file', {}, { path: doc });
    result.next_step = result.comments.some((comment) => !comment.resolved)
      ? 'After applying feedback, run `html-comments reply <doc> <comment-id> "what changed" --resolve`.'
      : 'No open comments remain.';
    return output(result);
  }

  if (command === 'poll') {
    const timeoutValue = takeOption(args, '--timeout', null);
    if (args.length) throw new Error(`unknown argument: ${args[0]}`);
    const deadline = timeoutValue === null ? null : Date.now() + Math.max(1, Number(timeoutValue)) * 1000;
    if (timeoutValue !== null && !Number.isFinite(Number(timeoutValue))) throw new Error('--timeout must be a number');
    if (process.stderr.isTTY) process.stderr.write('Waiting for review feedback…\n');
    while (deadline === null || Date.now() < deadline) {
      const remaining = deadline === null ? 30 : Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
      const result = await request(server, '/api/agent/poll', {}, { timeout: Math.min(30, remaining) });
      if (result) {
        // The structured job is sufficient; omit the server's duplicate prose prompt.
        return output({ review: result.job, next_step: 'Apply each comment, then reply and resolve its thread. Poll again when ready.' });
      }
    }
    return output({ status: 'timeout', count: 0, next_step: 'Run `html-comments poll` to keep waiting.' });
  }

  if (command === 'reply') {
    const resolve = takeFlag(args, '--resolve');
    const doc = args.shift();
    const commentId = args.shift();
    const text = args.join(' ');
    if (!doc || !commentId || !text) throw new Error('usage: html-comments reply <doc> <comment-id> <text> [--resolve]');
    const route = `/api/file/comments/${encodeURIComponent(commentId)}/${resolve ? 'complete' : 'replies'}`;
    const result = await request(server, route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, author: DEFAULT_AUTHOR }),
    }, { path: doc });
    return output({ ...result, next_step: resolve ? 'Thread resolved. Continue with the next open comment.' : 'Reply added.' });
  }

  if (command === 'resolve') {
    const [doc, commentId, ...rest] = args;
    if (!doc || !commentId || rest.length) throw new Error('usage: html-comments resolve <doc> <comment-id>');
    const result = await request(server, `/api/file/comments/${encodeURIComponent(commentId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolved: true }),
    }, { path: doc });
    return output({ comment: result, next_step: 'Thread resolved.' });
  }

  if (command === 'publish') {
    const to = takeOption(args, '--to', null);
    const file = args.shift();
    if (!file || args.length) throw new Error('usage: html-comments publish <file> [--to path]');
    const target = to || path.basename(file);
    const body = fs.readFileSync(file);
    const result = await request(server, `/api/upload/${encodePath(target)}`, { method: 'PUT', body });
    return output({ document: result, next_step: `Open ${server.replace(/\/+$/, '')}/v/${encodePath(result.path)} for review.` });
  }

  if (command === 'updates') {
    const since = takeOption(args, '--since', null);
    if (args.length) throw new Error(`unknown argument: ${args[0]}`);
    const result = await request(server, '/api/updates', {}, { since });
    result.count = result.events.length;
    result.next_step = `Use --since ${result.now} on the next request.`;
    return output(result);
  }

  if (command === 'open') {
    const doc = args.shift();
    if (!doc || args.length) throw new Error('usage: html-comments open <doc>');
    return output({ path: doc, url: `${server.replace(/\/+$/, '')}/v/${encodePath(doc)}`, next_step: 'Share this URL with the reviewer.' });
  }
}

main().catch((error) => {
  const validation = !error.code;
  fail(error.code || 'USAGE_ERROR', error.message, validation ? 'Run `html-comments --help` for command syntax.' : 'Check the server URL and command arguments.', validation ? 2 : 1);
});

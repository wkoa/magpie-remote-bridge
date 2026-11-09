'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

/** A filesystem-protected channel for Codex command auth; never a TCP listener. */
async function startCredentialBroker(token, { available = () => true, platform = process.platform } = {}) {
  if (platform === 'win32') {
    const error = new Error('Codex sidebar bridging requires a macOS or Linux client');
    error.code = 'UNSUPPORTED_CLIENT'; throw error;
  }
  if (typeof token !== 'string' || !token || /[\x00-\x20\x7f]/.test(token)) throw new Error('Invalid bridge capability');
  let directory; let server; let closing; let closed = false;
  const sockets = new Set();
  const close = () => {
    if (!closing) {
      closed = true;
      for (const socket of sockets) socket.destroy();
      closing = (async () => {
        if (server?.listening) await new Promise(resolve => server.close(resolve));
        if (directory) await fs.rm(directory, { recursive: true, force: true });
      })();
    }
    return closing;
  };
  try {
    // /tmp keeps AF_UNIX paths below macOS's 104-byte limit. mkdtemp is exclusive.
    directory = await fs.mkdtemp(path.join(platform === 'darwin' ? '/tmp' : os.tmpdir(), 'mpb-cred-'));
    await fs.chmod(directory, 0o700);
    const socketPath = path.join(directory, 'c.sock');
    server = http.createServer((request, response) => {
      request.on('error', () => {}); response.on('error', () => {});
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Connection', 'close');
      if (request.method !== 'GET' || !['/token', '/health'].includes(request.url) || request.headers['transfer-encoding'] ||
          (request.headers['content-length'] && request.headers['content-length'] !== '0')) {
        response.writeHead(404); response.end(); request.resume(); return;
      }
      // The remote recovery watchdog checks liveness without requesting a token.
      if (request.url === '/health') { response.writeHead(closed ? 503 : 204); response.end(); return; }
      if (closed || !available()) { response.writeHead(503); response.end(); return; }
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(token + '\n');
    });
    server.requestTimeout = 5000; server.headersTimeout = 5000; server.maxHeadersCount = 16;
    server.on('connection', socket => {
      sockets.add(socket); socket.setTimeout(5000, () => socket.destroy());
      socket.once('close', () => sockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    await fs.chmod(socketPath, 0o600);
    server.on('error', () => { void close().catch(() => {}); });
    return { socketPath, close };
  } catch (error) { await close(); throw error; }
}

module.exports = { startCredentialBroker };

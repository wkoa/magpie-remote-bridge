'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { startCredentialBroker } = require('../src/credential-broker');
const { CodexSidebarBridge } = require('../src/codex-sidebar');

const unix = { skip: process.platform === 'win32' };
const get = (socketPath, url = '/token', method = 'GET', headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ socketPath, path: url, method, headers }, res => {
    let body = ''; res.setEncoding('utf8'); res.on('data', text => { body += text; });
    res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
  });
  req.on('error', reject); req.end();
});
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

test('credential broker exposes a short private Unix socket with no token file', unix, async t => {
  const token = 'private-test-capability';
  const broker = await startCredentialBroker(token); t.after(() => broker.close());
  assert.ok(broker.socketPath.length < 104);
  const directory = path.dirname(broker.socketPath);
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(broker.socketPath)).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readdir(directory), [path.basename(broker.socketPath)]);
  const response = await get(broker.socketPath);
  assert.equal(response.status, 200); assert.equal(response.body, token + '\n');
  assert.equal(response.headers['cache-control'], 'no-store');
  for (const [url, method, headers] of [['/token?x=1', 'GET'], ['/other', 'GET'], ['/token', 'POST'], ['/token', 'GET', { 'content-length': '1' }]]) {
    const denied = await get(broker.socketPath, url, method, headers);
    assert.equal(denied.status, 404); assert.ok(!denied.body.includes(token));
  }
  const closing = broker.close(); assert.equal(broker.close(), closing); await closing;
  await assert.rejects(get(broker.socketPath));
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});

test('credential broker withholds credentials during reconnect and closes stalled peers', unix, async t => {
  let available = false;
  const broker = await startCredentialBroker('synthetic-capability', { available: () => available });
  t.after(() => broker.close());
  assert.equal((await get(broker.socketPath)).status, 503);
  const health = await get(broker.socketPath, '/health');
  assert.equal(health.status, 204); assert.equal(health.body, '');
  available = true; assert.equal((await get(broker.socketPath)).status, 200);
  const stalled = net.createConnection(broker.socketPath);
  await new Promise((resolve, reject) => { stalled.once('connect', resolve); stalled.once('error', reject); });
  const ended = new Promise(resolve => stalled.once('close', resolve));
  stalled.write('GET /token HTTP/1.1\r\n');
  await broker.close(); await ended;
});

test('credential broker rejects unsupported hosts and malformed capabilities', async () => {
  await assert.rejects(startCredentialBroker('token', { platform: 'win32' }), /macOS or Linux/);
  for (const token of ['', 'has space', 'line\nbreak', undefined]) await assert.rejects(startCredentialBroker(token, { platform: 'linux' }), /Invalid/);
});

function fixture(overrides = {}) {
  const calls = []; const forwards = []; let brokerClosed = 0; let brokerOptions; let unavailable = 0;
  const controller = new AbortController();
  const tunnel = {
    async codex(request, options) {
      calls.push({ request, options });
      if (overrides.codex) return overrides.codex(request, options);
      return { socketPath: '/tmp/mpb-ide-test/credentials.sock', version: 'test-codex' };
    },
    async openCredentialForward(local, remote, options) {
      const forward = new EventEmitter(); forward.stop = () => { forward.stopped = true; };
      forwards.push({ local, remote, options, forward });
      if (overrides.forward) await overrides.forward();
      return forward;
    }
  };
  const session = { ready: true, controller, tunnel, config: { remotePort: 13425 }, proxy: { token: 'private-capability' } };
  const sidebar = new CodexSidebarBridge(session, {
    unavailable: () => { unavailable++; },
    startBroker: async (token, options) => {
      assert.equal(token, session.proxy.token); brokerOptions = options;
      if (overrides.broker) await overrides.broker();
      return { socketPath: '/tmp/mpb-cred-test/c.sock', close: async () => { brokerClosed++; } };
    }
  });
  return { sidebar, session, calls, tunnel, forwards, controller,
    brokerClosed: () => brokerClosed, available: () => brokerOptions.available(), unavailable: () => unavailable };
}

test('sidebar enables through a private forward and writes only non-secret provider parameters', async t => {
  const f = fixture(); t.after(() => f.sidebar.close());
  const a = f.sidebar.enable(f.tunnel, 'vendor/model');
  assert.equal(f.sidebar.enable(f.tunnel, 'vendor/model'), a);
  assert.deepEqual(await a, { version: 'test-codex' });
  assert.deepEqual(f.calls.map(call => call.request.operation), ['prepare', 'apply']);
  assert.ok(!JSON.stringify(f.calls).includes('private-capability'));
  assert.equal(f.calls[1].request.remotePort, 13425);
  assert.equal(f.calls[1].request.model, 'vendor/model');
  assert.match(f.calls[1].request.owner, /^[a-f0-9]{32}$/);
  assert.equal(f.forwards[0].remote, '/tmp/mpb-ide-test/credentials.sock');
  assert.equal(f.available(), true);
  f.session.ready = false; assert.equal(f.available(), false);
  f.session.ready = true; assert.equal(f.available(), true);
  await f.sidebar.close(); assert.equal(f.available(), false);
  assert.equal(f.brokerClosed(), 1); assert.ok(f.forwards[0].forward.stopped);
});

test('disconnect while a broker is starting cleans the late broker and never prepares remotely', async () => {
  const hold = deferred(); const f = fixture({ broker: () => hold.promise });
  const pending = f.sidebar.enable(f.tunnel, 'model');
  f.controller.abort(); await f.sidebar.close(); hold.resolve();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(f.calls.length, 0); assert.equal(f.brokerClosed(), 1);
});

test('cancelling sidebar setup ends the caller promptly while a late broker remains owned', { timeout: 1000 }, async () => {
  const hold = deferred(); const f = fixture({ broker: () => hold.promise });
  const pending = f.sidebar.enable(f.tunnel, 'model');
  f.controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(f.calls.length, 0); assert.equal(f.brokerClosed(), 0);
  hold.resolve(); await flush(); assert.equal(f.brokerClosed(), 1);
});

test('disconnect during prepare cannot create a credential forward or apply configuration', async () => {
  const hold = deferred(); const f = fixture({ codex: request => request.operation === 'prepare' ? hold.promise : {} });
  const pending = f.sidebar.enable(f.tunnel, 'model'); await flush();
  f.controller.abort(); hold.resolve({ socketPath: '/tmp/prepared/credentials.sock' });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(f.forwards.length, 0); assert.equal(f.calls.length, 1); assert.equal(f.brokerClosed(), 1);
});

test('automatic restoration closes credentials and restores only its owned lease once', async () => {
  const f = fixture({ codex: async request => {
    if (request.operation === 'restore') {
      assert.equal(f.brokerClosed(), 1); assert.equal(f.forwards[0].forward.stopped, true);
      return { restored: ['model_provider'], preserved: ['model'] };
    }
    return { socketPath: '/tmp/prepared/credentials.sock' };
  } });
  await f.sidebar.enable(f.tunnel, 'model');
  const result = await f.sidebar.restore(f.tunnel);
  assert.deepEqual(result.preserved, ['model']);
  assert.deepEqual(f.calls.at(-1).request, { operation: 'restore', owner: f.sidebar.owner });
  assert.equal(f.calls.at(-1).options.signal.aborted, false);
  await f.sidebar.restore(f.tunnel);
  assert.equal(f.calls.filter(call => call.request.operation === 'restore').length, 1);
});

test('automatic restoration retries a busy account lock after an interrupted write', async () => {
  let attempts = 0;
  const f = fixture({ codex: async request => {
    if (request.operation === 'restore' && ++attempts === 1) {
      const error = new Error('account lock busy'); error.code = 'LEASE_BUSY'; throw error;
    }
    return { socketPath: '/tmp/prepared/credentials.sock' };
  } });
  await f.sidebar.enable(f.tunnel, 'model');
  await f.sidebar.restore(f.tunnel);
  assert.equal(attempts, 2); assert.equal(f.sidebar.applied, false);
});

test('failed forwarding cleans a preparation but an interrupted apply retains recovery metadata', async () => {
  const first = fixture({ forward: async () => { throw new Error('forward denied'); } });
  await assert.rejects(first.sidebar.enable(first.tunnel, 'model'), /forward denied/);
  assert.deepEqual(first.calls.map(call => call.request.operation), ['prepare', 'cleanup']);
  assert.equal(first.brokerClosed(), 1);
  const second = fixture({ codex: async request => {
    if (request.operation === 'apply') throw new Error('write outcome unknown');
    return { socketPath: '/tmp/prepared/credentials.sock' };
  } });
  await assert.rejects(second.sidebar.enable(second.tunnel, 'model'), /write outcome unknown/);
  assert.deepEqual(second.calls.map(call => call.request.operation), ['prepare', 'apply']);
  assert.equal(second.brokerClosed(), 1); assert.ok(second.forwards[0].forward.stopped);
});

test('reconnect keeps the broker and restores only the owned socket forwarding', async t => {
  const f = fixture(); t.after(() => f.sidebar.close());
  await f.sidebar.enable(f.tunnel, 'model');
  f.session.ready = false;
  const next = { ...f.tunnel }; f.session.tunnel = next;
  await f.sidebar.reconnect(next);
  assert.deepEqual(f.calls.map(call => call.request.operation), ['prepare', 'apply', 'rebind']);
  assert.equal(f.calls.at(-1).request.socketPath, '/tmp/mpb-ide-test/credentials.sock');
  assert.ok(f.forwards[0].forward.stopped); assert.equal(f.forwards.length, 2);
  assert.equal(f.brokerClosed(), 0); assert.equal(f.available(), false);
  f.session.ready = true; assert.equal(f.available(), true);
  f.forwards[0].forward.emit('closed'); assert.equal(f.unavailable(), 0);
  f.forwards[1].forward.emit('closed'); assert.equal(f.unavailable(), 1); assert.equal(f.available(), false);
});

test('reconnect rejects a changed credential path before opening another forward', async t => {
  const f = fixture({ codex: async request => ({ socketPath: request.operation === 'rebind' ? '/tmp/other/socket' : '/tmp/owned/socket' }) });
  t.after(() => f.sidebar.close()); await f.sidebar.enable(f.tunnel, 'model');
  await assert.rejects(f.sidebar.reconnect(f.tunnel), /ownership changed/);
  assert.equal(f.forwards.length, 1); assert.equal(f.available(), false);
});

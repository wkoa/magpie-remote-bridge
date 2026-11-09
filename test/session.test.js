'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { BridgeSession } = require('../src/session');

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

const { Clock } = require('./helpers/clock');

function fixture(overrides = {}) {
  const tunnels = [], proxies = [], auths = [], states = [], failures = [];
  const clock = new Clock();
  const config = { host: 'alias', gatewayPort: 3425, remotePort: 13425, autoReconnect: true };
  class FakeTunnel extends EventEmitter {
    constructor(options) { super(); this.options = options; tunnels.push(this); }
    async start({ signal }) { this.signal = signal; if (overrides.start) await overrides.start(this, signal); }
    async probe(token) { this.token = token; if (overrides.probe) await overrides.probe(this); }
    stop() { this.stopped = true; }
  }
  const session = new BridgeSession({
    clock,
    readConfig: () => config,
    resolveTarget: overrides.resolveTarget || (async () => ({ host: 'user@host', sshPort: 2222 })),
    getGatewayKey: overrides.getGatewayKey || (async () => 'local-key'),
    getModels: overrides.getModels || (async () => ['vendor/model']),
    startProxy: overrides.startProxy || (async () => {
      const proxy = { token: `capability-${proxies.length}`, port: 49000, close() { this.closed = true; } };
      proxies.push(proxy); return proxy;
    }),
    startAuth: overrides.startAuth || (async () => {
      const auth = { close() { this.closed = true; } };
      auths.push(auth); return auth;
    }),
    createTunnel: options => new FakeTunnel(options), promptPassword: async () => undefined,
    log: { info() {}, warn() {}, protect() {} }
  });
  session.on('state', state => states.push(state.state));
  session.on('failure', (error, stage) => failures.push({ error, stage }));
  return { session, tunnels, proxies, auths, clock, config, states, failures };
}

test('concurrent connect calls share one setup and capture target port', async t => {
  const f = fixture(); t.after(() => f.session.dispose());
  const a = f.session.connect(), b = f.session.connect();
  assert.equal(a, b);
  const s = await a;
  assert.equal(s.ready, true);
  assert.equal(f.tunnels.length, 1);
  assert.equal(f.tunnels[0].options.sshPort, 2222);
  assert.deepEqual(f.states, ['choosing', 'checking', 'connecting', 'probing', 'connected']);
});

test('commands during reconnect retain token and wait for the same recovery', async t => {
  const f = fixture(); t.after(() => f.session.dispose());
  const original = await f.session.connect();
  let disconnects = 0; f.session.on('disconnected', () => disconnects++);
  f.tunnels[0].emit('closed', 'offline');
  const pending = f.session.connect();
  await flush();
  assert.equal(f.session.state, 'reconnecting');
  assert.equal(f.session.connect(), pending);
  await f.clock.advance(1000);
  assert.equal(await pending, original);
  assert.equal(f.proxies.length, 1);
  assert.equal(f.proxies[0].closed, undefined);
  assert.equal(f.tunnels[1].token, original.proxy.token);
  assert.equal(disconnects, 0);
});

test('three failed retries use bounded backoff and release all resources', async () => {
  const f = fixture({ start: async tunnel => { if (tunnel !== f.tunnels[0]) throw new Error('offline'); } });
  await f.session.connect();
  f.tunnels[0].emit('closed', 'offline');
  await flush();
  await f.clock.advance(999); assert.equal(f.tunnels.length, 1);
  await f.clock.advance(1); assert.equal(f.tunnels.length, 2);
  await f.clock.advance(1999); assert.equal(f.tunnels.length, 2);
  await f.clock.advance(1); assert.equal(f.tunnels.length, 3);
  await f.clock.advance(4000); assert.equal(f.tunnels.length, 4);
  assert.equal(f.session.state, 'failed');
  assert.equal(f.session.current, undefined);
  assert.ok(f.proxies[0].closed && f.auths[0].closed);
  assert.equal(f.failures[0].stage, 'reconnect');
  assert.equal(f.clock.timers.size, 0);
});

test('stable connection resets retry count and clears its timer on disconnect', async () => {
  const f = fixture();
  const s = await f.session.connect();
  f.tunnels[0].emit('closed', 'offline'); await flush();
  await f.clock.advance(1000);
  assert.equal(s.attempts, 1);
  await f.clock.advance(60000);
  assert.equal(s.attempts, 0);
  f.session.disconnect();
  assert.equal(f.clock.timers.size, 0);
});

test('manual disconnect cancels backoff without resurrecting a tunnel', async () => {
  const f = fixture();
  await f.session.connect();
  f.tunnels[0].emit('closed', 'offline'); await flush();
  f.session.disconnect();
  await f.clock.advance(10000);
  assert.equal(f.tunnels.length, 1);
  assert.equal(f.session.state, 'disconnected');
  assert.equal(f.failures.length, 0);
});

test('autoReconnect false revokes resources and reports the dropped connection', async () => {
  const f = fixture(); f.config.autoReconnect = false;
  await f.session.connect();
  f.tunnels[0].emit('closed', 'offline');
  assert.equal(f.session.state, 'disconnected');
  assert.equal(f.proxies[0].closed, true);
  assert.equal(f.failures[0].stage, 'closed');
});

test('disconnect while choosing can immediately start a fresh operation', async t => {
  let release;
  let calls = 0;
  const first = new Promise(resolve => { release = resolve; });
  const f = fixture({ resolveTarget: () => ++calls === 1 ? first : Promise.resolve({ host: 'new-host' }) });
  t.after(() => f.session.dispose());
  const old = f.session.connect(); await flush();
  f.session.disconnect();
  const fresh = f.session.connect();
  release({ host: 'stale-host' });
  assert.equal(await old, undefined);
  assert.equal((await fresh).config.host, 'new-host');
  assert.equal(f.tunnels.length, 1);
});

test('late acquired resource is closed after cancellation', async () => {
  let release;
  const proxy = { port: 12345, token: 'token', close() { this.closed = true; } };
  const f = fixture({ startProxy: () => new Promise(resolve => { release = resolve; }) });
  const pending = f.session.connect(); await flush();
  f.session.disconnect(); release(proxy);
  assert.equal(await pending, undefined);
  assert.equal(proxy.closed, true);
  assert.equal(f.auths.length, 0);
});

test('a tunnel closing during probe cannot be marked connected', async () => {
  const f = fixture({ probe: async tunnel => tunnel.emit('closed', 'closed during probe') });
  await assert.rejects(f.session.connect(), /closed during verification/);
  assert.equal(f.session.state, 'failed');
  assert.equal(f.proxies[0].closed, true);
  assert.ok(!f.states.includes('connected'));
});

test('cancelled host selection is quiet and leaves no resources', async () => {
  const f = fixture({ resolveTarget: async () => undefined });
  assert.equal(await f.session.connect(), undefined);
  assert.equal(f.session.state, 'disconnected');
  assert.equal(f.proxies.length, 0);
});

test('authentication setup failure closes the already-created proxy', async () => {
  const f = fixture({ startAuth: async () => { throw new Error('auth setup failed'); } });
  await assert.rejects(f.session.connect(), error => error.bridgeStage === 'auth');
  assert.equal(f.proxies[0].closed, true);
  assert.equal(f.tunnels.length, 0);
});

test('cleanup continues when one resource throws', async () => {
  const f = fixture();
  await f.session.connect();
  f.tunnels[0].stop = () => { throw new Error('already gone'); };
  f.session.disconnect();
  assert.equal(f.proxies[0].closed, true);
  assert.equal(f.auths[0].closed, true);
});

test('disconnect restores the sidebar before stopping SSH and serializes a fresh connection', async t => {
  const f = fixture(); t.after(() => f.session.dispose());
  const original = await f.session.connect();
  let finish;
  original.codexIde = {
    close() { this.closed = true; },
    async restore(tunnel) {
      assert.equal(tunnel, f.tunnels[0]);
      assert.equal(tunnel.stopped, undefined);
      await new Promise(resolve => { finish = resolve; });
    }
  };
  const closing = f.session.disconnect();
  assert.equal(f.session.disconnect(), closing);
  assert.equal(f.session.state, 'disconnecting');
  const fresh = f.session.connect(); await flush();
  assert.equal(f.tunnels.length, 1); assert.equal(f.proxies[0].closed, undefined);
  finish(); await closing;
  assert.equal(f.tunnels[0].stopped, true); assert.equal(f.proxies[0].closed, true);
  assert.notEqual(await fresh, original); assert.equal(f.tunnels.length, 2);
});

test('failed automatic restoration still revokes resources and reports recovery failure', async () => {
  const f = fixture(); const original = await f.session.connect();
  const failures = [];
  f.session.on('restoreFailure', error => failures.push(error));
  original.codexIde = { close() {}, async restore() { throw new Error('config conflict'); } };
  await f.session.disconnect();
  assert.equal(f.session.state, 'disconnected'); assert.equal(f.session.current, undefined);
  assert.equal(f.tunnels[0].stopped, true); assert.equal(f.proxies[0].closed, true);
  assert.equal(failures[0].message, 'config conflict');
});

test('disposing waits for sidebar restoration and never starts a replacement connection', async () => {
  const f = fixture(); const original = await f.session.connect();
  let finish;
  original.codexIde = { close() {}, restore: () => new Promise(resolve => { finish = resolve; }) };
  const disposed = f.session.dispose(); await flush();
  assert.equal(f.tunnels[0].stopped, undefined); assert.equal(await f.session.connect(), undefined);
  finish(); await disposed;
  assert.equal(f.tunnels[0].stopped, true); assert.equal(f.session.listenerCount('state'), 0);
});

test('invalid settings at connection loss report a failure instead of throwing from an event', async () => {
  const f = fixture();
  await f.session.connect();
  f.session.deps.readConfig = () => { throw new Error('invalid setting'); };
  assert.doesNotThrow(() => f.tunnels[0].emit('closed', 'offline'));
  assert.equal(f.failures[0].stage, 'configuration');
  assert.equal(f.proxies[0].closed, true);
});

test('cancellation promptly ends callers waiting for non-cancellable setup and still cleans late resources', async () => {
  for (const name of ['getGatewayKey', 'startProxy', 'startAuth']) {
    let release;
    const wait = new Promise(resolve => { release = resolve; });
    const resource = { port: 12345, token: 'token', close() { this.closed = true; } };
    const f = fixture({ [name]: () => wait });
    let settled = false;
    const work = f.session.connect().then(result => { settled = true; assert.equal(result, undefined); });
    await flush();
    f.session.disconnect();
    await flush();
    assert.equal(settled, true, name);
    release(name === 'getGatewayKey' ? 'late-key' : resource);
    await work; await flush();
    if (name !== 'getGatewayKey') assert.equal(resource.closed, true);
  }
});

test('disconnect from the initial connected event cannot return a stopped session', async () => {
  const f = fixture();
  f.session.on('state', event => { if (event.state === 'connected') f.session.disconnect(); });
  assert.equal(await f.session.connect(), undefined);
  assert.equal(f.clock.timers.size, 0);
});

test('disconnect from the reconnect success event cannot schedule a late stable timer', async () => {
  const f = fixture();
  await f.session.connect();
  f.session.on('state', event => { if (event.state === 'connected') f.session.disconnect(); });
  f.tunnels[0].emit('closed', 'offline'); await flush();
  const pending = f.session.connect();
  await f.clock.advance(1000);
  assert.equal(await pending, undefined);
  assert.equal(f.clock.timers.size, 0);
  assert.equal(f.session.current, undefined);
});

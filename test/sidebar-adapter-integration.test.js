'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs/promises');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const { Tunnel } = require('../src/tunnel');
const { CodexSidebarBridge } = require('../src/codex-sidebar');
const available = process.platform !== 'win32' && ['x64', 'arm64'].includes(process.arch) && spawnSync('python3', ['-I', '-c', 'import fcntl']).status === 0;

function fakeProcess() {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.exitCode = null; child.signalCode = null;
  child.kill = () => { child.killed = true; child.signalCode = 'SIGTERM'; queueMicrotask(() => child.emit('close', null)); return true; };
  return child;
}
const request = socketPath => new Promise((resolve, reject) => {
  const req = http.get({ socketPath, path: '/token' }, res => {
    let body = ''; res.on('data', data => { body += data; }); res.on('end', () => resolve({ status: res.statusCode, body }));
  }); req.on('error', reject);
});

test('real Python adapter, SSH protocol and broker interoperate through enable, rebind and restore', { skip: !available }, async t => {
  const home = await fs.mkdtemp('/tmp/mpb-sidebar-e2e-');
  const codexHome = path.join(home, '.codex');
  const extension = path.join(home, '.vscode-server/extensions/openai.chatgpt-fixture');
  const binary = path.join(extension, `bin/linux-${process.arch === 'arm64' ? 'aarch64' : 'x64'}/codex`);
  await fs.mkdir(path.dirname(binary), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(home, 'temporary'), { mode: 0o700 });
  await fs.mkdir(codexHome, { mode: 0o700 });
  await fs.copyFile(path.join(__dirname, 'helpers/codex-rpc-fixture.py'), binary); await fs.chmod(binary, 0o700);
  await fs.writeFile(path.join(extension, 'package.json'), JSON.stringify({ publisher: 'openai', name: 'chatgpt' }));
  await fs.writeFile(path.join(codexHome, 'config.toml'), JSON.stringify({ model: 'original-model', model_provider: 'original-provider', unrelated: 'preserve' }), { mode: 0o600 });
  const servers = []; const peers = new Set(); const children = [];
  const spawnLocal = (_, args) => {
    if (args.at(-1) === 'python3 -I -') {
      const child = spawn('python3', ['-I', '-'], { env: { ...process.env, HOME: home, CODEX_HOME: codexHome, TMPDIR: path.join(home, 'temporary') }, stdio: ['pipe', 'pipe', 'pipe'] });
      children.push(child); return child;
    }
    const child = fakeProcess();
    const marker = args.at(-1).match(/MAGPIE_(?:BRIDGE|CREDENTIAL)_READY_[a-f0-9]+/)[0];
    if (args.at(-1).includes('CREDENTIAL_READY')) {
      const [remote, local] = args[args.indexOf('-R') + 1].split(':');
      const server = net.createServer(peer => {
        const upstream = net.createConnection(local); peers.add(peer); peers.add(upstream);
        peer.on('error', () => upstream.destroy()); upstream.on('error', () => peer.destroy());
        peer.once('close', () => { peers.delete(peer); upstream.destroy(); });
        upstream.once('close', () => { peers.delete(upstream); peer.destroy(); });
        peer.pipe(upstream).pipe(peer);
      });
      servers.push(server); server.on('error', error => child.emit('error', error));
      server.listen(remote, () => child.stdout.write(marker + '\n'));
      child.once('close', () => server.close());
    } else queueMicrotask(() => child.stdout.write(marker + '\n'));
    return child;
  };
  const tunnel = new Tunnel({ host: 'fixture-only', localPort: 49123, remotePort: 13425 }, spawnLocal);
  const session = { controller: new AbortController(), ready: true, tunnel, config: { remotePort: 13425 }, proxy: { token: 'synthetic-integration-capability' } };
  const sidebar = new CodexSidebarBridge(session);
  t.after(async () => {
    await sidebar.close(); tunnel.stop();
    for (const peer of peers) peer.destroy();
    for (const server of servers) server.close();
    for (const child of children) if (child.exitCode == null && child.signalCode == null) child.kill();
    await fs.rm(home, { recursive: true, force: true });
  });
  await tunnel.start();
  assert.deepEqual(await sidebar.enable(tunnel, 'fixture/model'), { version: '0.164.0-alpha.11.1' });
  assert.deepEqual(await request(sidebar.socketPath), { status: 200, body: session.proxy.token + '\n' });
  let config = JSON.parse(await fs.readFile(path.join(codexHome, 'config.toml')));
  assert.equal(config.model_provider, 'magpie_vscode_bridge');
  assert.ok(!JSON.stringify(config).includes(session.proxy.token));
  assert.ok(!(await fs.readFile(path.join(codexHome, '.magpie-remote-bridge.json'), 'utf8')).includes(session.proxy.token));
  // Simulate connection loss by releasing the old forwarding listener. Rebind
  // must pass its exact socketPath into the actual Python adapter.
  await sidebar.forwarding.stop(); await new Promise(resolve => setImmediate(resolve));
  await sidebar.reconnect(tunnel);
  assert.deepEqual(await request(sidebar.socketPath), { status: 200, body: session.proxy.token + '\n' });
  const result = await sidebar.restore(tunnel);
  assert.equal(result.ok, true); assert.equal(result.restored.length, 3);
  config = JSON.parse(await fs.readFile(path.join(codexHome, 'config.toml')));
  assert.equal(config.model, 'original-model'); assert.equal(config.model_provider, 'original-provider'); assert.equal(config.unrelated, 'preserve');
  await assert.rejects(fs.stat(path.join(codexHome, '.magpie-remote-bridge.json')), { code: 'ENOENT' });
});

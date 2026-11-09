'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, flush } = require('./helpers/vscode');

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('sidebar command opens the official UI, shares setup, and revokes on disconnect', async t => {
  const f = fixture(); t.after(f.dispose);
  await Promise.all([f.run('codexSidebar'), f.run('codexSidebar')]);
  assert.equal(f.sidebars.length, 1); assert.equal(f.sidebars[0].model, 'vendor/model');
  assert.equal(f.terminals.length, 0); assert.equal(f.tunnels[0].checked, undefined);
  assert.ok(f.executions.some(args => args[0] === 'chatgpt.openSidebar'));
  assert.ok(f.infos.some(text => text.includes('remote account')));
  await f.run('disconnect'); assert.equal(f.sidebars[0].closed, true); assert.equal(f.proxies[0].closed, true);
  assert.deepEqual(f.tunnels[0].codexCalls, [{ operation: 'restore', owner: f.sidebars[0].owner }]);
});

test('automatic restore failure warns while completing disconnect', async t => {
  const f = fixture({ codex: async () => { throw new Error('restore unavailable'); } }); t.after(f.dispose);
  await f.run('codexSidebar'); await f.run('disconnect');
  assert.equal(f.tunnels[0].stopped, true); assert.equal(f.proxies[0].closed, true);
  assert.ok(f.warnings.some(text => text.includes('automatic Codex restoration')));
  assert.deepEqual(f.errors, []);
});

test('sidebar accepts null, missing, empty and whitespace Codex CLI defaults', async t => {
  for (const cliExecutable of [null, undefined, '', '   ']) {
    const f = fixture({ values: { cliExecutable } }); t.after(f.dispose);
    assert.equal(f.vscode.workspace.getConfiguration('chatgpt').get('cliExecutable', ''), cliExecutable === undefined ? '' : cliExecutable);
    await f.run('codexSidebar');
    assert.deepEqual(f.errors, [], `cliExecutable=${String(cliExecutable)}`);
    assert.equal(f.sidebars.length, 1);
    assert.ok(f.executions.some(args => args[0] === 'chatgpt.openSidebar'));
  }
});

test('sidebar refuses custom Codex executables and unsupported workspaces before setup', async t => {
  for (const options of [{ values: { cliExecutable: '/custom/codex' } }, { remoteName: undefined }, { trusted: false }]) {
    const f = fixture(options); t.after(f.dispose);
    await f.run('codexSidebar');
    assert.equal(f.tunnels.length, 0); assert.equal(f.sidebars.length, 0); assert.equal(f.errors.length, 1);
  }
});

test('sidebar cancellation during preparation never opens a chat or disconnects the API bridge', async t => {
  const hold = deferred(); const f = fixture({ sidebarEnable: () => hold.promise }); t.after(f.dispose);
  const pending = f.run('codexSidebar'); await flush();
  f.notifications.at(-1).cancel(); hold.resolve(); await pending;
  assert.equal(f.sidebars[0].closed, true); assert.equal(f.tunnels[0].stopped, undefined);
  assert.ok(!f.executions.some(args => args[0] === 'chatgpt.openSidebar')); assert.equal(f.errors.length, 0);
});

test('sidebar lease failure offers explicit recovery without replacing the API session', async t => {
  const error = new Error('sidebar lease busy'); error.code = 'LEASE_EXISTS';
  const f = fixture({ sidebarEnable: async () => { throw error; }, errorAction: actions => actions.find(action => action === 'Restore Codex Configuration') });
  t.after(f.dispose); await f.run('codexSidebar');
  assert.equal(f.tunnels.length, 1); assert.equal(f.tunnels[0].stopped, undefined);
  assert.deepEqual(f.tunnels[0].codexCalls, [{ operation: 'restore' }]);
  assert.ok(f.logs.some(text => text.includes('LEASE_EXISTS')));
  assert.ok(f.infos.some(text => text.includes('configuration restored')));
});

test('explicit restoration closes the private channel first and preserves user edits', async t => {
  const f = fixture({ codex: async () => {
    assert.equal(f.sidebars[0].closed, true); return { ok: true, preserved: ['model'] };
  } });
  t.after(f.dispose); await f.run('codexSidebar'); await f.run('restoreCodex');
  assert.deepEqual(f.tunnels[0].codexCalls, [{ operation: 'restore' }]);
  assert.ok(f.infos.some(text => text.includes('Preserved 1 fields')));
  assert.equal(f.tunnels[0].stopped, undefined); assert.equal(f.proxies[0].closed, undefined);
  await f.run('disconnect'); assert.equal(f.tunnels[0].codexCalls.length, 1);
});

test('sidebar reconnect failure closes its credentials while leaving the CLI bridge usable', async t => {
  const { Clock } = require('./helpers/clock'); const clock = new Clock();
  const f = fixture({ values: { autoReconnect: true }, clock, sidebarReconnect: async () => { throw new Error('socket forwarding denied'); } });
  t.after(f.dispose); await f.run('codexSidebar');
  f.tunnels[0].emit('closed', 'network interruption'); await flush(); await clock.advance(1000); await flush();
  assert.equal(f.sidebars[0].closed, true); assert.equal(f.tunnels.length, 2);
  assert.match(f.status.text, /Connected/); assert.equal(f.proxies[0].closed, undefined);
  assert.ok(f.warnings.some(text => text.includes('credential channel')));
  await f.run('codex'); assert.equal(f.terminals.length, 1);
});

test('Chinese sidebar commands include account scope and recovery guidance', async t => {
  const f = fixture({ language: 'zh-cn' }); t.after(f.dispose);
  await f.run('codexSidebar'); await f.run('restoreCodex');
  assert.ok(f.infos.some(text => text.includes('当前远端账户')));
  assert.ok(f.infos.some(text => text.includes('原配置已恢复')));
});

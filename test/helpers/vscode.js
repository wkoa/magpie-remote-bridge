'use strict';

const { EventEmitter } = require('node:events');
const { activate } = require('../../src/extension');
const zh = require('../../l10n/bundle.l10n.zh-cn.json');

const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

function fixture(options = {}) {
  const commands = new Map(), terminals = [], tunnels = [], proxies = [], sidebars = [], logs = [], errors = [], infos = [], warnings = [];
  const picks = [], inputs = [], notifications = [], progressMessages = [], clipboard = [], executions = [], external = [], listeners = {};
  const status = { show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} };
  const values = {
    sshHost: 'my-server', gatewayPort: 3425, remotePort: 13425, sshPath: 'ssh', sshConfigFile: '',
    model: 'vendor/model', autoConnect: false, autoReconnect: false, ...options.values
  };
  const state = { hosts: options.hosts || {}, ...options.state };
  const secrets = { ...options.secrets };
  const disposable = { dispose() {} };
  const context = {
    subscriptions: [],
    globalState: { get: (key, fallback) => state[key] === undefined ? fallback : state[key], update: async (key, value) => { state[key] = value; } },
    secrets: { get: async key => secrets[key], store: async (key, value) => { secrets[key] = value; }, delete: async key => { delete secrets[key]; } }
  };
  const vscode = {
    l10n: { t: (message, ...args) => (options.language === 'zh-cn' ? zh[message] || message : message).replace(/\{(\d+)\}/g, (_, i) => String(args[i])) },
    ThemeColor: class { constructor(id) { this.id = id; } },
    StatusBarAlignment: { Left: 1 }, ProgressLocation: { Notification: 15 }, ConfigurationTarget: { Global: 1 },
    CancellationTokenSource: class {
      constructor() { const emitter = new EventEmitter(); this.token = { isCancellationRequested: false, onCancellationRequested: fn => { emitter.on('cancel', fn); return { dispose: () => emitter.off('cancel', fn) }; } }; this.emitter = emitter; }
      cancel() { this.token.isCancellationRequested = true; this.emitter.emit('cancel'); }
      dispose() { this.emitter.removeAllListeners(); }
    },
    Uri: { parse: value => value },
    env: { openExternal: async uri => { external.push(uri); return true; }, remoteName: Object.hasOwn(options, 'remoteName') ? options.remoteName : 'ssh-remote', clipboard: { writeText: async text => clipboard.push(text) } },
    workspace: {
      isTrusted: options.trusted ?? true,
      workspaceFolders: [{ uri: { scheme: 'vscode-remote', authority: options.authority || 'ssh-remote+my-server', path: '/remote/project' } }],
      getConfiguration: () => ({ get: (key, fallback) => values[key] === undefined ? fallback : values[key], update: async (key, value) => { values[key] = value; } }),
      onDidChangeConfiguration: fn => { listeners.configuration = fn; return disposable; },
      onDidChangeWorkspaceFolders: fn => { listeners.folders = fn; return disposable; }
    },
    commands: {
      registerCommand(name, fn) { commands.set(name, fn); return disposable; },
      executeCommand: async (...args) => executions.push(args)
    },
    extensions: { getExtension: () => options.legacy ? {} : undefined },
    window: {
      createOutputChannel: () => ({ info: text => logs.push(text), warn: text => logs.push(text), error: text => logs.push(text), show() {}, dispose() {} }),
      createStatusBarItem: () => status,
      withProgress: async (_, fn) => {
        const source = new vscode.CancellationTokenSource();
        notifications.push(source);
        return fn({ report: item => progressMessages.push(item.message) }, source.token);
      },
      showQuickPick: async choices => { picks.push(choices); return options.select ? options.select(choices) : choices[0]; },
      showInputBox: async (input, token) => { inputs.push({ input, token }); return options.input ? options.input(input, token) : undefined; },
      showErrorMessage: async (message, ...actions) => { errors.push(message); return options.errorAction?.(actions); },
      showWarningMessage: async (message, ...actions) => { warnings.push(message); return options.warningAction?.(actions); },
      showInformationMessage: async (message, ...actions) => { infos.push(message); return options.infoAction?.(actions); },
      onDidCloseTerminal: fn => { listeners.closeTerminal = fn; return disposable; },
      createTerminal: opts => {
        const terminal = { options: opts, show() {}, sendText(command) { this.command = command; }, dispose() { this.disposed = true; } };
        terminals.push(terminal); return terminal;
      }
    }
  };
  class FakeTunnel extends EventEmitter {
    constructor(opts) { super(); this.options = opts; tunnels.push(this); }
    async start(opts) { if (options.start) await options.start(this, opts); }
    async probe(token) { this.probed = token; if (options.probe) await options.probe(this); }
    async checkCli(agent, opts) {
      this.checked = agent;
      return options.checkCli ? options.checkCli(this, agent, opts) : `/usr/bin/${agent}`;
    }
    async codex(request, opts) {
      (this.codexCalls ||= []).push(request);
      return options.codex ? options.codex(request, opts) : { ok: true, preserved: [] };
    }
    stop() { this.stopped = true; }
  }
  class FakeSidebar {
    constructor(session, opts) { this.session = session; this.options = opts; this.owner = 'a'.repeat(32); this.version = 'fixture-codex'; sidebars.push(this); }
    async enable(tunnel, model) {
      this.model = model;
      if (options.sidebarEnable) await options.sidebarEnable(this, tunnel, model);
      this.applied = true;
    }
    async reconnect(tunnel) { if (options.sidebarReconnect) await options.sidebarReconnect(this, tunnel); }
    async close() { this.closed = true; }
    async restore(tunnel) {
      await this.close();
      if (this.applied) {
        await tunnel.codex({ operation: 'restore', owner: this.owner });
        this.applied = false;
      }
    }
  }
  activate(context, {
    vscode, readFile: options.readFile || (async () => options.sshConfig || ''),
    getModels: options.getModels || (async () => ['vendor/model']),
    startProxy: async () => {
      const proxy = { token: 'session-token', port: 49123, close() { this.closed = true; } };
      proxies.push(proxy); return proxy;
    },
    startAuth: options.startAuth || (async () => ({ close() {} })),
    createTunnel: opts => new FakeTunnel(opts), localClaudeModels: async () => ({}),
    createCodexSidebar: (session, opts) => new FakeSidebar(session, opts),
    clock: options.clock, reconnect: options.reconnect
  });
  return {
    run: name => commands.get(`magpieBridge.${name}`)(), commands, terminals, tunnels, proxies, sidebars, errors, logs,
    context, state, picks, inputs, infos, warnings, values, status, secrets, clipboard, notifications, executions, external,
    listeners, vscode, progressMessages, dispose: async () => { for (const item of context.subscriptions) await item.dispose(); }
  };
}

module.exports = { fixture, flush };

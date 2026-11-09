'use strict';

const { BridgeSession, isCancelled } = require('./session');
const { startProxy, getModels } = require('./proxy');
const { Tunnel } = require('./tunnel');
const { startAuth } = require('./auth');
const { localClaudeModels, terminalEnv, codexCommand, cliCommand } = require('./agents');
const { readConfig, getGatewayKey, CONNECTION_KEYS } = require('./config');
const { createHostPicker } = require('./host-picker');
const { createLogger } = require('./log');
const { withCancellation } = require('./ui');
const { abortable } = require('./cancellation');
const { CodexSidebarBridge } = require('./codex-sidebar');

const INSTALL_URLS = Object.freeze({
  codex: 'https://github.com/openai/codex',
  claude: 'https://code.claude.com/docs/en/setup'
});

let shutdown;

/** Wires the VS Code UI to the independently testable bridge lifecycle. */
function activate(context, dependencies = {}) {
  const vscode = dependencies.vscode || require('vscode');
  const t = (...args) => vscode.l10n.t(...args);
  const channel = vscode.window.createOutputChannel('Magpie Remote Bridge', { log: true });
  const log = createLogger(channel);
  const status = vscode.window.createStatusBarItem('magpieBridge.status', vscode.StatusBarAlignment.Left, 25);
  status.name = 'Magpie Remote Bridge';
  status.command = 'magpieBridge.menu';
  const terminals = new Set();
  const cfg = () => readConfig(vscode.workspace);
  const key = () => getGatewayKey(context.secrets);
  const hosts = createHostPicker({ vscode, context, log, t, readFile: dependencies.readFile });
  let progressOperation;
  let disposed = false;
  let latestState = { state: 'disconnected' };
  const shownErrors = new WeakSet();

  const bridge = new BridgeSession({
    readConfig: () => ({ ...cfg(), authority: hosts.authority() }),
    resolveTarget: hosts.resolveTarget,
    getGatewayKey: key,
    getModels: dependencies.getModels || getModels,
    startProxy: dependencies.startProxy || startProxy,
    startAuth: dependencies.startAuth || startAuth,
    createTunnel: dependencies.createTunnel || (options => new Tunnel(options)),
    promptPassword: async (challenge, config, signal) => {
      const password = await withCancellation(vscode, signal, token => vscode.window.showInputBox({
      password: true, ignoreFocusOut: true, title: t('Magpie SSH · {0}', config.host),
      prompt: challenge, placeHolder: t('Used only for this SSH authentication; never saved')
    }, token));
      if (password === undefined && bridge.current?.controller.signal === signal) bridge.disconnect();
      return password;
    },
    log,
    clock: dependencies.clock,
    reconnect: dependencies.reconnect
  });
  const dispose = () => { disposed = true; return bridge.dispose(); };
  shutdown = dispose;

  function stateLabel(event) {
    switch (event.state) {
      case 'choosing': return t('Choose SSH host');
      case 'checking': return t('Checking gateway');
      case 'connecting': return t('Connecting SSH');
      case 'probing': return t('Verifying remote access');
      case 'connected': return t('Connected');
      case 'reconnecting': return t('Reconnecting {0}/{1}', event.attempt, event.maxAttempts);
      case 'disconnecting': return t('Restoring Codex configuration');
      case 'failed': return t('Connection failed');
      default: return t('Disconnected');
    }
  }

  function render(event = latestState) {
    latestState = event;
    const supported = vscode.env.remoteName === 'ssh-remote' && Boolean(vscode.workspace.workspaceFolders?.length);
    if (supported) status.show(); else status.hide();
    const busy = ['choosing', 'checking', 'connecting', 'probing', 'reconnecting', 'disconnecting'].includes(event.state);
    status.text = `${busy ? '$(sync~spin)' : '$(plug)'} Magpie: ${stateLabel(event)}`;
    status.tooltip = event.session?.config?.host
      ? t('SSH: {0}\nRemote API: http://127.0.0.1:{1}\nClick for bridge actions', event.session.config.host, event.session.config.remotePort)
      : t('Use your local Magpie gateway in this Remote-SSH workspace. Click for actions.');
    status.backgroundColor = event.state === 'failed' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    void vscode.commands.executeCommand('setContext', 'magpieBridge.connected', event.state === 'connected');
    void vscode.commands.executeCommand('setContext', 'magpieBridge.busy', busy);
  }
  bridge.on('state', render);
  bridge.on('disconnected', () => {
    for (const terminal of terminals) terminal.dispose();
    terminals.clear();
  });
  bridge.on('restoreFailure', () => {
    if (!disposed) void vscode.window.showWarningMessage(t('Could not confirm automatic Codex restoration. Remote recovery will retry after disconnect. If needed, run Restore Codex Configuration when the server is reachable.'));
  });

  async function connect() {
    const work = bridge.connect();
    if (progressOperation?.work === work) return progressOperation.ui;
    if (bridge.current?.ready) return work;
    const current = bridge.current;
    const operation = { work };
    progressOperation = operation;
    operation.ui = vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification, title: t('Magpie Remote Bridge'), cancellable: true
    }, async (progress, token) => {
      const update = event => progress.report({ message: stateLabel(event) });
      bridge.on('state', update);
      update(latestState);
      const cancellation = token.onCancellationRequested(() => {
        if (bridge.current === current) bridge.disconnect();
      });
      if (token.isCancellationRequested && bridge.current === current) bridge.disconnect();
      try { return await work; } finally {
        cancellation.dispose();
        bridge.off('state', update);
      }
    }).finally(() => {
      if (progressOperation === operation) progressOperation = undefined;
    });
    return operation.ui;
  }

  function hint(error, stage) {
    if (error.code === 'ENOENT') return t('OpenSSH could not be started. Check the SSH executable setting.');
    if (/remote port forwarding failed|cannot listen to port/i.test(error.message)) {
      return t('The remote port is unavailable. Choose another remote port or check SSH forwarding permissions.');
    }
    if (stage === 'codexSidebar') {
      if (error.code === 'UNSUPPORTED_CLIENT') return t('Codex sidebar bridging currently requires a macOS or Linux client. The Codex CLI launcher remains available.');
      if (error.code === 'PROVIDER_EXISTS') return t('The reserved magpie_vscode_bridge provider already exists outside the current bridge. Rename or remove that conflicting provider in your remote Codex config before enabling.');
      if (/LEASE|ACTIVE|BUSY|RECOVERY/.test(error.code || '')) return t('This remote account already has a Codex sidebar bridge or a recovery record. Restore its configuration before enabling another window.');
      if (/UNSUPPORTED|COMPAT|AUTH/.test(error.code || '')) return t('The remote Codex extension does not support command-based provider authentication. Update the official Codex extension on the SSH host.');
      if (error.code === 'CUSTOM_CODEX_CLI') return t('Codex uses a custom CLI executable. Clear that override before enabling sidebar bridging.');
      return t('Codex sidebar setup failed. Check the remote official Codex extension, Python 3, curl, and configuration permissions. Show Logs for the error code; Restore Codex Configuration can recover an interrupted setup.');
    }
    if (stage === 'configuration') return t('Bridge settings are invalid. Check the port numbers and local SSH paths.');
    if (error.code === 'INVALID_KEY') return t('The key must not contain control characters.');
    if (stage === 'gateway' || stage === 'proxy') return t('The local Magpie gateway is unavailable. Start Magpie and check its port and gateway key.');
    if (stage === 'host' || !vscode.workspace.isTrusted || vscode.env.remoteName !== 'ssh-remote') {
      return t('Open a trusted Remote-SSH folder and choose the matching SSH server and user.');
    }
    if (stage === 'probe') return t('Remote HTTP verification failed. Check that curl is installed and the SSH target matches this workspace.');
    if (stage === 'reconnect') return t('Automatic reconnect failed. Check your network and SSH connection, then connect again.');
    return t('The bridge operation failed. Check the SSH settings and connection log for details.');
  }

  async function showFailure(error, stage = error.bridgeStage, retryCommand = 'connect') {
    if (disposed || isCancelled(error)) return;
    if (shownErrors.has(error)) return;
    shownErrors.add(error);
    log.error(error);
    if (stage === 'codexSidebar' && error.code) log.warn(`Codex sidebar error: ${error.code}`);
    const retry = t('Retry');
    const settings = t('Open Settings');
    const change = t('Change SSH Host');
    const logs = t('Show Logs');
    const restore = t('Restore Codex Configuration');
    let selected;
    try { selected = await vscode.window.showErrorMessage(hint(error, stage), retry, ...(stage === 'codexSidebar' ? [restore] : [settings, change]), logs); }
    finally { shownErrors.delete(error); }
    if (disposed) return;
    if (selected === retry) await run(retryCommand);
    if (selected === settings) await run('settings');
    if (selected === change) await run('changeHost');
    if (selected === logs) log.show();
    if (selected === restore && retryCommand !== 'restoreCodex') await run('restoreCodex');
  }
  bridge.on('failure', (error, stage) => { void showFailure(error, stage); });

  async function chooseModel(requireModel = false) {
    const config = cfg();
    const gatewayKey = await key();
    if (gatewayKey !== 'magpie') log.protect(gatewayKey);
    let models;
    try { models = await (dependencies.getModels || getModels)(config.gatewayPort, gatewayKey); }
    catch (error) { error.bridgeStage = 'gateway'; throw error; }
    const items = models.map(model => ({ label: model, description: model === config.model ? t('Current selection') : undefined, model }));
    if (!requireModel) items.unshift({ label: t('Use local Magpie model defaults'), description: t('Clear the override for new sessions'), model: '' });
    const selected = await vscode.window.showQuickPick(items, {
      title: t('Choose a model for new agent sessions'), matchOnDescription: true,
      placeHolder: models.length ? t('Existing sessions keep their model') : t('No models found. Check the Magpie model configuration.')
    });
    if (!selected) return false;
    await vscode.workspace.getConfiguration('magpieBridge').update('model', selected.model, vscode.ConfigurationTarget.Global);
    return true;
  }

  async function checkCli(session, tunnel, agent) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    session.controller.signal.addEventListener('abort', abort, { once: true });
    if (session.controller.signal.aborted) abort();
    try {
      return await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: t('Checking remote {0} installation', agent), cancellable: true
      }, async (_, token) => {
        const cancellation = token.onCancellationRequested(abort);
        if (token.isCancellationRequested) abort();
        try { return await abortable(tunnel.checkCli(agent, { signal: controller.signal }), controller.signal); }
        finally { cancellation.dispose(); }
      });
    } finally { session.controller.signal.removeEventListener('abort', abort); }
  }

  async function cliNotice(session, tunnel, agent, failed) {
    const terminal = t('Open Remote Terminal');
    const docs = t('Official Installation Guide');
    const retry = t('Retry');
    const logs = t('Show Logs');
    const message = failed
      ? t('Could not check {0} on the remote machine. Check the SSH connection and shell startup, then retry. The gateway remains connected.', agent)
      : t('{0} is not installed or could not be found on the remote machine. Install it on the remote machine, then retry. The gateway remains connected.', agent);
    const selected = await vscode.window.showWarningMessage(message, terminal, docs, retry, ...(failed ? [logs] : []));
    if (!activeSession(session, tunnel)) return;
    if (selected === terminal) await createTerminal(session, tunnel);
    if (selected === docs) await vscode.env.openExternal(vscode.Uri.parse(INSTALL_URLS[agent]));
    if (selected === retry) await openTerminal(agent);
    if (selected === logs) log.show();
  }

  function activeSession(session, tunnel) {
    return !disposed && bridge.current === session && session.ready && session.tunnel === tunnel;
  }

  async function createTerminal(session, tunnel, agent, executable) {
    const config = { ...session.config, model: cfg().model, token: session.proxy.token };
    const models = await (dependencies.localClaudeModels || localClaudeModels)(config.gatewayPort);
    if (!activeSession(session, tunnel)) return;
    const terminal = vscode.window.createTerminal({
      name: agent ? `Magpie · ${agent === 'claude' ? 'Claude Code' : 'Codex CLI'}` : t('Magpie · Remote Terminal'),
      env: terminalEnv(config, models), cwd: vscode.workspace.workspaceFolders[0].uri,
      isTransient: true
    });
    terminals.add(terminal);
    terminal.show();
    if (agent === 'claude') terminal.sendText(cliCommand(executable), true);
    if (agent === 'codex') terminal.sendText(codexCommand(config, executable), true);
  }

  async function openTerminal(agent) {
    hosts.authority();
    const session = await connect();
    if (!session?.ready || bridge.current !== session) return;
    const tunnel = session.tunnel;
    let executable;
    if (agent) {
      try { executable = await checkCli(session, tunnel, agent); }
      catch (error) {
        if (isCancelled(error) || !activeSession(session, tunnel)) return;
        log.error(error);
        await cliNotice(session, tunnel, agent, true);
        return;
      }
      if (!activeSession(session, tunnel)) return;
      if (!executable) { await cliNotice(session, tunnel, agent, false); return; }
    }
    if (agent === 'codex' && !cfg().model && !(await chooseModel(true))) return;
    if (!activeSession(session, tunnel)) return;
    await createTerminal(session, tunnel, agent, executable);
  }

  let sidebarPending;
  let restorePending;
  const sidebarUnavailable = () => {
    if (disposed) return;
    log.warn('Codex sidebar credentials are unavailable; restore its configuration or reconnect.');
    void vscode.window.showWarningMessage(t('The Codex sidebar credential channel is unavailable. The terminal bridge remains connected. Restore Codex Configuration before enabling the sidebar again.'));
  };
  bridge.on('sidebarFailure', sidebarUnavailable);

  function enableSidebar() {
    if (sidebarPending) return sidebarPending;
    sidebarPending = (async () => {
      hosts.authority();
      if (restorePending) await restorePending;
      const cliExecutable = vscode.workspace.getConfiguration('chatgpt').get('cliExecutable');
      if (typeof cliExecutable === 'string' && cliExecutable.trim()) {
        const error = new Error('Custom Codex executable is not supported for sidebar bridging');
        error.code = 'CUSTOM_CODEX_CLI'; throw error;
      }
      const session = await connect();
      if (!session?.ready || bridge.current !== session) return;
      const tunnel = session.tunnel;
      if (session.codexIde && !session.codexIde.closed) {
        await vscode.commands.executeCommand('chatgpt.openSidebar'); return;
      }
      if (!cfg().model && !(await chooseModel(true))) return;
      if (!activeSession(session, tunnel)) return;
      const sidebar = (dependencies.createCodexSidebar || ((...args) => new CodexSidebarBridge(...args)))(session, {
        unavailable: sidebarUnavailable, log
      });
      session.codexIde = sidebar;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
        title: t('Connecting the remote Codex sidebar'), cancellable: true }, async (_, token) => {
        const cancellation = token.onCancellationRequested(() => { void sidebar.close().catch(error => log.warn(error.message)); });
        if (token.isCancellationRequested) await sidebar.close();
        try { await sidebar.enable(tunnel, cfg().model); }
        finally { cancellation.dispose(); }
      });
      if (!activeSession(session, tunnel) || sidebar.closed) return;
      log.info(`Codex sidebar provider configured; bundled CLI ${sidebar.version}.`);
      await vscode.commands.executeCommand('chatgpt.openSidebar');
      await vscode.window.showInformationMessage(t('Codex sidebar bridging is configured. Start a new Codex chat. The provider applies to new Codex sessions for this remote account; existing chats keep their provider. Keep this Magpie window connected.'));
    })().catch(error => { error.bridgeStage ||= 'codexSidebar'; throw error; })
      .finally(() => { sidebarPending = undefined; });
    return sidebarPending;
  }

  function restoreCodex() {
    if (restorePending) return restorePending;
    // Capture before publishing restorePending, avoiding a wait cycle with enable.
    const pending = sidebarPending;
    restorePending = (async () => {
      hosts.authority();
      await pending?.catch(() => {});
      const session = await connect();
      if (!session?.ready || bridge.current !== session) return;
      const tunnel = session.tunnel;
      await session.codexIde?.close();
      if (!activeSession(session, tunnel)) return;
      const controller = new AbortController();
      const abort = () => controller.abort();
      session.controller.signal.addEventListener('abort', abort, { once: true });
      if (session.controller.signal.aborted) abort();
      try {
        const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
          title: t('Restoring the remote Codex configuration'), cancellable: true }, async (_, token) => {
          const cancellation = token.onCancellationRequested(abort);
          if (token.isCancellationRequested) abort();
          try { return await tunnel.codex({ operation: 'restore' }, { signal: controller.signal }); }
          finally { cancellation.dispose(); }
        });
        if (!activeSession(session, tunnel)) return;
        session.codexIde = undefined;
        await vscode.window.showInformationMessage(t('Codex configuration restored. Preserved {0} fields changed outside Magpie. Start a new Codex chat to use the restored provider.', result.preserved?.length || 0));
      } finally { session.controller.signal.removeEventListener('abort', abort); }
    })().catch(error => { error.bridgeStage ||= 'codexSidebar'; throw error; })
      .finally(() => { restorePending = undefined; });
    return restorePending;
  }

  async function diagnose() {
    const config = cfg();
    const gatewayKey = await key();
    if (gatewayKey !== 'magpie') log.protect(gatewayKey);
    let models;
    try { models = await (dependencies.getModels || getModels)(config.gatewayPort, gatewayKey); }
    catch (error) { error.bridgeStage = 'gateway'; throw error; }
    const session = bridge.current;
    if (session?.ready) {
      try { await session.tunnel.probe(session.proxy.token, { signal: session.controller.signal }); }
      catch (error) { error.bridgeStage = 'probe'; throw error; }
    }
    const verified = session?.ready && bridge.current === session;
    log.info(`Diagnostic: gateway port ${config.gatewayPort}; models ${models.length}; remote HTTP ${verified ? 'verified' : 'not connected'}`);
    await vscode.window.showInformationMessage(verified
      ? t('Magpie is healthy: {0} models. Remote HTTP access verified.', models.length)
      : t('Magpie is healthy: {0} models. The remote tunnel is not connected.', models.length));
  }

  async function setKey() {
    const value = await vscode.window.showInputBox({
      password: true, ignoreFocusOut: true, title: t('Local Magpie gateway key'),
      prompt: t('Stored in local VS Code SecretStorage. Leave empty to clear.'),
      validateInput: input => /[\x00-\x1f\x7f]/.test(input) ? t('The key must not contain control characters.') : undefined
    });
    if (value === undefined) return;
    if (/[\x00-\x1f\x7f]/.test(value)) {
      const error = new Error(t('The key must not contain control characters.'));
      error.code = 'INVALID_KEY';
      throw error;
    }
    if (value) await context.secrets.store('gatewayKey', value);
    else await context.secrets.delete('gatewayKey');
    await bridge.disconnect();
    await vscode.window.showInformationMessage(t('Gateway key updated. Connect again to use it.'));
  }

  async function menu() {
    const ready = Boolean(bridge.current?.ready);
    const items = [
      { label: '$(terminal) ' + t('Open Remote Terminal'), command: 'terminal' },
      { label: '$(terminal) ' + t('Start Claude Code'), command: 'claude' },
      { label: '$(terminal) ' + t('Start Codex CLI'), command: 'codex' },
      { label: '$(comment-discussion) ' + t('Connect Codex Sidebar'), command: 'codexSidebar' },
      { label: '$(history) ' + t('Restore Codex Configuration'), command: 'restoreCodex' },
      { label: '$(list-selection) ' + t('Choose Model'), command: 'model' },
      { label: '$(debug-disconnect) ' + t('Disconnect or Cancel'), command: 'disconnect' },
      { label: '$(plug) ' + t('Connect'), command: 'connect' },
      { label: '$(pulse) ' + t('Check Gateway and Tunnel'), command: 'diagnose' },
      { label: '$(copy) ' + t('Copy Connection Details'), command: 'copyConnection' },
      { label: '$(server) ' + t('Change SSH Host'), command: 'changeHost' },
      { label: '$(output) ' + t('Show Logs'), command: 'logs' },
      { label: '$(gear) ' + t('Open Settings'), command: 'settings' },
      { label: '$(key) ' + t('Set Gateway Key'), command: 'key' },
      { label: '$(question) ' + t('Getting Started'), command: 'gettingStarted' }
    ];
    const selected = await vscode.window.showQuickPick(items, {
      title: ready ? t('Magpie · Connected to {0}', bridge.current.config.host) : t('Magpie · Bridge Actions'),
      placeHolder: t('Model and configuration changes apply to new sessions')
    });
    if (selected) return run(selected.command);
  }

  const commands = {
    connect, disconnect: () => bridge.disconnect(), menu,
    terminal: () => openTerminal(), claude: () => openTerminal('claude'), codex: () => openTerminal('codex'),
    codexSidebar: enableSidebar, restoreCodex,
    model: () => chooseModel(), diagnose, key: setKey, logs: () => log.show(),
    settings: () => vscode.commands.executeCommand('workbench.action.openSettings', 'magpieBridge'),
    gettingStarted: () => vscode.commands.executeCommand('workbench.action.openWalkthrough', 'wkoa.magpie-remote-bridge#magpieBridge.setup', false),
    changeHost: async () => {
      const id = hosts.authority();
      await bridge.disconnect();
      await hosts.forget(id);
      return connect();
    },
    copyConnection: async () => {
      const session = await connect();
      if (!session?.ready || bridge.current !== session) return;
      const base = `http://127.0.0.1:${session.config.remotePort}`;
      await vscode.env.clipboard.writeText(JSON.stringify({
        openaiBaseUrl: `${base}/v1`, anthropicBaseUrl: base,
        apiKey: session.proxy.token, model: cfg().model || undefined
      }, null, 2));
      await vscode.window.showInformationMessage(t('Connection details copied, including the temporary token. Manual disconnect or window reload revokes it.'));
    }
  };

  async function run(name) {
    try { return await commands[name](); } catch (error) { await showFailure(error, error.bridgeStage, name); }
  }
  for (const name of Object.keys(commands)) {
    context.subscriptions.push(vscode.commands.registerCommand(`magpieBridge.${name}`, () => run(name)));
  }
  context.subscriptions.push(status, channel,
    vscode.window.onDidCloseTerminal(terminal => terminals.delete(terminal)),
    vscode.workspace.onDidChangeConfiguration(async event => {
      if (!bridge.current?.ready || !CONNECTION_KEYS.some(name => event.affectsConfiguration(`magpieBridge.${name}`))) return;
      const expectedSession = bridge.current;
      const reconnect = t('Reconnect');
      const selected = await vscode.window.showInformationMessage(t('Bridge connection settings changed. Reconnect to apply them.'), reconnect);
      if (selected === reconnect && !disposed && bridge.current === expectedSession && expectedSession.ready) {
        await bridge.disconnect();
        await run('connect');
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      try {
        if (bridge.current?.config?.authority && bridge.current.config.authority !== hosts.authority()) bridge.disconnect();
      } catch { bridge.disconnect(); }
      render();
    }),
    { dispose }
  );
  render();

  if (vscode.extensions.getExtension('local-tools.magpie-remote-bridge') && !context.globalState.get('legacyWarningShown')) {
    void context.globalState.update('legacyWarningShown', true);
    const show = t('Show Extension');
    void vscode.window.showWarningMessage(t('An older Magpie Remote Bridge extension is installed. Disable or uninstall it to avoid duplicate commands.'), show)
      .then(selected => { if (selected === show) return vscode.commands.executeCommand('workbench.extensions.search', '@id:local-tools.magpie-remote-bridge'); });
  }
  try {
    if (cfg().autoConnect && hosts.hasSaved(hosts.authority())) void run('connect');
  } catch { /* Auto-connect only runs in an already configured trusted SSH folder. */ }
}

function deactivate() { return shutdown?.(); }

module.exports = { activate, deactivate };

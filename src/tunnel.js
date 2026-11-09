'use strict';
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { isIP } = require('node:net');
const { stripVTControlCharacters } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');
const { remoteCliScript } = require('./agents');

let codexHelper;
function socketPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 100 || /[\x00-\x20\x7f:]/.test(value)) {
    throw new Error('Invalid credential socket path');
  }
  return value;
}

function validateHost(host) {
  const invalid = () => { throw new Error('SSH Host 必须是有效的别名或 user@host，不能包含空白或命令参数'); };
  if (typeof host !== 'string' || !host) invalid();
  const parts = host.split('@');
  if (parts.length > 2 || (parts.length === 2 && !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(parts[0]))) invalid();
  let hostname = parts.at(-1);
  if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1);
  // IPv6 may start with a colon; validate it as an address rather than relaxing
  // the alias/user grammar. Limit zone identifiers to safe interface names too.
  const ipv6 = /^[a-fA-F0-9:.]+(?:%[a-zA-Z0-9_.-]+)?$/.test(hostname) && isIP(hostname) === 6;
  if (!ipv6 && (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(hostname) || parts.at(-1) !== hostname)) invalid();
  return host;
}
function sshArgs({ host, sshPort, remotePort, localPort, configFile, auth, interactive = true }, marker) {
  validateHost(host);
  for (const port of [remotePort, localPort]) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid forwarding port');
  }
  const args = ['-T', '-o', `BatchMode=${auth?.env && interactive ? 'no' : 'yes'}`, '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '-o', 'ConnectTimeout=15', '-o', `ControlMaster=${auth?.controlPath ? 'auto' : 'no'}`,
    '-o', `ControlPath=${auth?.controlPath || 'none'}`, '-o', 'ControlPersist=no',
    '-o', 'RemoteCommand=none', '-o', 'RequestTTY=no', '-o', 'SessionType=default',
    '-o', 'StrictHostKeyChecking=yes'];
  if (configFile) args.push('-F', configFile);
  if (sshPort !== undefined) {
    if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) throw new Error('Invalid SSH port');
    args.push('-p', String(sshPort));
  }
  args.push('-R', `127.0.0.1:${remotePort}:127.0.0.1:${localPort}`, host,
    `printf '%s\\n' '${marker}'; cat`);
  return args;
}
function abortError() {
  const error = new Error('SSH operation cancelled'); error.name = 'AbortError'; error.code = 'ABORT_ERR'; return error;
}
class Tunnel extends EventEmitter {
  constructor(options, spawnProcess = spawn) {
    super(); this.options = options; this.spawnProcess = spawnProcess; this.child = undefined;
    this.pending = new Set(); this.processes = new Map();
  }
  start({ signal } = {}) {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.child) return Promise.reject(new Error('SSH 隧道已在运行'));
    const marker = `MAGPIE_BRIDGE_READY_${randomBytes(12).toString('hex')}`;
    return this.run(sshArgs(this.options, marker), { signal, marker, main: true,
      timeoutMs: this.options.auth?.env ? 180000 : 25000, timeoutMessage: 'SSH 隧道建立超时' });
  }
  probe(token, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(abortError());
    if (typeof token !== 'string' || /[\x00-\x1f\x7f]/.test(token)) return Promise.reject(new Error('Invalid bridge session token'));
    const args = sshArgs({ ...this.options, interactive: false }, 'unused');
    args.splice(args.indexOf('-R'));
    args.push(this.options.host, "curl --silent --show-error --max-time 8 --output /dev/null --write-out '%{http_code}' --config -");
    // Session capability goes over encrypted stdin, never the process argument list.
    const escapedToken = token.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return this.run(args, { signal, master: this.child, timeoutMs: 20000, timeoutMessage: '远端连通性检测超时',
      input: `url = "http://127.0.0.1:${this.options.remotePort}/v1/models"\nheader = "Authorization: Bearer ${escapedToken}"\n` });
  }
  checkCli(agent, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(abortError());
    const marker = `MAGPIE_CLI_${randomBytes(12).toString('hex').toUpperCase()}`;
    const input = remoteCliScript(agent, marker);
    const args = sshArgs({ ...this.options, interactive: false }, 'unused');
    args.splice(args.indexOf('-R'));
    args.push(this.options.host, 'sh -s');
    return this.run(args, { signal, master: this.child, input, timeoutMs: 15000,
      timeoutMessage: 'Remote CLI check timed out', maxOutputBytes: 16384,
      parseOutput: body => {
        const lines = stripVTControlCharacters(body).split('\n').filter(line => line.startsWith(`${marker}\t`));
        if (lines.length !== 1) throw new Error('Invalid remote CLI check response');
        const executable = lines[0].slice(marker.length + 1);
        if (executable === 'MISSING') return undefined;
        if (!executable.startsWith('/') || /[\x00-\x1f\x7f]/.test(executable)) throw new Error('Invalid remote CLI path');
        return executable;
      } });
  }
  async codex(request, { signal } = {}) {
    if (signal?.aborted) throw abortError();
    if (!['inspect', 'prepare', 'apply', 'restore', 'cleanup', 'rebind'].includes(request?.operation)) throw new Error('Invalid Codex bridge operation');
    for (const key of Object.keys(request)) {
      if (!['operation', 'owner', 'model', 'remotePort', 'socketPath'].includes(key)) throw new Error('Invalid Codex bridge parameter');
    }
    const source = await (codexHelper ||= fs.readFile(path.join(__dirname, 'codex-remote.py'), 'utf8'));
    const data = Buffer.from(JSON.stringify(request)).toString('base64');
    const args = sshArgs({ ...this.options, interactive: false }, 'unused');
    args.splice(args.indexOf('-R'));
    args.push(this.options.host, 'python3 -I -');
    return this.run(args, { signal, master: this.child, timeoutMs: 60000,
      timeoutMessage: 'Codex sidebar configuration timed out', maxOutputBytes: 32768, safeErrors: true,
      input: `${source}\nWATCHDOG_SOURCE = base64.b64decode("${Buffer.from(source).toString('base64')}").decode('utf-8')\nmain(json.loads(base64.b64decode("${data}")))\n`,
      parseOutput: body => {
        const replies = stripVTControlCharacters(body).split('\n').flatMap(line => {
          try { const value = JSON.parse(line); return value && typeof value.ok === 'boolean' ? [value] : []; }
          catch { return []; }
        });
        if (replies.length !== 1) throw new Error('Invalid Codex bridge response');
        const result = replies[0];
        if (result.ok !== true) {
          const error = new Error('Codex sidebar configuration failed');
          error.code = typeof result.code === 'string' && /^[A-Z_]{1,64}$/.test(result.code) ? result.code : 'CODEX_CONFIG_FAILED';
          throw error;
        }
        return result;
      } });
  }
  openCredentialForward(localSocket, remoteSocket, { signal } = {}) {
    socketPath(localSocket); socketPath(remoteSocket);
    const marker = `MAGPIE_CREDENTIAL_READY_${randomBytes(12).toString('hex')}`;
    const args = sshArgs({ ...this.options, interactive: false }, marker);
    args.splice(args.indexOf('-R'));
    args.push('-R', `${remoteSocket}:${localSocket}`, this.options.host, `printf '%s\\n' '${marker}'; cat`);
    return this.run(args, { signal, master: this.child, marker, persistent: true,
      timeoutMs: 20000, timeoutMessage: 'Codex credential forwarding timed out' });
  }
  stop() {
    // Reject before signalling children; neither a late marker nor HTTP 200 can win.
    for (const operation of [...this.pending]) operation.cancel(abortError());
    this.child = undefined;
    for (const process of this.processes.values()) process.terminate();
  }
  run(args, { signal, main = false, persistent = false, marker, master, input, timeoutMs, timeoutMessage, maxOutputBytes = 128, parseOutput, safeErrors = false }) {
    return new Promise((resolve, reject) => {
      let child; let record; let timer; let settled = false; let closed = false; let terminating = false; let killTimer;
      const forward = new EventEmitter();
      forward.stop = () => record?.terminate();
      let body = ''; let errorText = ''; let outputBytes = 0;
      const operation = { main, cancel: error => finish(error) };
      const onAbort = () => finish(abortError());
      const finish = (error, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
        this.pending.delete(operation);
        if (error) {
          if (main && this.child === child) this.child = undefined;
          record?.terminate(); reject(error);
        } else resolve(value);
      };
      const onError = error => {
        if (!settled) finish(error);
        else if (main || persistent) record?.terminate();
      };
      const onStdout = chunk => {
        if ((main || persistent) && settled) return;
        const text = chunk.toString(); outputBytes += Buffer.byteLength(text);
        if (!main && !persistent && outputBytes > maxOutputBytes) return finish(new Error(parseOutput ? 'Remote CLI check output exceeded limit' : '远端网关检测响应过长'));
        body = (body + text).slice(main || persistent ? -4096 : -maxOutputBytes);
        if ((main || persistent) && body.includes(marker)) {
          // Also observe a close emitted in the same turn as the readiness marker.
          queueMicrotask(() => {
            if (closed || child.exitCode != null || child.signalCode != null) return;
            if (main && this.child === child) finish();
            else if (persistent) {
              if (master && (this.child !== master || master.killed || master.exitCode != null || master.signalCode != null)) finish(new Error('SSH connection closed during credential forwarding'));
              else finish(undefined, forward);
            }
          });
        }
      };
      const onStderr = chunk => { errorText = (errorText + chunk).slice(-4096); };
      const onClose = code => {
        closed = true; clearTimeout(killTimer);
        this.processes.delete(child);
        child.stdin.removeListener('error', onError);
        child.stdout.removeListener('data', onStdout); child.stdout.removeListener('error', onError);
        child.stderr.removeListener('data', onStderr); child.stderr.removeListener('error', onError);
        child.removeListener('error', onError);
        if (main) {
          const wasCurrent = this.child === child;
          if (wasCurrent) this.child = undefined;
          const message = `SSH 已退出 (${code}): ${errorText.trim() || '连接已关闭'}`;
          if (!settled) finish(new Error(message));
          if (wasCurrent) {
            for (const pending of [...this.pending]) if (!pending.main) pending.cancel(new Error(message));
            this.emit('closed', message);
          }
        } else if (persistent) {
          const message = 'Codex credential forwarding closed';
          if (!settled) finish(new Error(message));
          forward.emit('closed', message);
        } else if (code !== 0 || (!parseOutput && body.trim() !== '200')) {
          finish(new Error(safeErrors ? `Codex sidebar remote operation failed (SSH/Python=${code})` : parseOutput ? `Remote CLI check failed (SSH/shell=${code}): ${errorText.trim()}` : `远端网关检测失败 (SSH/curl=${code}, HTTP=${body.trim() || '无响应'})；确认远端已安装 curl、SSH Host 与当前工作区一致`));
        } else {
          queueMicrotask(() => {
            if (master && (this.child !== master || master.killed || master.exitCode != null || master.signalCode != null)) {
              finish(new Error('SSH 隧道在远端检测期间已关闭'));
            } else {
              try { finish(undefined, parseOutput ? parseOutput(body) : undefined); }
              catch (error) { finish(error); }
            }
          });
        }
      };
      this.pending.add(operation);
      try {
        if (signal?.aborted) { finish(abortError()); return; }
        signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => finish(new Error(timeoutMessage)), timeoutMs);
        child = this.spawnProcess(this.options.sshPath || 'ssh', args,
          { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: this.options.auth?.env });
        record = { terminate() {
          if (closed || terminating) return;
          terminating = true;
          try { child.stdin.end(); } catch { /* The pipe may already be closed. */ }
          if (child.exitCode != null || child.signalCode != null) return;
          try { child.kill(); } catch { /* Still attempt forced termination below. */ }
          if (!closed && child.exitCode == null && child.signalCode == null) {
            killTimer = setTimeout(() => {
              if (!closed && child.exitCode == null && child.signalCode == null) {
                try { child.kill('SIGKILL'); } catch { /* The process may have just exited. */ }
              }
            }, 2000);
            killTimer.unref();
          }
        } };
        this.processes.set(child, record);
        if (main && !settled) this.child = child;
        child.stdin.on('error', onError);
        child.stdout.on('data', onStdout); child.stdout.on('error', onError);
        child.stderr.on('data', onStderr); child.stderr.on('error', onError);
        child.on('error', onError); child.once('close', onClose);
        // stop()/abort may have run inside an injected spawn implementation.
        if (settled) { record.terminate(); return; }
        if (input !== undefined) child.stdin.end(input);
        if (signal?.aborted) onAbort();
      } catch (error) { finish(error); }
    });
  }
}
module.exports = { Tunnel, sshArgs, validateHost };

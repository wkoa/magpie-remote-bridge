'use strict';

const { randomBytes } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { startCredentialBroker } = require('./credential-broker');
const { cancelled, abortable } = require('./cancellation');

/** Owns the sidebar's private credential channel and its remote configuration. */
class CodexSidebarBridge {
  constructor(session, { startBroker = startCredentialBroker, unavailable = () => {}, log } = {}) {
    this.session = session;
    this.startBroker = startBroker;
    this.unavailable = unavailable;
    this.log = log;
    this.owner = randomBytes(16).toString('hex');
    this.controller = new AbortController();
    this.closed = false;
    this.available = false;
    this.applied = false;
    this.prepared = false;
    this.onAbort = () => { void this.close().catch(error => this.log?.warn(error.message)); };
    session.controller.signal.addEventListener('abort', this.onAbort, { once: true });
    if (session.controller.signal.aborted) this.onAbort();
  }

  check(tunnel) {
    if (this.closed || this.controller.signal.aborted || this.session.tunnel !== tunnel) throw cancelled();
  }

  enable(tunnel, model) {
    if (!this.pending) {
      this.pending = abortable(this._enable(tunnel, model), this.controller.signal).catch(async error => {
        try { await this.close(); }
        catch (cleanupError) { this.log?.warn(cleanupError.message); }
        throw error;
      });
    }
    return this.pending;
  }

  async _enable(tunnel, model) {
    const signal = this.controller.signal;
    let prepared = false;
    try {
      this.check(tunnel);
      const broker = await this.startBroker(this.session.proxy.token, {
        available: () => !this.closed && this.available && this.session.ready
      });
      if (this.closed) { await broker.close(); throw cancelled(); }
      this.broker = broker;
      const result = await tunnel.codex({ operation: 'prepare', owner: this.owner }, { signal });
      prepared = true;
      this.prepared = true;
      this.check(tunnel);
      this.socketPath = result.socketPath;
      this.version = result.version;
      await this.forward(tunnel);
      this.check(tunnel);
      // A failed/aborted write may have reached the server. Keep its recovery record.
      this.applied = true;
      await tunnel.codex({ operation: 'apply', owner: this.owner, socketPath: this.socketPath,
        model, remotePort: this.session.config.remotePort }, { signal });
      this.check(tunnel);
      return { version: this.version };
    } catch (error) {
      if (prepared && !this.applied && !signal.aborted && this.session.tunnel === tunnel && this.session.ready) {
        try { await tunnel.codex({ operation: 'cleanup', owner: this.owner }, { signal }); }
        catch { /* An interrupted remote operation remains recoverable via Restore. */ }
      }
      throw error;
    }
  }

  async forward(tunnel) {
    this.check(tunnel);
    const forward = await tunnel.openCredentialForward(this.broker.socketPath, this.socketPath, { signal: this.controller.signal });
    if (this.closed || this.session.tunnel !== tunnel) { forward.stop(); throw cancelled(); }
    this.forwarding = forward;
    this.available = true;
    forward.once('closed', () => {
      if (this.forwarding !== forward) return;
      this.available = false;
      if (!this.closed && this.session.ready && this.session.tunnel === tunnel) this.unavailable();
    });
  }

  async reconnect(tunnel) {
    await this.pending?.catch(() => {});
    if (this.closed || !this.applied) return;
    this.available = false;
    this.forwarding?.stop();
    this.forwarding = undefined;
    const result = await tunnel.codex({ operation: 'rebind', owner: this.owner, socketPath: this.socketPath }, { signal: this.controller.signal });
    this.check(tunnel);
    if (result.socketPath !== this.socketPath) throw new Error('Codex credential socket ownership changed');
    await this.forward(tunnel);
  }

  async restore(tunnel) {
    await this.close();
    if (!this.applied && !this.prepared) return;
    const signal = AbortSignal.timeout(15000);
    let result;
    while (true) {
      signal.throwIfAborted();
      try {
        result = await tunnel.codex({ operation: 'restore', owner: this.owner }, { signal });
        break;
      } catch (error) {
        // A cancelled apply or the watchdog may briefly hold the account lock.
        if (error.code !== 'LEASE_BUSY') throw error;
        await delay(100, undefined, { signal });
      }
    }
    this.applied = false;
    this.prepared = false;
    return result;
  }

  close() {
    if (!this.closing) {
      this.closed = true;
      this.available = false;
      this.session.controller.signal.removeEventListener('abort', this.onAbort);
      this.closing = Promise.resolve().then(async () => {
        try { this.forwarding?.stop(); }
        finally { await this.broker?.close(); }
      });
      this.controller.abort();
    }
    return this.closing;
  }
}

module.exports = { CodexSidebarBridge };

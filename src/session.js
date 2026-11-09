'use strict';

const { EventEmitter } = require('node:events');
const { cancelled, isCancelled, abortable } = require('./cancellation');

const RECONNECT = Object.freeze({ maxAttempts: 3, baseDelayMs: 1000, stableMs: 60000 });


/**
 * Owns one bridge's resources. UI code supplies adapters; this module never loads
 * VS Code. A reconnect retains the proxy and capability until explicit teardown.
 */
class BridgeSession extends EventEmitter {
  constructor(dependencies) {
    super();
    this.deps = dependencies;
    this.clock = dependencies.clock || { setTimeout, clearTimeout };
    this.policy = { ...RECONNECT, ...dependencies.reconnect };
    this.state = 'disconnected';
    this.current = undefined;
    this.pending = undefined;
    this.disposed = false;
  }

  /** Concurrent callers, including callers during reconnect, share one result. */
  connect() {
    if (this.disposed) return Promise.resolve();
    if (this.disconnecting) return this.disconnecting.then(() => this.connect());
    if (this.current?.ready) return Promise.resolve(this.current);
    if (this.pending) return this.pending.promise;

    const session = {
      controller: new AbortController(), ready: false, stopped: false,
      attempts: 0, stage: 'configuration'
    };
    this.current = session;
    const operation = { session };
    this.pending = operation;
    const work = Promise.resolve().then(() => this._start(session));
    operation.promise = abortable(work, session.controller.signal).catch(error => {
      if (!this._active(session) || isCancelled(error)) {
        if (this._active(session)) this.disconnect();
        return;
      }
      error.bridgeStage = session.stage;
      this._release(session);
      this._state('failed', { error });
      throw error;
    }).finally(() => {
      if (this.pending === operation) this.pending = undefined;
    });
    return operation.promise;
  }

  async _start(session) {
    this._guard(session);
    const signal = session.controller.signal;
    session.config = this.deps.readConfig();
    session.stage = 'host';
    this._state('choosing');
    const target = await this.deps.resolveTarget(session.config, signal);
    this._guard(session);
    if (!target) throw cancelled();
    session.config = { ...session.config, ...target };
    this.deps.log?.info(`SSH target: ${target.host}; remote API port: ${session.config.remotePort}`);

    session.stage = 'gateway';
    this._state('checking');
    const key = await this.deps.getGatewayKey();
    this._guard(session);
    if (key !== 'magpie') this.deps.log?.protect(key);
    await this.deps.getModels(session.config.gatewayPort, key, { signal });
    this._guard(session);

    session.stage = 'proxy';
    this._own(session, 'proxy', await this.deps.startProxy({ gatewayPort: session.config.gatewayPort, upstreamKey: key }));
    this.deps.log?.protect(session.proxy.token);
    session.stage = 'auth';
    this._own(session, 'auth', await this.deps.startAuth(challenge => this.deps.promptPassword(challenge, session.config, signal)));
    await this._establish(session, false);
    this._guard(session);
    return session;
  }

  _own(session, name, resource) {
    if (!this._active(session)) {
      try { resource.close()?.catch?.(error => this.deps.log?.warn(error.message)); }
      catch (error) { this.deps.log?.warn(error.message); }
      throw cancelled();
    }
    session[name] = resource;
  }

  async _establish(session, reconnecting) {
    this._guard(session);
    const signal = session.controller.signal;
    const tunnel = this.deps.createTunnel({ ...session.config, auth: session.auth, localPort: session.proxy.port });
    session.tunnel = tunnel;
    let closed = false;
    tunnel.once('closed', message => {
      closed = true;
      if (!this._active(session) || session.tunnel !== tunnel || !session.ready) return;
      session.ready = false;
      this._clearStable(session);
      this.deps.log?.warn(message);
      let autoReconnect;
      try { autoReconnect = this.deps.readConfig().autoReconnect; }
      catch (error) {
        error.bridgeStage = 'configuration';
        this._release(session);
        this._state('failed', { error });
        this.emit('failure', error, 'configuration');
        return;
      }
      if (autoReconnect) this._reconnect(session);
      else {
        this.disconnect();
        this.emit('failure', new Error('SSH connection closed'), 'closed');
      }
    });
    session.stage = 'tunnel';
    if (!reconnecting) this._state('connecting');
    await tunnel.start({ signal });
    this._guard(session);
    if (closed) throw new Error('SSH connection closed before verification');
    session.stage = 'probe';
    if (!reconnecting) this._state('probing');
    await tunnel.probe(session.proxy.token, { signal });
    this._guard(session);
    if (closed) throw new Error('SSH connection closed during verification');
    if (reconnecting && session.codexIde) {
      try { await session.codexIde.reconnect(tunnel); }
      catch (error) {
        await session.codexIde.close();
        this.deps.log?.warn('Codex sidebar credential forwarding could not be restored.');
        this.emit('sidebarFailure', error);
      }
      this._guard(session);
      if (closed) throw new Error('SSH connection closed during sidebar recovery');
    }
    session.ready = true;
    this._state('connected');
    this.deps.log?.info(reconnecting ? 'SSH reconnected; existing terminals and capability retained.' : 'SSH tunnel and remote HTTP probe succeeded.');
  }

  _reconnect(session) {
    const operation = { session };
    this.pending = operation;
    // Publish the pending promise before any async work, so command handlers join it.
    const work = Promise.resolve().then(async () => {
      while (this._active(session) && session.attempts < this.policy.maxAttempts) {
        const attempt = ++session.attempts;
        this._state('reconnecting', { attempt, maxAttempts: this.policy.maxAttempts });
        await this._delay(this.policy.baseDelayMs * 2 ** (attempt - 1), session.controller.signal);
        this._guard(session);
        try {
          session.tunnel.stop();
          await this._establish(session, true);
          this._guard(session);
          this._clearStable(session);
          session.stableTimer = this.clock.setTimeout(() => {
            if (this._active(session) && session.ready) session.attempts = 0;
          }, this.policy.stableMs);
          session.stableTimer.unref?.();
          return session;
        } catch (error) {
          if (!this._active(session) || isCancelled(error)) return;
          session.tunnel.stop();
          this.deps.log?.warn(error.message);
        }
      }
      if (this._active(session)) {
        const error = new Error('Automatic SSH reconnect attempts exhausted');
        error.bridgeStage = 'reconnect';
        this._release(session);
        this._state('failed', { error });
        this.emit('failure', error, 'reconnect');
      }
    }).catch(error => {
      if (!this._active(session) || isCancelled(error)) return;
      this._release(session);
      this._state('failed', { error });
      this.emit('failure', error, 'reconnect');
    });
    operation.promise = abortable(work, session.controller.signal).catch(error => {
      if (!isCancelled(error)) throw error;
    }).finally(() => {
      if (this.pending === operation) this.pending = undefined;
    });
  }

  _delay(ms, signal) {
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.clock.clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        reject(cancelled());
      };
      const timer = this.clock.setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      }, ms);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  _active(session) {
    return this.current === session && !session.stopped && !session.disconnecting && !this.disposed;
  }

  _guard(session) {
    if (!this._active(session)) throw cancelled();
  }

  _state(state, details = {}) {
    this.state = state;
    this.emit('state', { state, session: this.current, ...details });
  }

  _clearStable(session) {
    if (session.stableTimer !== undefined) this.clock.clearTimeout(session.stableTimer);
    session.stableTimer = undefined;
  }

  _release(session) {
    session.stopped = true;
    session.ready = false;
    if (this.current === session) this.current = undefined;
    if (this.pending?.session === session) this.pending = undefined;
    this._clearStable(session);
    session.controller.abort();
    // Cleanup must continue even when one disposable reports a failure.
    for (const resource of [session.codexIde, session.tunnel, session.proxy, session.auth]) {
      try {
        const result = resource?.stop ? resource.stop() : resource?.close();
        result?.catch?.(error => this.deps.log?.warn(error.message));
      } catch (error) {
        this.deps.log?.warn(error.message);
      }
    }
    this.emit('disconnected');
  }

  /** Restore an owned sidebar while SSH is usable, then release every resource. */
  disconnect() {
    if (this.disconnecting) return this.disconnecting;
    const session = this.current;
    if (!session?.ready || !session.codexIde) {
      if (session) this._release(session);
      this._state('disconnected');
      return;
    }
    session.disconnecting = true;
    session.ready = false;
    this._clearStable(session);
    this.disconnecting = Promise.resolve().then(async () => {
      try {
        await session.codexIde.restore(session.tunnel);
        this.deps.log?.info('Codex sidebar cleanup completed before disconnect.');
      } catch (error) {
        this.deps.log?.warn('Automatic Codex restoration was not confirmed; remote recovery remains armed.');
        this.emit('restoreFailure', error);
      } finally {
        this._release(session);
        this.disconnecting = undefined;
        this._state('disconnected');
      }
    });
    this._state('disconnecting');
    return this.disconnecting;
  }

  dispose() {
    this.disposed = true;
    const work = this.disconnect();
    if (work) return work.finally(() => this.removeAllListeners());
    this.removeAllListeners();
  }
}

module.exports = { BridgeSession, RECONNECT, isCancelled };

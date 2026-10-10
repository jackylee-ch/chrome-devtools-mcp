/**
 * ChildSupervisor — speaks newline-delimited JSON-RPC to a child MCP server, and can
 * SWAP the child (kill → respawn → re-handshake) while keeping the caller's connection
 * alive: requests issued during a swap are queued and replayed onto the new child.
 * This is the mechanism behind "刷新克隆=重拉子 server、agent 连接不断"(design §3.1, S7).
 */
import {spawn} from 'node:child_process';
import readline from 'node:readline';

export class ChildSupervisor {
  #cmd; #argv; #child; #rl;
  #pending = new Map();
  #nextId = 1;
  #swapping = false;
  #queue = [];
  info = null;
  tools = null;
  onNotification = null; // optional: called with server→client notifications (no id)
  initializeParams = {protocolVersion: '2025-06-18', capabilities: {}};

  // argv may be an array (fixed) or a (async) function called per spawn (e.g. to re-clone).
  constructor(cmd, argv = []) { this.#cmd = cmd; this.#argv = argv; }

  setInitializeParams(p) { if (p) this.initializeParams = p; }

  async start() { if (!this.#child) await this.#spawn(); return this; }
  started() { return !!this.#child; }

  async #spawn() {
    const args = typeof this.#argv === 'function' ? await this.#argv() : this.#argv;
    const c = spawn(this.#cmd, args, {stdio: ['pipe', 'pipe', 'inherit']});
    this.#child = c;
    this.#rl = readline.createInterface({input: c.stdout});
    this.#rl.on('line', l => this.#onLine(l));
    // If the child dies (e.g. `cdp-mcp-bg login` kills it to grab the profile lock), reset
    // so the next request transparently respawns on the (now logged-in) profile.
    c.on('exit', () => {
      if (this.#child !== c) return;
      this.#child = null;
      for (const [, p] of this.#pending) p({error: {message: 'child exited'}});
      this.#pending.clear();
    });
    // Handshake is INTERNAL — consumed here, never forwarded to the agent (so a re-spawn
    // after idle does not emit a spurious second initialize response upstream).
    this.info = await this.#send('initialize', this.initializeParams);
    const t = await this.#send('tools/list', {});
    this.tools = (t.tools || []).map(x => x.name);
  }

  #onLine(line) {
    if (!line.trim()) return;
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.id !== undefined && this.#pending.has(m.id)) {
      const p = this.#pending.get(m.id); this.#pending.delete(m.id); p(m);
    } else if (m.id === undefined && m.method && this.onNotification) {
      this.onNotification(m); // server→client notification: forward upstream
    }
  }

  #send(method, params) {
    const id = this.#nextId++;
    return new Promise((res, rej) => {
      this.#pending.set(id, msg => (msg.error ? rej(new Error(msg.error.message)) : res(msg.result)));
      this.#child.stdin.write(JSON.stringify({jsonrpc: '2.0', id, method, params}) + '\n');
    });
  }
  // placeholder-B

  /** Forward a request; if a swap is in progress, queue it until the new child is ready. */
  async request(method, params) {
    if (this.#swapping) return new Promise((res, rej) => this.#queue.push({method, params, res, rej}));
    return this.#send(method, params);
  }

  /** Kill + respawn the child and re-handshake. Returns {toolsStable, oldPid, newPid}. */
  async swap() {
    this.#swapping = true;
    const old = this.#child;
    const oldPid = old && old.pid;
    const oldTools = this.tools;
    try {
      this.#killChild(old);
      await this.#spawn();
    } finally {
      this.#swapping = false;
    }
    const q = this.#queue; this.#queue = [];
    for (const item of q) this.#send(item.method, item.params).then(item.res, item.rej);
    return {toolsStable: JSON.stringify(oldTools) === JSON.stringify(this.tools), oldPid, newPid: this.#child.pid};
  }

  #killChild(c) {
    try { this.#rl && this.#rl.close(); } catch { /* ignore */ }
    for (const [, p] of this.#pending) p({error: {message: 'child swapped'}});
    this.#pending.clear();
    try { c && c.kill('SIGKILL'); } catch { /* ignore */ }
  }

  stop() { this.#killChild(this.#child); this.#child = null; }
  childPid() { return this.#child && this.#child.pid; }
}

/** Idle reaper: calls onIdle after `ms` of no activity. touch() on every request. */
export class IdleTimer {
  #ms; #onIdle; #t;
  constructor(ms, onIdle) { this.#ms = ms; this.#onIdle = onIdle; }
  touch() {
    clearTimeout(this.#t);
    this.#t = setTimeout(() => this.#onIdle(), this.#ms);
    if (this.#t.unref) this.#t.unref();
  }
  stop() { clearTimeout(this.#t); }
}

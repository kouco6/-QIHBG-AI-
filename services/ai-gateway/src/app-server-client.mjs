import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { buildCodexEnv, getCodexCommand } from "./codex-runner.mjs";

const rpcError = (error) => {
  const message = error?.message || JSON.stringify(error) || "Unknown app-server error";
  const result = new Error(message);
  result.code = "APP_SERVER_RPC";
  result.details = error;
  return result;
};

/**
 * One persistent Codex app-server process shared by all gateway tasks.
 * The stable transport is newline-delimited JSON-RPC over stdio.
 */
export class AppServerClient extends EventEmitter {
  constructor({ initializeTimeoutMs = 20_000 } = {}) {
    super();
    this.initializeTimeoutMs = initializeTimeoutMs;
    this.child = null;
    this.startPromise = null;
    this.pending = new Map();
    this.nextId = 1;
    this.startedAt = null;
    this.restartCount = 0;
    this.lastError = null;
    this.stopping = false;
  }

  status() {
    return {
      state: this.child && !this.child.killed ? "ready" : this.startPromise ? "starting" : "stopped",
      pid: this.child?.pid ?? null,
      startedAt: this.startedAt,
      restartCount: this.restartCount,
      pendingRequests: this.pending.size,
      lastError: this.lastError,
      transport: "stdio-jsonl",
    };
  }

  async start() {
    if (this.child && !this.child.killed) return this;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.#startOnce();
    try {
      await this.startPromise;
      return this;
    } finally {
      this.startPromise = null;
    }
  }

  async #startOnce() {
    const command = getCodexCommand();
    const child = spawn(command, ["app-server", "--listen", "stdio://"], {
      env: buildCodexEnv(),
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.startedAt = new Date().toISOString();
    this.stopping = false;

    const stdout = createInterface({ input: child.stdout });
    stdout.on("line", (line) => this.#onLine(line));
    const stderr = createInterface({ input: child.stderr });
    stderr.on("line", (line) => {
      if (line.trim()) this.emit("diagnostic", { stream: "stderr", text: line });
    });
    child.once("error", (error) => this.#onExit(error));
    child.once("close", (code, signal) => {
      const error = new Error(`Codex app-server closed (${code ?? "null"}${signal ? `, ${signal}` : ""})`);
      error.code = "APP_SERVER_EXIT";
      error.exitCode = code;
      error.exitSignal = signal;
      this.#onExit(error);
    });

    const timer = setTimeout(() => {
      const pending = [...this.pending.entries()].find(([, item]) => item.method === "initialize");
      if (pending) {
        const error = new Error(`Codex app-server initialization timed out after ${this.initializeTimeoutMs} ms`);
        error.code = "APP_SERVER_INIT_TIMEOUT";
        pending[1].reject(error);
        this.pending.delete(pending[0]);
      }
    }, this.initializeTimeoutMs);
    try {
      await this.request("initialize", {
        clientInfo: { name: "workbuddy-codex-gateway", title: "WorkBuddy Codex Gateway", version: "1.0.0" },
        capabilities: { experimentalApi: false },
      });
      this.notify("initialized");
      this.emit("ready", this.status());
    } catch (error) {
      this.lastError = error?.message || String(error);
      this.#terminate();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async request(method, params = {}) {
    if (method !== "initialize") await this.start();
    if (!this.child?.stdin?.writable) {
      const error = new Error("Codex app-server stdin is unavailable");
      error.code = "APP_SERVER_UNAVAILABLE";
      throw error;
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      try {
        this.#write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params) {
    this.#write(params === undefined
      ? { jsonrpc: "2.0", method }
      : { jsonrpc: "2.0", method, params });
  }

  respond(id, result) {
    this.#write({ jsonrpc: "2.0", id, result });
  }

  respondError(id, code, message) {
    this.#write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  async stop() {
    this.stopping = true;
    this.#terminate();
  }

  #write(frame) {
    if (!this.child?.stdin?.writable) throw new Error("Codex app-server is not writable");
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  #onLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit("diagnostic", { stream: "stdout", text: line });
      return;
    }
    if (message.id !== undefined && message.id !== null && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(rpcError(message.error));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.id !== null && message.method) {
      this.emit("request", message);
      return;
    }
    if (message.method) this.emit("notification", message);
  }

  #onExit(error) {
    if (!this.child) return;
    this.lastError = error?.message || String(error);
    this.child = null;
    if (!this.stopping) this.restartCount += 1;
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
    this.emit("exit", error);
  }

  #terminate() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try { child.stdin.end(); } catch {}
    try { child.kill(); } catch {}
  }
}

import WebSocket from "ws";
import { resolveBrowserWsUrl, targetIdOf } from "./browser-endpoint.js";

export interface CdpTarget {
  id: string;
  type: string;
  url?: string;
  title?: string;
  webSocketDebuggerUrl?: string;
}

export interface AccessibilityNode {
  nodeId: string;
  parentId?: string;
  backendDOMNodeId?: number;
  role?: { value: string };
  name?: { value: string };
  value?: { value: string };
  description?: { value: string };
  properties?: Array<{ name: string; value: { value: unknown } }>;
  childIds?: string[];
  ignored?: boolean;
}

export interface CdpClient {
  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T>;
  waitForEvent<T = unknown>(method: string, timeoutMs?: number): Promise<T>;
  waitForEventMatching?<T = unknown>(
    method: string,
    predicate: (params: T) => boolean,
    timeoutMs?: number,
  ): Promise<T>;
  onEvent?<T = unknown>(method: string, handler: (params: T) => void): () => void;
  close(): void;
}

/** How long an unused shared browser socket stays open (avoids re-approval prompts). */
const BROWSER_SOCKET_IDLE_MS = 30_000;

interface BrowserSocketEntry {
  conn: Promise<CdpConnection>;
  refs: number;
  idle?: ReturnType<typeof setTimeout>;
}

interface BrowserLease {
  conn: CdpConnection;
  release: () => void;
}

/** One browser-level socket per DevTools host, shared by every flattened page session. */
const browserSockets = new Map<string, BrowserSocketEntry>();
/** Hosts that refuse /devtools/page/<id> sockets (chrome://inspect remote debugging). */
const browserOnlyHosts = new Set<string>();

export class CdpConnection implements CdpClient {
  private nextId = 0;
  private readonly pendingRequests = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly pendingEvents = new Map<
    string,
    Array<{
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }>
  >();
  private readonly eventHandlers = new Map<string, Set<(params: unknown) => void>>();
  private closed = false;

  /**
   * With `sessionId` the connection is a flattened target session multiplexed
   * over a shared browser socket: it only sees its own messages, and close()
   * detaches the session via `onClose` instead of closing the socket.
   */
  constructor(
    private readonly ws: WebSocket,
    private readonly session?: { sessionId: string; onClose: () => void },
  ) {
    this.ensureListening();
  }

  /**
   * Connect to a page (or browser) WebSocket URL. When the host refuses page
   * sockets, attach to the page through the browser socket instead.
   */
  static async connect(targetWsUrl: string): Promise<CdpConnection> {
    const hostPort = new URL(targetWsUrl).host;
    const targetId = targetIdOf(targetWsUrl);
    if (!targetId) return await CdpConnection.open(targetWsUrl);
    if (browserOnlyHosts.has(hostPort)) {
      return await CdpConnection.attachViaBrowser(hostPort, targetId);
    }
    try {
      return await CdpConnection.open(targetWsUrl);
    } catch (error) {
      try {
        const conn = await CdpConnection.attachViaBrowser(hostPort, targetId);
        browserOnlyHosts.add(hostPort);
        return conn;
      } catch {
        throw error;
      }
    }
  }

  /** Send one browser-level command (Target.*, Browser.*) over the shared browser socket. */
  static async sendBrowserCommand<T = unknown>(
    hostPort: string,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    const lease = await CdpConnection.acquireBrowser(hostPort);
    try {
      return await lease.conn.send<T>(method, params);
    } finally {
      lease.release();
    }
  }

  private static async attachViaBrowser(
    hostPort: string,
    targetId: string,
  ): Promise<CdpConnection> {
    const lease = await CdpConnection.acquireBrowser(hostPort);
    try {
      const { sessionId } = await lease.conn.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      return new CdpConnection(lease.conn.ws, {
        sessionId,
        onClose: () => {
          void lease.conn
            .send("Target.detachFromTarget", { sessionId }, 2000)
            .catch(() => undefined)
            .finally(lease.release);
        },
      });
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  private static async acquireBrowser(hostPort: string): Promise<BrowserLease> {
    let entry = browserSockets.get(hostPort);
    if (!entry) {
      const created: BrowserSocketEntry = { refs: 0, conn: Promise.resolve(undefined as never) };
      const forget = () => {
        if (browserSockets.get(hostPort) === created) browserSockets.delete(hostPort);
      };
      created.conn = (async () => {
        const endpoint = await resolveBrowserWsUrl(hostPort);
        if (!endpoint) throw new Error(`No browser DevTools endpoint found for ${hostPort}`);
        const conn = await CdpConnection.open(endpoint.url);
        conn.ws.setMaxListeners(0); // one listener set per attached page session
        conn.ws.once("close", forget);
        return conn;
      })();
      created.conn.catch(forget);
      browserSockets.set(hostPort, created);
      entry = created;
    }
    const current = entry;
    current.refs++;
    clearTimeout(current.idle);
    let conn: CdpConnection;
    try {
      conn = await current.conn;
    } catch (error) {
      current.refs--;
      throw error;
    }
    let released = false;
    return {
      conn,
      release: () => {
        if (released) return;
        released = true;
        current.refs--;
        if (current.refs > 0) return;
        current.idle = setTimeout(() => {
          if (current.refs > 0) return;
          if (browserSockets.get(hostPort) === current) browserSockets.delete(hostPort);
          conn.close();
        }, BROWSER_SOCKET_IDLE_MS);
        current.idle.unref();
      },
    };
  }

  private static async open(targetWsUrl: string): Promise<CdpConnection> {
    const ws = new WebSocket(targetWsUrl);
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        ws.off("error", onError);
        resolve();
      };
      const onError = (err: Error) => {
        ws.off("open", onOpen);
        reject(err);
      };
      ws.once("open", onOpen);
      ws.once("error", onError);
    });
    return new CdpConnection(ws);
  }

  private ensureListening(): void {
    this.ws.on("message", this.handleMessage);
    this.ws.once("close", this.handleClose);
    this.ws.on("error", this.handleError);
  }

  private readonly handleMessage = (raw: WebSocket.RawData) => {
    let message: {
      id?: number;
      sessionId?: string;
      method?: string;
      result?: unknown;
      error?: { message: string };
      params?: unknown;
    };
    try {
      message = JSON.parse(raw.toString("utf8")) as typeof message;
    } catch {
      return;
    }
    // A shared browser socket carries every session's traffic; keep only ours.
    if (message.sessionId !== this.session?.sessionId) return;

    if (typeof message.id === "number") {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) {
        return;
      }
      this.pendingRequests.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(new Error(message.error.message));
        return;
      }
      pending.resolve(message.result ?? {});
      return;
    }

    if (!message.method) {
      return;
    }

    const params = message.params ?? {};
    const handlers = this.eventHandlers.get(message.method);
    if (handlers) {
      for (const handler of handlers) {
        handler(params);
      }
    }

    const waiters = this.pendingEvents.get(message.method);
    if (!waiters?.length) {
      return;
    }
    this.pendingEvents.delete(message.method);
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve(params);
    }
  };

  private readonly handleError = (err: Error) => {
    this.failAllPending(err);
  };

  private readonly handleClose = () => {
    this.failAllPending(new Error("CDP connection closed"));
  };

  private failAllPending(error: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.ws.off("message", this.handleMessage);
    this.ws.off("error", this.handleError);
    this.ws.off("close", this.handleClose);

    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();

    for (const waiters of this.pendingEvents.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timeout);
        waiter.reject(error);
      }
    }
    this.pendingEvents.clear();
    this.eventHandlers.clear();
  }

  async send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = 15000,
  ): Promise<T> {
    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`WebSocket not open (state=${this.ws.readyState}), cannot send '${method}'`);
    }
    const id = ++this.nextId;
    const payload = this.session
      ? { id, method, params, sessionId: this.session.sessionId }
      : { id, method, params };

    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`CDP call '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingRequests.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
      this.ws.send(JSON.stringify(payload));
    });
  }

  waitForEvent<T = unknown>(method: string, timeoutMs = 5000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const waiters = this.pendingEvents.get(method);
        if (!waiters) {
          reject(new Error(`Timed out waiting for ${method}`));
          return;
        }
        const next = waiters.filter((waiter) => waiter.timeout !== timeout);
        if (next.length > 0) {
          this.pendingEvents.set(method, next);
        } else {
          this.pendingEvents.delete(method);
        }
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      const waiters = this.pendingEvents.get(method) ?? [];
      waiters.push({
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
      this.pendingEvents.set(method, waiters);
    });
  }

  /**
   * Resolve on the first event of `method` whose params satisfy `predicate`.
   * Uses the persistent onEvent channel so non-matching events (e.g. subframe
   * navigations) don't consume the wait.
   */
  waitForEventMatching<T = unknown>(
    method: string,
    predicate: (params: T) => boolean,
    timeoutMs = 5000,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let unsubscribe = () => {};
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      unsubscribe = this.onEvent<T>(method, (params) => {
        if (!predicate(params)) return;
        clearTimeout(timeout);
        unsubscribe();
        resolve(params);
      });
    });
  }

  onEvent<T = unknown>(method: string, handler: (params: T) => void): () => void {
    const handlers = this.eventHandlers.get(method) ?? new Set<(params: unknown) => void>();
    const wrapped = (params: unknown) => {
      handler(params as T);
    };
    handlers.add(wrapped);
    this.eventHandlers.set(method, handlers);

    return () => {
      const current = this.eventHandlers.get(method);
      if (!current) return;
      current.delete(wrapped);
      if (current.size === 0) {
        this.eventHandlers.delete(method);
      }
    };
  }

  close(): void {
    const wasClosed = this.closed;
    this.failAllPending(new Error("CDP connection closed"));
    if (!this.session) {
      this.ws.close();
    } else if (!wasClosed) {
      this.session.onClose();
    }
  }
}

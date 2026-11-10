import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import WebSocket, { WebSocketServer } from "ws";

/**
 * CDP relay: holds ONE browser-level DevTools socket and multiplexes local
 * clients onto it. Chrome's chrome://inspect remote debugging asks the user to
 * approve every new DevTools connection; with the relay that happens once per
 * relay lifetime instead of once per CLI command.
 *
 * Clients speak plain CDP. Request ids are remapped per client, flattened
 * session traffic is routed to the client that attached the session, and
 * browser-level events go to every client.
 */

export interface RelayOptions {
  browserWsUrl: string;
  socketPath: string;
  /** Exit after this long without clients; `Infinity` never exits on idle. */
  idleMs: number;
  log?: (message: string) => void;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: unknown;
  sessionId?: string;
}

interface Pending {
  client: WebSocket | undefined;
  clientId: number;
  method: string;
}

export interface Relay {
  close: () => Promise<void>;
  /** Resolves once the relay shut down (idle, upstream gone, or close()). */
  closed: Promise<void>;
}

export async function runRelay(options: RelayOptions): Promise<Relay> {
  const log = options.log ?? (() => {});
  const upstream = await openSocket(options.browserWsUrl);
  log(`connected upstream ${options.browserWsUrl}`);

  let nextId = 0;
  const pending = new Map<number, Pending>();
  const sessionOwners = new Map<string, WebSocket>();
  const clients = new Set<WebSocket>();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let closing: Promise<void> | undefined;
  let markClosed = () => {};
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });

  const sendUpstream = (client: WebSocket | undefined, message: CdpMessage) => {
    const id = ++nextId;
    pending.set(id, { client, clientId: message.id ?? 0, method: message.method ?? "" });
    upstream.send(JSON.stringify({ ...message, id }));
  };

  const armIdle = () => {
    clearTimeout(idleTimer);
    if (clients.size > 0 || !Number.isFinite(options.idleMs)) return;
    // setTimeout overflows above 2^31-1 ms and would fire immediately.
    idleTimer = setTimeout(
      () => {
        log("idle, shutting down");
        void close();
      },
      Math.min(options.idleMs, 2 ** 31 - 1),
    );
  };

  upstream.on("message", (raw) => {
    let message: CdpMessage;
    try {
      message = JSON.parse(raw.toString("utf8")) as CdpMessage;
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      const sessionId = message.result?.sessionId;
      if (entry.method === "Target.attachToTarget" && typeof sessionId === "string") {
        if (entry.client) sessionOwners.set(sessionId, entry.client);
      }
      if (entry.client?.readyState === WebSocket.OPEN) {
        entry.client.send(JSON.stringify({ ...message, id: entry.clientId }));
      }
      return;
    }
    if (message.method === "Target.detachedFromTarget") {
      const sessionId = message.params?.sessionId;
      if (typeof sessionId === "string") sessionOwners.delete(sessionId);
    }
    const payload = JSON.stringify(message);
    if (message.sessionId) {
      const owner = sessionOwners.get(message.sessionId);
      if (owner?.readyState === WebSocket.OPEN) owner.send(payload);
      return;
    }
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  });
  upstream.once("close", () => {
    log("upstream closed");
    void close();
  });

  const server = http.createServer((_req, res) => {
    res.writeHead(426).end();
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (client) => {
    clients.add(client);
    armIdle();
    client.on("message", (raw) => {
      let message: CdpMessage;
      try {
        message = JSON.parse(raw.toString("utf8")) as CdpMessage;
      } catch {
        return;
      }
      if (typeof message.id !== "number" || !message.method) return;
      sendUpstream(client, message);
    });
    client.once("close", () => {
      clients.delete(client);
      for (const [id, entry] of pending) {
        if (entry.client === client) pending.set(id, { ...entry, client: undefined });
      }
      // Detach the sessions this client left behind; its tabs stay open.
      for (const [sessionId, owner] of sessionOwners) {
        if (owner !== client) continue;
        sessionOwners.delete(sessionId);
        sendUpstream(undefined, { method: "Target.detachFromTarget", params: { sessionId } });
      }
      armIdle();
    });
  });

  await listenOnSocket(server, options.socketPath);
  log(`listening on ${options.socketPath}`);
  armIdle();

  const close = (): Promise<void> => {
    closing ??= (async () => {
      clearTimeout(idleTimer);
      for (const client of clients) client.close();
      upstream.close();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(options.socketPath, { force: true });
      markClosed();
    })();
    return closing;
  };
  return { close, closed };
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => {
      ws.off("error", reject);
      resolve(ws);
    });
    ws.once("error", reject);
  });
}

/** Listen on a unix socket, replacing a stale socket file left by a dead relay. */
async function listenOnSocket(server: http.Server, socketPath: string): Promise<void> {
  const listen = () =>
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
  try {
    await listen();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    if (await isSocketAlive(socketPath)) throw error; // another relay already serves it
    fs.rmSync(socketPath, { force: true });
    await listen();
  }
  fs.chmodSync(socketPath, 0o600);
}

export function isSocketAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

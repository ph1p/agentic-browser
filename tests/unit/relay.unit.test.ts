import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import { type Relay, runRelay } from "../../src/relay/relay-server.js";

interface Msg {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  sessionId?: string;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).toReversed()) await fn();
});

/** Fake Chrome browser socket: echoes ids, hands out session ids on attach. */
async function fakeChrome(): Promise<{ url: string; received: Msg[]; push: (m: Msg) => void }> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const received: Msg[] = [];
  let socket: WebSocket | undefined;
  let sessions = 0;
  wss.on("connection", (ws) => {
    socket = ws;
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as Msg;
      received.push(msg);
      const result =
        msg.method === "Target.attachToTarget" ? { sessionId: `S${++sessions}` } : { echo: msg.id };
      ws.send(JSON.stringify({ id: msg.id, result, sessionId: msg.sessionId }));
    });
  });
  cleanups.push(() => new Promise<void>((resolve) => wss.close(() => resolve())));
  const { port } = wss.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/devtools/browser/x`,
    received,
    push: (m) => socket?.send(JSON.stringify(m)),
  };
}

async function client(socketPath: string): Promise<{ ws: WebSocket; inbox: Msg[] }> {
  const ws = new WebSocket(`ws+unix://${socketPath}:/`);
  const inbox: Msg[] = [];
  ws.on("message", (raw) => inbox.push(JSON.parse(raw.toString()) as Msg));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  cleanups.push(() => ws.close());
  return { ws, inbox };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
}

async function startRelay(
  browserWsUrl: string,
  idleMs = 60_000,
): Promise<{ relay: Relay; socket: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-relay-"));
  const socket = path.join(dir, "r.sock");
  const relay = await runRelay({ browserWsUrl, socketPath: socket, idleMs });
  cleanups.push(async () => {
    await relay.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { relay, socket };
}

describe("CDP relay", () => {
  it("remaps ids per client and routes session traffic to its owner", async () => {
    const chrome = await fakeChrome();
    const { socket } = await startRelay(chrome.url);
    const a = await client(socket);
    const b = await client(socket);

    a.ws.send(
      JSON.stringify({ id: 1, method: "Target.attachToTarget", params: { targetId: "T" } }),
    );
    b.ws.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
    await until(() => a.inbox.length === 1 && b.inbox.length === 1);
    expect(a.inbox[0]).toMatchObject({ id: 1, result: { sessionId: "S1" } });
    expect(b.inbox[0]).toMatchObject({ id: 1 });
    // Upstream saw distinct ids for the two client requests.
    expect(new Set(chrome.received.map((m) => m.id)).size).toBe(2);

    chrome.push({ method: "Page.loadEventFired", sessionId: "S1", params: {} });
    chrome.push({ method: "Target.targetCreated", params: {} });
    await until(() => a.inbox.length === 3 && b.inbox.length === 2);
    expect(a.inbox.map((m) => m.method)).toEqual([
      undefined,
      "Page.loadEventFired",
      "Target.targetCreated",
    ]);
    expect(b.inbox[1]?.method).toBe("Target.targetCreated");
  });

  it("detaches a disconnected client's sessions", async () => {
    const chrome = await fakeChrome();
    const { socket } = await startRelay(chrome.url);
    const a = await client(socket);
    a.ws.send(
      JSON.stringify({ id: 7, method: "Target.attachToTarget", params: { targetId: "T" } }),
    );
    await until(() => a.inbox.length === 1);
    a.ws.close();
    await until(() => chrome.received.some((m) => m.method === "Target.detachFromTarget"));
    expect(chrome.received.at(-1)?.params).toEqual({ sessionId: "S1" });
  });

  it("shuts down when idle", async () => {
    const chrome = await fakeChrome();
    const { relay, socket } = await startRelay(chrome.url, 50);
    await relay.closed;
    expect(fs.existsSync(socket)).toBe(false);
  });
});

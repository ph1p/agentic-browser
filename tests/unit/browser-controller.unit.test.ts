import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";
import type WebSocket from "ws";

import { CdpConnection, ChromeCdpBrowserController } from "../../src/session/browser-controller.js";

class FakeWebSocket extends EventEmitter {
  readyState = 1;
  readonly sentPayloads: string[] = [];

  send(payload: string): void {
    this.sentPayloads.push(payload);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close");
  }

  emitMessage(message: Record<string, unknown>): void {
    this.emit("message", Buffer.from(JSON.stringify(message), "utf8"));
  }
}

class FakeConnection {
  readonly sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  readonly waitCalls: string[] = [];

  constructor(
    private readonly behavior: {
      runtimeValue?: string | unknown;
      failOnRuntimeEvaluate?: boolean;
      sendHandler?: (
        method: string,
        params?: Record<string, unknown>,
      ) => unknown | Promise<unknown>;
      waitReject?: boolean;
    } = {},
  ) {}

  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.sent.push({ method, params });
    if (this.behavior.sendHandler) {
      return (await this.behavior.sendHandler(method, params)) as T;
    }
    if (method === "Runtime.evaluate" && this.behavior.failOnRuntimeEvaluate) {
      throw new Error("runtime evaluate failed");
    }
    if (method === "Runtime.evaluate") {
      return { result: { value: this.behavior.runtimeValue ?? "" } } as T;
    }
    return {} as T;
  }

  async waitForEvent<T = unknown>(method: string): Promise<T> {
    this.waitCalls.push(method);
    if (this.behavior.waitReject) {
      throw new Error("wait rejected");
    }
    return {} as T;
  }

  close(): void {}
}

describe("CdpConnection", () => {
  it("resolves all waiters and listeners for the same event", async () => {
    const ws = new FakeWebSocket();
    const conn = new CdpConnection(ws as unknown as WebSocket);
    const handled: unknown[] = [];
    conn.onEvent("Page.loadEventFired", (params) => {
      handled.push(params);
    });

    const waiter1 = conn.waitForEvent<{ ts: number }>("Page.loadEventFired");
    const waiter2 = conn.waitForEvent<{ ts: number }>("Page.loadEventFired");

    ws.emitMessage({ method: "Page.loadEventFired", params: { ts: 1 } });

    await expect(waiter1).resolves.toEqual({ ts: 1 });
    await expect(waiter2).resolves.toEqual({ ts: 1 });
    expect(handled).toEqual([{ ts: 1 }]);
  });

  it("rejects pending requests and waiters when the socket closes", async () => {
    const ws = new FakeWebSocket();
    const conn = new CdpConnection(ws as unknown as WebSocket);

    const sendPromise = conn.send("Page.enable");
    const waitPromise = conn.waitForEvent("Page.loadEventFired");

    ws.close();

    await expect(sendPromise).rejects.toThrow("CDP connection closed");
    await expect(waitPromise).rejects.toThrow("CDP connection closed");
  });

  it("multiplexes a flattened session over a shared socket", async () => {
    const ws = new FakeWebSocket();
    let detached = 0;
    const conn = new CdpConnection(ws as unknown as WebSocket, {
      sessionId: "S1",
      onClose: () => detached++,
    });

    const result = conn.send<{ value: number }>("Runtime.evaluate", { expression: "1" });
    expect(JSON.parse(ws.sentPayloads[0]!)).toMatchObject({ id: 1, sessionId: "S1" });

    const events: unknown[] = [];
    conn.onEvent("Page.loadEventFired", (params) => events.push(params));
    // Another session's response with the same id and its events are ignored.
    ws.emitMessage({ id: 1, sessionId: "S2", result: { value: 2 } });
    ws.emitMessage({ method: "Page.loadEventFired", sessionId: "S2", params: { ts: 2 } });
    ws.emitMessage({ id: 1, sessionId: "S1", result: { value: 1 } });
    ws.emitMessage({ method: "Page.loadEventFired", sessionId: "S1", params: { ts: 1 } });

    await expect(result).resolves.toEqual({ value: 1 });
    expect(events).toEqual([{ ts: 1 }]);

    conn.close();
    conn.close();
    expect(detached).toBe(1);
    expect(ws.readyState).toBe(1); // shared socket stays open
  });
});

describe("ChromeCdpBrowserController connection reuse", () => {
  it("reuses a single connection and enables domains once", async () => {
    const conn = new FakeConnection({ runtimeValue: "ok" });
    let factoryCalls = 0;
    const controller = new ChromeCdpBrowserController("/tmp", async () => {
      factoryCalls += 1;
      return conn;
    });

    await controller.getContent("ws://test", { mode: "title" });
    await controller.getContent("ws://test", { mode: "title" });

    const pageEnables = conn.sent.filter((entry) => entry.method === "Page.enable").length;
    const runtimeEnables = conn.sent.filter((entry) => entry.method === "Runtime.enable").length;

    expect(factoryCalls).toBe(1);
    expect(pageEnables).toBe(1);
    expect(runtimeEnables).toBe(1);
  });

  it("dedupes concurrent connection setup for the same target", async () => {
    const conn = new FakeConnection({ runtimeValue: "ok" });
    let factoryCalls = 0;
    const controller = new ChromeCdpBrowserController("/tmp", async () => {
      factoryCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return conn;
    });

    try {
      await Promise.all([
        controller.getContent("ws://concurrent", { mode: "title" }),
        controller.getContent("ws://concurrent", { mode: "title" }),
      ]);
      expect(factoryCalls).toBe(1);
    } finally {
      controller.dispose();
    }
  });

  it("clears a failed pending connection so the next call retries", async () => {
    const conn = new FakeConnection({ runtimeValue: "ok" });
    let factoryCalls = 0;
    const controller = new ChromeCdpBrowserController("/tmp", async () => {
      factoryCalls += 1;
      if (factoryCalls === 1) throw new Error("connect failed");
      return conn;
    });

    try {
      await expect(controller.getContent("ws://flaky", { mode: "title" })).rejects.toThrow();
      const result = await controller.getContent("ws://flaky", { mode: "title" });
      expect(result.content).toBe("ok");
      expect(factoryCalls).toBeGreaterThanOrEqual(2);
    } finally {
      controller.dispose();
    }
  });

  it("retries with a fresh connection when evaluate fails", async () => {
    const conn1 = new FakeConnection({ failOnRuntimeEvaluate: true });
    const conn2 = new FakeConnection({ runtimeValue: "ok" });
    const connections = [conn1, conn2];
    let factoryCalls = 0;
    const controller = new ChromeCdpBrowserController("/tmp", async () => {
      const conn = connections[factoryCalls];
      factoryCalls += 1;
      return conn;
    });

    const result = await controller.getContent("ws://retry", { mode: "title" });

    expect(factoryCalls).toBe(2);
    expect(result.content).toBe("ok");
    const retryEnables = conn2.sent.filter((entry) => entry.method === "Page.enable").length;
    expect(retryEnables).toBe(1);
  });

  it("waits for load events during navigation", async () => {
    const conn = new FakeConnection({ runtimeValue: "http://example.com" });
    const controller = new ChromeCdpBrowserController("/tmp", async () => conn);

    const result = await controller.navigate("ws://nav", "http://example.com");

    expect(result).toBe("http://example.com");
    expect(conn.waitCalls).toContain("Page.loadEventFired");
    expect(conn.waitCalls).toContain("Page.frameStoppedLoading");
  });

  it("uses a partial AX tree when a selector scopes a11y content", async () => {
    const conn = new FakeConnection({
      sendHandler(method) {
        if (method === "Runtime.evaluate") {
          return { result: { objectId: "ax-root-1" } };
        }
        if (method === "Accessibility.getPartialAXTree") {
          return {
            nodes: [
              {
                nodeId: "node-1",
                parentId: "outside-scope",
                role: { value: "main" },
                name: { value: "Main content" },
                childIds: ["node-2"],
              },
              {
                nodeId: "node-2",
                parentId: "node-1",
                role: { value: "heading" },
                name: { value: "Welcome" },
              },
            ],
          };
        }
        return {};
      },
    });
    const controller = new ChromeCdpBrowserController("/tmp", async () => conn);

    const result = await controller.getContent("ws://test", {
      mode: "a11y",
      selector: "#main",
    });

    expect(result.mode).toBe("a11y");
    expect(result.content).toBe('main "Main content"\n  heading "Welcome"');
    expect(conn.sent.map((entry) => entry.method)).toContain("Accessibility.getPartialAXTree");
    expect(conn.sent.map((entry) => entry.method)).not.toContain("Accessibility.getFullAXTree");
    const evaluateCall = conn.sent.find((entry) => entry.method === "Runtime.evaluate");
    expect(evaluateCall?.params?.expression).toContain("resolveLocator(selector)");
  });

  it("uses CDP mouse events for click interactions", async () => {
    const conn = new FakeConnection({
      sendHandler(method) {
        if (method === "Runtime.evaluate") {
          return { result: { value: { x: 120, y: 45 } } };
        }
        return {};
      },
    });
    const controller = new ChromeCdpBrowserController("/tmp", async () => conn);

    const result = await controller.interact("ws://test", {
      action: "click",
      selector: "#login",
    });

    expect(result).toBe("clicked");
    expect(
      conn.sent
        .filter((entry) => entry.method === "Input.dispatchMouseEvent")
        .map((entry) => ({
          type: entry.params?.type,
          x: entry.params?.x,
          y: entry.params?.y,
        })),
    ).toEqual([
      { type: "mouseMoved", x: 120, y: 45 },
      { type: "mousePressed", x: 120, y: 45 },
      { type: "mouseReleased", x: 120, y: 45 },
    ]);
  });

  describe("click navigation detection", () => {
    class EventConnection extends FakeConnection {
      readonly log: string[] = [];
      private readonly handlers = new Map<string, Set<(params: unknown) => void>>();

      constructor(onRelease: (emit: (method: string, params: unknown) => void) => void) {
        super({
          sendHandler: (method, params) => {
            if (method === "Runtime.evaluate") return { result: { value: { x: 10, y: 20 } } };
            if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
            if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") {
              onRelease((m, p) => this.emit(m, p));
            }
            return {};
          },
        });
      }

      emit(method: string, params: unknown): void {
        this.log.push(method);
        for (const handler of this.handlers.get(method) ?? []) handler(params);
      }

      waitForEventMatching<T = unknown>(
        method: string,
        predicate: (params: T) => boolean,
        timeoutMs = 5000,
      ): Promise<T> {
        return new Promise<T>((resolve, reject) => {
          const set = this.handlers.get(method) ?? new Set<(params: unknown) => void>();
          this.handlers.set(method, set);
          const handler = (params: unknown) => {
            if (!predicate(params as T)) return;
            clearTimeout(timer);
            set.delete(handler);
            resolve(params as T);
          };
          const timer = setTimeout(() => {
            set.delete(handler);
            reject(new Error(`Timed out waiting for ${method}`));
          }, timeoutMs);
          set.add(handler);
        });
      }
    }

    it("waits for navigation and load after the main frame starts loading", async () => {
      let loadEmittedAt = 0;
      const conn = new EventConnection((emit) => {
        setTimeout(() => emit("Page.frameStartedLoading", { frameId: "main" }), 20);
        setTimeout(() => emit("Page.frameNavigated", { frame: { id: "main" } }), 60);
        setTimeout(() => {
          loadEmittedAt = Date.now();
          emit("Page.loadEventFired", {});
        }, 120);
      });
      const controller = new ChromeCdpBrowserController("/tmp", async () => conn);

      const result = await controller.interact("ws://nav-click", {
        action: "click",
        selector: "#link",
      });
      const resolvedAt = Date.now();

      expect(result).toBe("clicked");
      expect(conn.log).toEqual([
        "Page.frameStartedLoading",
        "Page.frameNavigated",
        "Page.loadEventFired",
      ]);
      expect(loadEmittedAt).toBeGreaterThan(0);
      expect(resolvedAt).toBeGreaterThanOrEqual(loadEmittedAt);
    });

    it("resolves after the start window when nothing navigates", async () => {
      const conn = new EventConnection(() => {});
      const controller = new ChromeCdpBrowserController("/tmp", async () => conn);

      const startedAt = Date.now();
      const result = await controller.interact("ws://nav-none", {
        action: "click",
        selector: "#button",
      });
      const elapsed = Date.now() - startedAt;

      expect(result).toBe("clicked");
      expect(elapsed).toBeGreaterThanOrEqual(450);
      expect(elapsed).toBeLessThan(2000);
    });

    it("ignores subframe loads", async () => {
      const conn = new EventConnection((emit) => {
        setTimeout(() => emit("Page.frameStartedLoading", { frameId: "child" }), 20);
      });
      const controller = new ChromeCdpBrowserController("/tmp", async () => conn);

      const startedAt = Date.now();
      const result = await controller.interact("ws://nav-child", {
        action: "click",
        selector: "#ad",
      });
      const elapsed = Date.now() - startedAt;

      expect(result).toBe("clicked");
      expect(elapsed).toBeGreaterThanOrEqual(450);
      expect(elapsed).toBeLessThan(2000);
      expect(conn.log).toEqual(["Page.frameStartedLoading"]);
    });
  });

  it("uses CDP text insertion for type interactions", async () => {
    const conn = new FakeConnection({
      sendHandler(method) {
        if (method === "Runtime.evaluate") {
          return { result: { value: "ready" } };
        }
        return {};
      },
    });
    const controller = new ChromeCdpBrowserController("/tmp", async () => conn);

    const result = await controller.interact("ws://test", {
      action: "type",
      selector: "#email",
      text: "hello@example.com",
    });

    expect(result).toBe("typed");
    expect(conn.sent.find((entry) => entry.method === "Input.insertText")?.params?.text).toBe(
      "hello@example.com",
    );
  });

  it("uses CDP key events for press interactions", async () => {
    const conn = new FakeConnection();
    const controller = new ChromeCdpBrowserController("/tmp", async () => conn);

    const result = await controller.interact("ws://test", {
      action: "press",
      key: "Enter",
      selector: "#search",
    });

    expect(result).toBe("pressed");
    expect(
      conn.sent
        .filter((entry) => entry.method === "Input.dispatchKeyEvent")
        .map((entry) => ({
          type: entry.params?.type,
          key: entry.params?.key,
          code: entry.params?.code,
        })),
    ).toEqual([
      { type: "keyDown", key: "Enter", code: "Enter" },
      { type: "keyUp", key: "Enter", code: "Enter" },
    ]);
  });

  it("returns structured summary content with frame awareness", async () => {
    const conn = new FakeConnection({
      sendHandler(method, params) {
        if (method !== "Runtime.evaluate") {
          return {};
        }
        const expression = String(params?.expression ?? "");
        if (expression.includes("crossOriginFrameCount")) {
          return {
            result: {
              value: {
                url: "https://example.com",
                title: "Example",
                headings: ["Example"],
                landmarks: ['main "Main content"'],
                alerts: [],
                frames: [
                  {
                    selector: 'iframe[title="Checkout"]',
                    title: "Checkout",
                    src: "https://pay.example/checkout",
                    sameOrigin: false,
                  },
                ],
                crossOriginFrameCount: 1,
                hasMoreFrames: false,
              },
            },
          };
        }
        return {
          result: {
            value: {
              elements: [
                {
                  selector: "#buy",
                  role: "button",
                  tagName: "button",
                  text: "Buy now",
                  actions: ["click"],
                  visible: true,
                  enabled: true,
                },
                {
                  selector: "#email",
                  role: "input",
                  tagName: "input",
                  text: "Email",
                  actions: ["click", "type", "press"],
                  visible: true,
                  enabled: true,
                  inputType: "email",
                },
              ],
              totalFound: 2,
              truncated: false,
            },
          },
        };
      },
    });
    const controller = new ChromeCdpBrowserController("/tmp", async () => conn);

    const result = await controller.getContent("ws://test", { mode: "summary" });

    expect(result.mode).toBe("summary");
    expect(result.content).toBe("");
    expect(result.structuredContent).toMatchObject({
      title: "Example",
      crossOriginFrameCount: 1,
      primaryActions: [{ selector: "#buy", text: "Buy now" }],
      inputs: [{ selector: "#email", inputType: "email" }],
    });
  });

  it("preserves browser-side truncation metadata for content reads", async () => {
    const conn = new FakeConnection({
      sendHandler(method) {
        if (method === "Runtime.evaluate") {
          return {
            result: {
              value: { content: "abcdef", truncated: true, originalLength: 12 },
            },
          };
        }
        return {};
      },
    });
    const controller = new ChromeCdpBrowserController("/tmp", async () => conn);

    const result = await controller.getContent("ws://test", { mode: "text", maxChars: 6 });

    expect(result.truncated).toBe(true);
    expect(result.originalLength).toBe(12);
    expect(result.content).toContain("[Truncated - showing first 6 of 12 characters.");
  });
});

describe("ChromeCdpBrowserController.getInteractiveElements", () => {
  it("passes options and returns structured result", async () => {
    const mockResult = {
      elements: [
        {
          selector: "#login",
          role: "button",
          tagName: "button",
          text: "Login",
          actions: ["click"],
          visible: true,
          enabled: true,
        },
      ],
      totalFound: 1,
      truncated: false,
    };
    const conn = new FakeConnection({ runtimeValue: mockResult });
    const controller = new ChromeCdpBrowserController("/tmp", async () => conn);

    const result = await controller.getInteractiveElements("ws://test", {
      visibleOnly: true,
      limit: 10,
    });

    expect(result.elements).toHaveLength(1);
    expect(result.elements[0].selector).toBe("#login");
    expect(result.elements[0].role).toBe("button");
    expect(result.elements[0].text).toBe("Login");
    expect(result.totalFound).toBe(1);
    expect(result.truncated).toBe(false);

    const evaluateCall = conn.sent.find((s) => s.method === "Runtime.evaluate");
    expect(evaluateCall).toBeDefined();
    expect(evaluateCall!.params!.returnByValue).toBe(true);
  });

  it("retries with fresh connection on failure", async () => {
    const mockResult = { elements: [], totalFound: 0, truncated: false };
    const conn1 = new FakeConnection({ failOnRuntimeEvaluate: true });
    const conn2 = new FakeConnection({ runtimeValue: mockResult });
    const connections = [conn1, conn2];
    let factoryCalls = 0;
    const controller = new ChromeCdpBrowserController("/tmp", async () => {
      const conn = connections[factoryCalls];
      factoryCalls += 1;
      return conn;
    });

    const result = await controller.getInteractiveElements("ws://retry", {});

    expect(factoryCalls).toBe(2);
    expect(result.elements).toHaveLength(0);
  });

  it("returns empty fallback when evaluate returns undefined value", async () => {
    const conn = new FakeConnection({ runtimeValue: undefined });
    const controller = new ChromeCdpBrowserController("/tmp", async () => conn);

    const result = await controller.getInteractiveElements("ws://test", {});

    expect(result.elements).toHaveLength(0);
    expect(result.totalFound).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it("embeds options in the evaluated expression", async () => {
    const conn = new FakeConnection({
      runtimeValue: { elements: [], totalFound: 0, truncated: false },
    });
    const controller = new ChromeCdpBrowserController("/tmp", async () => conn);

    await controller.getInteractiveElements("ws://test", {
      roles: ["button", "link"],
      visibleOnly: false,
      limit: 5,
      selector: "#main",
    });

    const evaluateCall = conn.sent.find((s) => s.method === "Runtime.evaluate");
    const expr = evaluateCall!.params!.expression as string;
    expect(expr).toContain('"roles":["button","link"]');
    expect(expr).toContain('"visibleOnly":false');
    expect(expr).toContain('"limit":5');
    expect(expr).toContain('"selector":"#main"');
    expect(expr).toContain("shadowRoot");
    expect(expr).toContain("contentDocument");
  });
});

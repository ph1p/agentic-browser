import { describe, expect, it } from "vitest";

import { ChromeCdpBrowserController } from "../../src/session/browser-controller.js";

class FakeConnection {
  readonly sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  readonly waitCalls: string[] = [];

  constructor(
    private readonly behavior: {
      runtimeValue?: string | unknown;
      failOnRuntimeEvaluate?: boolean;
      waitReject?: boolean;
    } = {},
  ) {}

  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.sent.push({ method, params });
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
  });
});

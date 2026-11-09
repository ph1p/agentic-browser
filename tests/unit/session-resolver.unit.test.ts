import { describe, expect, it } from "vitest";
import { createSessionResolver } from "../../src/mcp/session-resolver.js";

describe("createSessionResolver", () => {
  it("shares one in-flight start across concurrent resolves", async () => {
    let calls = 0;
    const r = createSessionResolver(async () => {
      calls += 1;
      await new Promise((res) => setTimeout(res, 10));
      return { sessionId: "s1" };
    });
    const [a, b] = await Promise.all([r.resolve(), r.resolve()]);
    expect(calls).toBe(1);
    expect(a).toBe("s1");
    expect(b).toBe("s1");
    expect(r.current()).toBe("s1");
  });

  it("retries start after a failure", async () => {
    let calls = 0;
    const r = createSessionResolver(async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return { sessionId: "s2" };
    });
    await expect(r.resolve()).rejects.toThrow("boom");
    await expect(r.resolve()).resolves.toBe("s2");
    expect(calls).toBe(2);
  });
});

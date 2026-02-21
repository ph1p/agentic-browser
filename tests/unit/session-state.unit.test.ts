import { describe, expect, it } from "vitest";

import { SessionStateMachine } from "../../src/session/session-state.js";

describe("SessionStateMachine", () => {
  it("allows valid transitions", () => {
    const machine = new SessionStateMachine("starting");
    expect(machine.transition("ready")).toBe("ready");
    expect(machine.transition("disconnected")).toBe("disconnected");
  });

  it("rejects invalid transitions", () => {
    const machine = new SessionStateMachine("starting");
    expect(() => machine.transition("terminated")).toThrow(/Invalid transition/);
  });
});

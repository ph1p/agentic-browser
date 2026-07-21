import { describe, expect, it } from "vitest";

import { ElementRefRegistry } from "../../src/mcp/element-refs.js";
import type { InteractiveElement } from "../../src/session/browser-controller.js";

function el(overrides: Partial<InteractiveElement>): InteractiveElement {
  return {
    selector: "#a",
    role: "button",
    tagName: "button",
    text: "A",
    actions: ["click"],
    visible: true,
    enabled: true,
    ...overrides,
  };
}

describe("ElementRefRegistry", () => {
  it("assigns sequential refs and resolves them to selectors + fallbacks", () => {
    const reg = new ElementRefRegistry();
    const { elements } = reg.assign("s1", [
      el({ selector: "#login", fallbackSelectors: [".login"], text: "Login" }),
      el({ selector: "#signup", text: "Sign up" }),
    ]);

    expect(elements.map((e) => e.ref)).toEqual(["e1", "e2"]);
    expect(reg.resolve("s1", "e1")).toMatchObject({
      selector: "#login",
      fallbackSelectors: [".login"],
      text: "Login",
    });
    expect(reg.resolve("s1", "e2")?.selector).toBe("#signup");
  });

  it("does not assign a ref to selector-less elements", () => {
    const reg = new ElementRefRegistry();
    const { elements } = reg.assign("s1", [
      el({ selector: "", text: "no selector" }),
      el({ selector: "#ok", text: "ok" }),
    ]);

    expect(elements[0].ref).toBe("");
    expect(elements[1].ref).toBe("e1");
    expect(reg.resolve("s1", "e1")?.selector).toBe("#ok");
  });

  it("replaces prior refs on a fresh assignment (a new look supersedes the old)", () => {
    const reg = new ElementRefRegistry();
    reg.assign("s1", [el({ selector: "#old", text: "old" })]);
    reg.assign("s1", [el({ selector: "#new", text: "new" })]);

    // e1 now points at the new page's element, not the old one
    expect(reg.resolve("s1", "e1")?.selector).toBe("#new");
  });

  it("isolates refs per session", () => {
    const reg = new ElementRefRegistry();
    reg.assign("s1", [el({ selector: "#s1", text: "s1" })]);
    reg.assign("s2", [el({ selector: "#s2", text: "s2" })]);

    expect(reg.resolve("s1", "e1")?.selector).toBe("#s1");
    expect(reg.resolve("s2", "e1")?.selector).toBe("#s2");
  });

  it("returns undefined for unknown or cleared refs", () => {
    const reg = new ElementRefRegistry();
    reg.assign("s1", [el({ selector: "#a", text: "a" })]);

    expect(reg.resolve("s1", "e99")).toBeUndefined();
    reg.clear("s1");
    expect(reg.resolve("s1", "e1")).toBeUndefined();
  });
});

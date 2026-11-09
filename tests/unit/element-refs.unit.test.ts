import { describe, expect, it } from "vitest";

import { assignRefs, REF_PATTERN, StaleRefError } from "../../src/session/element-refs.js";
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

describe("assignRefs", () => {
  it("assigns sequential refs and maps them to selectors + fallbacks", () => {
    const { elements, byRef } = assignRefs([
      el({ selector: "#login", fallbackSelectors: [".login"], text: "Login" }),
      el({ selector: "#signup", text: "Sign up" }),
    ]);

    expect(elements.map((e) => e.ref)).toEqual(["e1", "e2"]);
    expect(byRef.e1).toEqual({ selector: "#login", fallbackSelectors: [".login"] });
    expect(byRef.e2.selector).toBe("#signup");
  });

  it("does not assign a ref to selector-less elements", () => {
    const { elements, byRef } = assignRefs([
      el({ selector: "", text: "no selector" }),
      el({ selector: "#ok", text: "ok" }),
    ]);

    expect(elements[0].ref).toBeUndefined();
    expect(elements[1].ref).toBe("e1");
    expect(byRef.e1.selector).toBe("#ok");
  });

  it("records the frame the elements were listed in", () => {
    const { byRef } = assignRefs([el({ selector: "#pay" })], "iframe#checkout");
    expect(byRef.e1.frame).toBe("iframe#checkout");
  });
});

describe("REF_PATTERN / StaleRefError", () => {
  it("matches bare and @-prefixed refs only", () => {
    expect(REF_PATTERN.exec("e3")?.[1]).toBe("e3");
    expect(REF_PATTERN.exec("@e12")?.[1]).toBe("e12");
    expect(REF_PATTERN.test("#e3")).toBe(false);
    expect(REF_PATTERN.test("e3 > a")).toBe(false);
  });

  it("names the ref and how to refresh", () => {
    const error = new StaleRefError("e7");
    expect(error.message).toContain('"e7"');
    expect(error.message).toContain("elements");
  });
});

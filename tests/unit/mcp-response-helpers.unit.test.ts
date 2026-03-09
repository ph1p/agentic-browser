import { describe, expect, it } from "vitest";

import {
  compactInteractiveElementsResult,
  compactMemoryResults,
  compactPageContent,
} from "../../src/mcp/response-helpers.js";

describe("compactPageContent", () => {
  it("adds summary and preview lines for text mode", () => {
    const result = compactPageContent({
      mode: "text",
      content: "Welcome\n\nProducts\nProducts\nCart\nCheckout",
    });

    expect(result).toMatchObject({
      mode: "text",
      truncated: false,
      summaryLines: ["Welcome", "Products", "Cart", "Checkout"],
    });
    expect(result).toHaveProperty("previewLines");
  });

  it("extracts actionable structure for a11y mode", () => {
    const result = compactPageContent({
      mode: "a11y",
      content: [
        "main",
        'heading "Shop"',
        "navigation",
        'link "Home"',
        'button "Add to cart"',
        'textbox "Search"',
      ].join("\n"),
    });

    expect(result).toMatchObject({
      mode: "a11y",
      headings: ['heading "Shop"'],
      landmarks: ["main", "navigation"],
      actions: ['link "Home"', 'button "Add to cart"'],
      inputs: ['textbox "Search"'],
    });
  });

  it("returns structured summary mode content directly", () => {
    const result = compactPageContent({
      mode: "summary",
      content: "",
      structuredContent: {
        mode: "summary",
        title: "Checkout",
        primaryActions: [{ selector: "#pay", text: "Pay now" }],
        frames: [{ selector: 'iframe[title="3DS"]', sameOrigin: false }],
      },
    });

    expect(result).toEqual({
      mode: "summary",
      title: "Checkout",
      primaryActions: [{ selector: "#pay", text: "Pay now" }],
      frames: [{ selector: 'iframe[title="3DS"]', sameOrigin: false }],
      truncated: false,
    });
  });

  it("does not retruncate content already capped in the controller", () => {
    const result = compactPageContent({
      mode: "text",
      content:
        'abcdef\n\n[Truncated - showing first 6 of 12 characters. Use a CSS selector to scope the content, or use mode="summary" for a lower-token overview.]',
      truncated: true,
      originalLength: 12,
    });

    expect(result).toMatchObject({
      mode: "text",
      truncated: true,
      originalLength: 12,
    });
    expect(result.content).toContain("[Truncated - showing first 6 of 12 characters.");
  });
});

describe("compactInteractiveElementsResult", () => {
  it("drops redundant fields and adds a summary", () => {
    const result = compactInteractiveElementsResult(
      {
        elements: [
          {
            selector: "#buy",
            role: "button",
            tagName: "button",
            text: "Buy now",
            actions: ["click"],
            visible: true,
            enabled: true,
            ariaLabel: "Buy now",
          },
        ],
        totalFound: 1,
        truncated: false,
      },
      true,
    );

    expect(result).toMatchObject({
      totalFound: 1,
      truncated: false,
      summary: {
        countsByRole: { button: 1 },
      },
    });
    expect((result.elements as Array<Record<string, unknown>>)[0]).toEqual({
      selector: "#buy",
      role: "button",
      text: "Buy now",
    });
  });
});

describe("compactMemoryResults", () => {
  it("removes ranking noise and empty fallback selectors", () => {
    const result = compactMemoryResults([
      {
        insightId: "i-1",
        taskIntent: "login:example.com",
        siteDomain: "example.com",
        confidence: 1,
        freshness: "fresh",
        lastVerifiedAt: new Date().toISOString(),
        selectorHints: ["#email"],
        selectorAliases: [
          { alias: "email", selector: "#email", fallbackSelectors: [] },
          { alias: "submit", selector: "#submit", fallbackSelectors: [".submit"] },
        ],
        score: 0.99,
      },
    ]);

    expect(result).toEqual({
      results: [
        {
          insightId: "i-1",
          taskIntent: "login:example.com",
          siteDomain: "example.com",
          confidence: 1,
          freshness: "fresh",
          selectorHints: ["#email"],
          selectorAliases: [
            { alias: "email", selector: "#email" },
            { alias: "submit", selector: "#submit", fallbackSelectors: [".submit"] },
          ],
        },
      ],
    });
  });
});

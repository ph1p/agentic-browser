// Run: npx tsx examples/element-interaction.ts
//
// Navigates to a page, discovers interactive elements, and clicks one.

import { createAgenticBrowserCore } from "agentic-browser";

const core = createAgenticBrowserCore();

const session = await core.startSession();

await core.runCommand({
  sessionId: session.sessionId,
  type: "navigate",
  payload: { url: "https://example.com" },
});

// Discover all interactive elements
const elements = await core.getInteractiveElements({
  sessionId: session.sessionId,
  visibleOnly: true,
  limit: 20,
});

console.log(`Found ${elements.totalFound} interactive elements:`);
for (const el of elements.elements) {
  console.log(`  [${el.role}] "${el.text}" -> ${el.selector}`);
  if (el.currentValue) {
    console.log(`    Current value: ${el.currentValue}`);
  }
}

// Click the first link if one exists
const firstLink = elements.elements.find((el) => el.role === "link");
if (firstLink) {
  const result = await core.runCommand({
    sessionId: session.sessionId,
    type: "interact",
    payload: {
      action: "click",
      selector: firstLink.selector,
      fallbackSelectors: firstLink.fallbackSelectors,
    },
  });
  console.log("Click result:", result.resultStatus, result.resultMessage);
}

await core.stopSession(session.sessionId);

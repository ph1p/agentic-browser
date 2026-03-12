// Run: npx tsx examples/screenshot.ts
//
// Navigates to a page and captures a screenshot.

import { writeFileSync } from "node:fs";
import { createAgenticBrowserCore } from "agentic-browser";

const core = createAgenticBrowserCore();

const session = await core.startSession();

await core.runCommand({
  sessionId: session.sessionId,
  type: "navigate",
  payload: { url: "https://example.com" },
});

// Capture a viewport screenshot
const screenshot = await core.screenshot(session.sessionId, {
  format: "png",
});

writeFileSync("screenshot.png", Buffer.from(screenshot.data, "base64"));
console.log("Screenshot saved to screenshot.png");

// Capture a full-page screenshot
const fullPage = await core.screenshot(session.sessionId, {
  format: "jpeg",
  quality: 80,
  fullPage: true,
});

writeFileSync("screenshot-full.jpg", Buffer.from(fullPage.data, "base64"));
console.log("Full page screenshot saved to screenshot-full.jpg");

await core.stopSession(session.sessionId);

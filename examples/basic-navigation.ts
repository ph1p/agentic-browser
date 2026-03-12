// Run: npx tsx examples/basic-navigation.ts
//
// Starts a Chrome session, navigates to a page, reads the content, and stops.

import { createAgenticBrowserCore } from "agentic-browser";

const core = createAgenticBrowserCore();

const session = await core.startSession();
console.log("Session started:", session.sessionId);

await core.runCommand({
  sessionId: session.sessionId,
  type: "navigate",
  payload: { url: "https://example.com" },
});

const content = await core.getPageContent({
  sessionId: session.sessionId,
  mode: "summary",
});
console.log("Page summary:", JSON.stringify(content.structuredContent, null, 2));

const url = await core.getCurrentUrl(session.sessionId);
console.log("Current URL:", url);

await core.stopSession(session.sessionId);
console.log("Session stopped.");

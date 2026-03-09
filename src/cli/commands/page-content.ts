import type { Runtime } from "../runtime.js";

export async function runPageContent(
  runtime: Runtime,
  input: {
    sessionId: string;
    mode: "title" | "text" | "html" | "a11y" | "summary";
    selector?: string;
    maxChars?: number;
  },
) {
  return await runtime.api.getContent(input.sessionId, {
    mode: input.mode,
    selector: input.selector,
    maxChars: input.maxChars,
  });
}

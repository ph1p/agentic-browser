import type { Runtime } from "../runtime.js";

export async function runPageContent(
  runtime: Runtime,
  input: { sessionId: string; mode: "title" | "text" | "html"; selector?: string },
) {
  return await runtime.api.getContent(input.sessionId, {
    mode: input.mode,
    selector: input.selector,
  });
}

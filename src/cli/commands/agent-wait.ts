import { type PageState } from "../../session/browser-controller.js";
import type { Runtime } from "../runtime.js";
import { requireSessionId, ensureReady, tryPageState, agentInteract } from "./agent-core.js";

export const INTERACTION_RESULT_PREFIX = "Interaction result: ";

/** Evaluates a JavaScript expression in the page (or a frame) and returns its value. */
export async function agentEval(runtime: Runtime, input: { expression: string; frame?: string }) {
  const result = await agentInteract(runtime, {
    action: "evaluate",
    text: input.expression,
    frame: input.frame,
  });
  const raw = result.resultMessage?.startsWith(INTERACTION_RESULT_PREFIX)
    ? result.resultMessage.slice(INTERACTION_RESULT_PREFIX.length)
    : (result.resultMessage ?? "");
  let value: unknown = raw;
  try {
    value = raw === "" || raw === "undefined" ? null : JSON.parse(raw);
  } catch {
    // plain string result
  }
  return {
    ok: true,
    action: "eval",
    sessionId: result.sessionId,
    commandId: result.commandId,
    result: value,
    url: result.url,
  };
}

/** `/re/flags` = regex, `*` = glob, otherwise substring. */
export function matchesUrlPattern(url: string, pattern: string): boolean {
  const regex = /^\/(.+)\/([a-z]*)$/.exec(pattern);
  if (regex) return new RegExp(regex[1]!, regex[2]).test(url);
  if (pattern.includes("*")) {
    const escaped = pattern
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp(`^${escaped}$`).test(url);
  }
  return url.includes(pattern);
}

export const WAIT_POLL_MS = 200;

export async function agentWait(
  runtime: Runtime,
  input: {
    selector?: string;
    text?: string;
    url?: string;
    load?: boolean;
    timeoutMs?: number;
    frame?: string;
  },
) {
  if (!input.selector && !input.text && !input.url && !input.load) {
    throw new Error("Nothing to wait for: pass a selector, --text, --url or --load");
  }
  if (input.selector && input.text) {
    throw new Error("Pass either a selector or --text, not both");
  }
  const sessionId = requireSessionId(runtime);
  await ensureReady(runtime, sessionId);
  const timeoutMs = input.timeoutMs ?? 10_000;
  const started = Date.now();
  const remaining = () => timeoutMs - (Date.now() - started);

  const pollPage = async (done: (page: PageState) => boolean, describe: string) => {
    let last: PageState | undefined;
    for (;;) {
      // Navigations tear down the execution context mid-poll; just try again.
      last = (await tryPageState(runtime, sessionId)) ?? last;
      if (last && done(last)) return last;
      if (remaining() <= 0) {
        throw new Error(
          `wait timeout after ${timeoutMs}ms: ${describe} (current url: ${last?.url ?? "unknown"}, readyState: ${last?.readyState ?? "unknown"})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(WAIT_POLL_MS, remaining())));
    }
  };

  if (input.url) {
    const pattern = input.url;
    await pollPage(
      (page) => matchesUrlPattern(page.url, pattern),
      `url did not match "${pattern}"`,
    );
  }
  if (input.load) {
    await pollPage((page) => page.readyState === "complete", "page did not finish loading");
  }
  if (input.selector || input.text) {
    await agentInteract(runtime, {
      action: "waitFor",
      selector: input.selector ?? `text=${input.text}`,
      frame: input.frame,
      timeoutMs: Math.max(remaining(), 1),
    });
  }

  const page = await tryPageState(runtime, sessionId);
  return {
    ok: true,
    action: "wait",
    sessionId,
    elapsedMs: Date.now() - started,
    url: page?.url,
    title: page?.title,
    readyState: page?.readyState,
  };
}

import type { InteractiveElement } from "./browser-controller.js";

/**
 * Short, stable handles ("e1", "e2", …) an agent can point at instead of
 * authoring CSS selectors — the way a human points at what they see rather
 * than reasoning about the DOM.
 *
 * Refs are ephemeral per "look": each element listing replaces the session's
 * ref set, and a ref only resolves while the page URL is the one it was taken
 * on. SessionManager persists them on the session record, so the CLI (one
 * process per command) and the MCP server share the same mechanism.
 */
export interface ResolvedRef {
  selector: string;
  fallbackSelectors?: string[];
  /** Iframe the element was discovered in, so the ref acts inside it. */
  frame?: string;
}

export interface StoredRefs {
  /** Page the refs were taken on; on any other page they are stale. */
  url?: string;
  byRef: Record<string, ResolvedRef>;
}

/** Matches "e3" or "@e3"; group 1 is the bare ref. */
export const REF_PATTERN = /^@?(e\d+)$/;

/**
 * Number elements e1, e2, … Elements without a selector (nothing to act on)
 * are still returned but get no ref.
 */
export function assignRefs(
  elements: InteractiveElement[],
  frame?: string,
): { elements: InteractiveElement[]; byRef: Record<string, ResolvedRef> } {
  const byRef: Record<string, ResolvedRef> = {};
  let n = 0;
  const annotated = elements.map((el) => {
    if (!el.selector) return el;
    const ref = `e${++n}`;
    byRef[ref] = { selector: el.selector, fallbackSelectors: el.fallbackSelectors, frame };
    return { ...el, ref };
  });
  return { elements: annotated, byRef };
}

/** A ref that was never assigned, or was taken on a different page. */
export class StaleRefError extends Error {
  constructor(ref: string) {
    super(
      `Unknown or stale ref "${ref}". List the page's elements again ` +
        `(agent elements / browser_get_elements) to get fresh refs.`,
    );
    this.name = "StaleRefError";
  }
}

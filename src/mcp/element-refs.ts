import type { InteractiveElement } from "../session/browser-controller.js";

/**
 * Short, stable handles ("e1", "e2", …) an agent can point at instead of
 * authoring CSS selectors — the way a human points at what they see rather
 * than reasoning about the DOM.
 *
 * Refs are ephemeral per "look": each browser_get_elements call (or the
 * post-interact page snapshot) replaces the session's ref set, mirroring
 * short-term visual memory. The registry lives in the MCP process (one map per
 * session) and resolves a ref back to the selector + fallbacks the existing
 * selector-based interact path already understands.
 */
export interface ResolvedRef {
  selector: string;
  fallbackSelectors?: string[];
  /** Human-readable label, kept only to make resolution errors legible. */
  text?: string;
  role?: string;
}

export interface RefAssignment {
  /** The element list with a `ref` field added to each entry. */
  elements: Array<InteractiveElement & { ref: string }>;
}

export class ElementRefRegistry {
  private readonly bySession = new Map<string, Map<string, ResolvedRef>>();

  /**
   * Assign fresh refs to a freshly-discovered element list, replacing any prior
   * refs for the session. Elements without a selector (nothing to act on) are
   * still returned but get no ref.
   */
  assign(sessionId: string, elements: InteractiveElement[]): RefAssignment {
    const map = new Map<string, ResolvedRef>();
    let n = 0;
    const annotated = elements.map((el) => {
      if (!el.selector) {
        return { ...el, ref: "" };
      }
      const ref = `e${++n}`;
      map.set(ref, {
        selector: el.selector,
        fallbackSelectors: el.fallbackSelectors,
        text: el.text,
        role: el.role,
      });
      return { ...el, ref };
    });
    this.bySession.set(sessionId, map);
    return { elements: annotated };
  }

  /** Resolve a ref to its selector target, or undefined if unknown/stale. */
  resolve(sessionId: string, ref: string): ResolvedRef | undefined {
    return this.bySession.get(sessionId)?.get(ref);
  }

  /** Drop a session's refs (on stop/restart) so stale handles can't resolve. */
  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}

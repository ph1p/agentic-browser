import type { CdpClient } from "./cdp-connection.js";
import type { FrameScope } from "./page-eval.js";

/**
 * Controller internals the page-level modules (content, elements, cookie
 * banner) need: the pooled-connection retry, domain enabling and frame scoping.
 */
export interface PageOps {
  withRetry<T>(
    targetWsUrl: string,
    fn: (conn: CdpClient) => Promise<T>,
    retryOn?: "any" | "connection",
  ): Promise<T>;
  ensureEnabled(targetWsUrl: string): Promise<void>;
  openFrameScope(conn: CdpClient, targetWsUrl: string, frameLocator: string): Promise<FrameScope>;
}

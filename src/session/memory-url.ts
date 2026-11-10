import { URL } from "node:url";

/** Domain + first-path-segment pattern memory indexes a URL under. */
export function parseUrl(rawUrl?: string): { domain: string; pathPattern: string } {
  if (!rawUrl) {
    return { domain: "unknown", pathPattern: "/" };
  }
  try {
    const parsed = new URL(rawUrl);
    const firstSegment = parsed.pathname.split("/").filter(Boolean)[0];
    const pathPattern = firstSegment ? `/${firstSegment}/*` : "/";
    // file: and about: URLs have no hostname; memory needs a non-empty domain.
    const domain = parsed.hostname.toLowerCase() || parsed.protocol.replace(/:$/, "");
    return { domain, pathPattern };
  } catch {
    return { domain: "unknown", pathPattern: "/" };
  }
}

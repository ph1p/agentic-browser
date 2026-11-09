const ALLOWED_KEYS = new Set([
  "action",
  "selector",
  "fallbackSelectors",
  "ref",
  "key",
  "direction",
  "amount",
  "deltaY",
  "scrollX",
  "scrollY",
  "timeoutMs",
  "redacted",
]);

const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>]+/gi;

/** Reduce a URL to origin + pathname, dropping query string and fragment. */
export function stripUrl(rawUrl: string): string | undefined {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}

/** Strip query strings and fragments from every http(s) URL embedded in free text. */
export function redactUrlsInText(text: string): string {
  return text.replace(URL_IN_TEXT, (match) => stripUrl(match) ?? "[url]");
}

/** Keep only structural, non-secret keys of a step payload; typed text and values are dropped. */
export function redactStepPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(payload)) {
    if (key === "url") {
      const stripped = typeof value === "string" ? stripUrl(value) : undefined;
      if (stripped !== undefined) result.url = stripped;
      continue;
    }
    if (ALLOWED_KEYS.has(key)) {
      result[key] = value;
    }
  }

  if ("text" in payload || "value" in payload) {
    result.redacted = true;
  }

  return result;
}

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

function stripUrl(rawUrl: string): string | undefined {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return undefined;
  }
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

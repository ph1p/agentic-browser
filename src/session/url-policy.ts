export function assertNavigableUrl(raw: string, opts: { allowFileUrls: boolean }): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }

  const { protocol } = parsed;
  if (protocol === "http:" || protocol === "https:") return;
  if (raw === "about:blank") return;
  if (protocol === "file:" && opts.allowFileUrls) return;

  const hint =
    protocol === "file:" ? " (set AGENTIC_BROWSER_ALLOW_FILE_URLS=true to allow file: URLs)" : "";
  throw new Error(`Navigation to ${protocol} URLs is not allowed${hint}`);
}

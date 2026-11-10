import { CdpConnection } from "./cdp-connection.js";

/**
 * Apply stealth patches that remove common automation fingerprints.
 * These run before any page loads so sites cannot detect the bot.
 */
export const STEALTH_SCRIPT = `(() => {
  // Guard: registered once per CDP session, so re-connects would re-run the patches
  // and the non-configurable defineProperty calls below would throw.
  if (window.__agenticStealthApplied) return;
  window.__agenticStealthApplied = true;

  // Remove navigator.webdriver flag
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

  // Provide realistic plugins array (empty = headless fingerprint)
  Object.defineProperty(navigator, 'plugins', {
    get: () => {
      const plugins = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
      ];
      plugins.length = 3;
      Object.setPrototypeOf(plugins, PluginArray.prototype);
      return plugins;
    }
  });

  // Provide realistic languages
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

  // Patch chrome.runtime to look like a real Chrome
  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) window.chrome.runtime = { id: undefined };

  // Remove the CDP-injected sourceURL comment from Runtime.evaluate calls
  const origToString = Function.prototype.toString;
  Function.prototype.toString = function() {
    if (this === Function.prototype.toString) return 'function toString() { [native code] }';
    return origToString.call(this);
  };

  // Patch permissions query to report "prompt" instead of "denied" for notifications
  const origQuery = window.Permissions?.prototype?.query;
  if (origQuery) {
    window.Permissions.prototype.query = function(params) {
      if (params?.name === 'notifications') {
        return Promise.resolve({ state: 'prompt', onchange: null });
      }
      return origQuery.call(this, params);
    };
  }
})();`;

/**
 * Verify the page is ready, apply stealth, and optionally set a custom user-agent.
 * Returns the user-agent override that was applied (if any) so callers can re-apply
 * it on later CDP sessions — script/UA overrides are scoped to the session that set
 * them and die when this bootstrap connection closes.
 */
export async function initTarget(
  targetWsUrl: string,
  userAgent?: string,
): Promise<string | undefined> {
  const conn = await CdpConnection.connect(targetWsUrl);
  try {
    const enables: Promise<unknown>[] = [conn.send("Page.enable"), conn.send("Runtime.enable")];
    enables.push(conn.send("Network.enable"));
    await Promise.all(enables);

    // Inject stealth patches before any page loads via Page.addScriptToEvaluateOnNewDocument
    await conn.send("Page.addScriptToEvaluateOnNewDocument", { source: STEALTH_SCRIPT });

    // Also run stealth on the current (about:blank) page
    await conn.send("Runtime.evaluate", {
      expression: STEALTH_SCRIPT,
      returnByValue: true,
    });

    await conn.send("Runtime.evaluate", {
      expression: "window.location.href",
      returnByValue: true,
      awaitPromise: true,
    });
    if (userAgent) {
      await conn.send("Network.setUserAgentOverride", { userAgent });
      return userAgent;
    }
    // Remove the "HeadlessChrome" identifier from the default user-agent
    try {
      const { userAgent: currentUA } = await conn.send<{ userAgent: string }>("Browser.getVersion");
      if (currentUA?.includes("HeadlessChrome")) {
        const cleanUA = currentUA.replace(/HeadlessChrome/g, "Chrome");
        await conn.send("Network.setUserAgentOverride", { userAgent: cleanUA });
        return cleanUA;
      }
    } catch {
      // Not critical — best effort
    }
    return undefined;
  } finally {
    conn.close();
  }
}

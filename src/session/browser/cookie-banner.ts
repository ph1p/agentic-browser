import { IN_PAGE_IS_VISIBLE } from "./in-page-helpers.js";
import { type FrameScope, evaluateOnPage } from "./page-eval.js";
import type { PageOps } from "./page-ops.js";
import type { DismissCookieBannerResult } from "./types.js";

/**
 * Best-effort cookie/consent banner dismissal.
 *
 * Strategy (in order):
 * 1. A11y tree scan — find buttons with consent-like accessible names
 * 2. CSS selector scan — check common consent framework IDs/classes
 * 3. Text-based scan — find visible buttons matching accept/agree patterns
 *
 * Returns silently on failure — never blocks navigation.
 */
export async function dismissCookieBanner(
  ctx: PageOps,
  targetWsUrl: string,
): Promise<DismissCookieBannerResult> {
  // Why each strategy failed — reported when nothing could be dismissed.
  const notes = new Set<string>();
  // Try up to 2 rounds — consent banners often load asynchronously.
  for (let attempt = 0; attempt < 2; attempt++) {
    // Strategy 1: Cheap DOM scan first for fast-path common consent banners.
    try {
      const domResult = await dismissViaDom(ctx, targetWsUrl);
      if (domResult.dismissed) return domResult;
    } catch (error) {
      notes.add(`dom: ${(error as Error).message}`);
    }

    // Strategy 2: Iframe-based consent banners (Sourcepoint, etc.), incl. cross-origin ones
    try {
      const iframeResult = await dismissViaIframe(ctx, targetWsUrl);
      if (iframeResult.dismissed) return iframeResult;
      if (iframeResult.detail) notes.add(iframeResult.detail);
    } catch (error) {
      notes.add(`iframe: ${(error as Error).message}`);
    }

    // Strategy 3: Use the accessibility tree when DOM heuristics miss.
    try {
      const a11yResult = await dismissViaA11y(ctx, targetWsUrl);
      if (a11yResult.dismissed) return a11yResult;
    } catch (error) {
      notes.add(`a11y: ${(error as Error).message}`);
    }

    // Wait 800ms before retrying to let async banners load
    if (attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }

  return {
    dismissed: false,
    detail: notes.size
      ? [...notes].join("; ")
      : "no consent banner found on the page, in consent iframes or the a11y tree (it may already be dismissed)",
  };
}

export async function dismissViaDom(
  ctx: PageOps,
  targetWsUrl: string,
): Promise<DismissCookieBannerResult> {
  const expression = `(() => {
${IN_PAGE_IS_VISIBLE}

    // Comprehensive CMP selectors (ordered by specificity/popularity)
    const selectors = [
      // OneTrust
      '#onetrust-accept-btn-handler',
      // Cookiebot
      '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
      '#CybotCookiebotDialogBodyButtonAccept',
      // Usercentrics
      '#uc-btn-accept-banner',
      '[data-testid="uc-accept-all-button"]',
      '.uc-btn-accept',
      // Didomi
      '#didomi-notice-agree-button',
      '.didomi-button[data-action="accept"]',
      '.didomi-components-button--color.didomi-button-highlight',
      // Quantcast / GDPR
      '.qc-cmp2-summary-buttons button[mode="primary"]',
      '.qc-cmp-button[data-action="accept"]',
      '#qc-cmp2-ui button.css-1litn2c',
      // TrustArc / TrueVault
      '#truste-consent-button',
      '.trustarc-agree-btn',
      '#consent_agree',
      // Consentmanager (zeit.de, etc.)
      '#cmpbox .cmpboxbtn.cmpboxbtnyes',
      '#cmpwelcomebtnyes a',
      '#cmpbntyestxt',
      '.cmpboxbtnyes',
      'a.cmpboxbtn.cmpboxbtnyes',
      // iubenda
      '.iubenda-cs-accept-btn',
      '#iubenda-cs-banner .iubenda-cs-accept-btn',
      // Klaro
      '.klaro .cm-btn-accept',
      '.klaro .cm-btn-success',
      // Osano
      '.osano-cm-accept-all',
      '.osano-cm-button--type_accept',
      // CookieYes / GDPR Cookie Consent
      '#cookie_action_close_header',
      '.cky-btn-accept',
      '[data-cky-tag="accept-button"]',
      // Termly
      '.t-acceptAllButton',
      '#termly-code-snippet-support .t-acceptAllButton',
      // Axeptio
      '#axeptio_btn_acceptAll',
      '[data-axeptio="accept"]',
      // Complianz / Really Simple Cookie Consent
      '.cmplz-accept',
      '#cmplz-cookiebanner-container .cmplz-accept',
      // CookieFirst
      '[data-cookiefirst-action="accept"]',
      // Cookie Notice / Cookie Law Info
      '#cookie_action_close_header_reject',
      '#cn-accept-cookie',
      // Borlabs Cookie (WordPress)
      '#CookieBoxSaveButton',
      'a[data-cookie-accept]',
      // Piwik PRO
      '#PiwikPROConsentForm-agree-to-all',
      '.PiwikPROConsentForm-agree-to-all-button',
      // Civic Cookie Control
      '#ccc-recommended-settings',
      '#ccc-dismiss-button',
      '.ccc-accept-settings',
      // Moove GDPR (WordPress)
      '.moove-gdpr-infobar-allow-all',
      '#moove_gdpr_cookie_modal .moove-gdpr-modal-allow-all',
      // CookieHub
      '.cookiehub-accept',
      '#cookiehub-accept-btn',
      '.ch2-btn-primary',
      // Cookie Script
      '#cookiescript_accept',
      '#cookiescript_injected .cookiescript_accept',
      // HubSpot Cookie Banner
      '#hs-eu-confirmation-button',
      '#hs-eu-cookie-confirmation .hs-eu-cta',
      // MediaVine
      '[data-name="mediavine-gdpr-cmp"] .pur-accept',
      // Sirdata
      '#sd-cmp .sd-cmp-JEaB',
      // Google Consent Mode / Funding Choices
      '.fc-cta-consent',
      '.fc-button-background[aria-label="Consent"]',
      // Generic selectors
      '#accept-cookies', '#acceptCookies',
      '#cookie-accept', '#cookieAccept',
      '#gdpr-accept', '#consent-accept',
      '#cookies-accept-all', '#accept-all-cookies',
      '.cc-accept', '.cc-btn.cc-dismiss',
      '.cookie-consent-accept', '.cookie-accept-btn',
      '.js-cookie-accept', '.js-accept-cookies',
      '.consent-accept', '.consent-btn-accept',
      '.gdpr-accept',
      '[data-testid="cookie-accept"]',
      '[data-action="accept-cookies"]',
      '[data-gdpr="accept"]',
      '[data-consent="accept"]',
    ];

    // Query selector in main DOM and open shadow roots
    function deepQuery(sel) {
      const el = document.querySelector(sel);
      if (el) return el;
      for (const host of document.querySelectorAll('*')) {
        if (host.shadowRoot) {
          const inner = host.shadowRoot.querySelector(sel);
          if (inner) return inner;
        }
      }
      return null;
    }

    for (const sel of selectors) {
      try {
        const el = deepQuery(sel);
        if (el && isVisible(el)) {
          el.click();
          return JSON.stringify({ dismissed: true, method: 'selector', detail: sel });
        }
      } catch { /* invalid selector — skip */ }
    }

    // Text-based fallback: find visible buttons with consent text
    // Patterns are intentionally loose — they use .* instead of strict ^/$ anchors
    const patterns = [
      // English
      /accept\\s*(all)?\\s*(cookies)?/i,
      /allow\\s*(all)?\\s*(cookies)?/i,
      /(i\\s+)?agree(\\s+to\\s+all)?/i,
      /got\\s*it/i,
      /^ok$/i,
      /^consent$/i,
      /continue\\s+without\\s+accepting/i,
      // German
      /(alle\\s+)?akzeptieren/i,
      /alle\\s+cookies\\s+akzeptieren/i,
      /(alle\\s+)?zustimmen/i,
      /einwilligen/i,
      /einverstanden/i,
      /alles\\s+erlauben/i,
      /alles\\s+akzeptieren/i,
      /geht\\s+klar/i,
      /verstanden/i,
      // French
      /(j')?accepte(r)?(\\s+tout)?/i,
      /(tout\\s+)?accepter/i,
      /autoriser/i,
      // Spanish
      /aceptar(\\s+todo)?/i,
      /aceptar\\s+cookies/i,
      // Italian
      /accett(a|o)(\\s+tutt[oi])?/i,
      /accetta\\s+cookies/i,
      // Dutch
      /(alle\\s+)?accepteren/i,
      /alles\\s+accepteren/i,
      // Portuguese
      /aceitar(\\s+tudo)?/i,
      /aceitar\\s+cookies/i,
      // Polish
      /akceptuj(\\s+wszystk[oi]e)?/i,
      /zgadzam\\s+si/i,
      // Swedish
      /acceptera(\\s+alla)?/i,
      // Danish
      /accepter(\\s+alle)?/i,
      // Norwegian
      /aksepter(\\s+alle)?/i,
    ];
    // Collect candidates from main DOM and open shadow roots
    function collectButtons(root) {
      const results = [];
      for (const tag of ['button', 'a[role="button"]', '[role="button"]', 'div[role="button"]', 'span[role="button"]']) {
        results.push(...root.querySelectorAll(tag));
      }
      // Traverse open shadow roots for CMPs that use web components
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) {
          results.push(...collectButtons(el.shadowRoot));
        }
      }
      return results;
    }
    // Only click buttons that live inside something that looks like a consent
    // banner: a dialog/modal, an element with consent-ish id/class, or a
    // fixed/sticky overlay — AND whose container text actually talks about
    // cookies/consent. Without this the loose text patterns above would click
    // arbitrary page buttons ("Accept invitation", "I agree" form submits).
    const containerTextPattern = /cookie|consent|privacy|gdpr|datenschutz|einwillig|zustimm|tracking|personal data|persönliche daten|données personnelles|datos personales/i;
    function findBannerContainer(el) {
      let node = el;
      let depth = 0;
      while (node && node.nodeType === 1 && depth < 20) {
        const role = (node.getAttribute('role') || '').toLowerCase();
        if (role === 'dialog' || role === 'alertdialog') return node;
        if (node.getAttribute('aria-modal') === 'true') return node;
        const idClass = (node.id + ' ' + (typeof node.className === 'string' ? node.className : '')).toLowerCase();
        if (/cookie|consent|gdpr|cmp|privacy|datenschutz/.test(idClass)) return node;
        const style = getComputedStyle(node);
        if (style.position === 'fixed' || style.position === 'sticky') return node;
        node = node.parentElement || (node.getRootNode && node.getRootNode().host) || null;
        depth++;
      }
      return null;
    }
    const candidates = collectButtons(document);
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const text = (el.textContent || '').trim();
      if (text.length > 60) continue;
      for (const pat of patterns) {
        if (pat.test(text)) {
          const container = findBannerContainer(el);
          if (!container) break;
          const containerText = (container.textContent || '').slice(0, 4000);
          if (!containerTextPattern.test(containerText)) break;
          el.click();
          return JSON.stringify({ dismissed: true, method: 'text', detail: text });
        }
      }
    }

    return JSON.stringify({ dismissed: false });
  })()`;

  return await ctx.withRetry(targetWsUrl, async (conn) => {
    await ctx.ensureEnabled(targetWsUrl);
    const result = await evaluateOnPage<string>(conn, {
      expression,
      returnByValue: true,
    });
    const raw = result.result.value ?? '{"dismissed":false}';
    try {
      return JSON.parse(raw) as DismissCookieBannerResult;
    } catch {
      return { dismissed: false };
    }
  });
}

/**
 * Handle iframe-based consent banners (Sourcepoint, some OneTrust configurations, etc.)
 * These banners render inside an iframe that needs to be accessed separately.
 */
export async function dismissViaIframe(
  ctx: PageOps,
  targetWsUrl: string,
): Promise<DismissCookieBannerResult> {
  // Clicks the accept button of the document it runs in; shared by both paths below.
  const innerSearch = `function (doc) {
    const innerSelectors = [
      // Sourcepoint specific
      'button.sp_choice_type_11',              // Accept all
      'button.sp_choice_type_ACCEPT_ALL',      // Accept all variant
      'button.sp_choice_type_SAVE_AND_EXIT',   // Save & exit
      '.priv-save-btn',                        // Sourcepoint frame
      '.message-button',                       // Generic Sourcepoint
      // Title-based
      'button[title*="Accept"]', 'button[title*="accept"]',
      'button[title*="Agree"]', 'button[title*="agree"]',
      'button[title*="Allow"]',
      'button[title*="Akzeptieren"]', 'button[title*="akzeptieren"]',
      'button[title*="Zustimmen"]',
    ];
    for (const innerSel of innerSelectors) {
      const btn = doc.querySelector(innerSel);
      if (btn && btn.offsetWidth > 0) {
        btn.click();
        return { method: 'iframe', detail: innerSel };
      }
    }
    // Text-based fallback inside the iframe
    const buttons = doc.querySelectorAll('button, [role="button"]');
    for (const btn of buttons) {
      const text = (btn.textContent || '').trim();
      if (text.length > 60) continue;
      if (/accept|agree|allow|akzeptieren|zustimmen|einwilligen|accepter|aceptar/i.test(text)) {
        btn.click();
        return { method: 'iframe-text', detail: text };
      }
    }
    return null;
  }`;

  const expression = `(() => {
    const clickAccept = ${innerSearch};
    // Known consent iframe selectors
    const iframeSelectors = [
      'iframe[id^="sp_message_iframe"]',              // Sourcepoint (dynamic ID suffix)
      '#sp_message_iframe',                        // Sourcepoint (static ID)
      'iframe[id*="sp_message"]',                  // Sourcepoint variants
      'div[id^="sp_message_container"] iframe',    // Sourcepoint container with iframe
      'iframe[title*="cookie"]',                   // Generic cookie iframes
      'iframe[title*="consent"]',                  // Generic consent iframes
      'iframe[title*="Cookie"]',
      'iframe[title*="Consent"]',
      'iframe[title*="Privacy"]',
      'iframe[title*="privacy"]',
      'iframe[title*="GDPR"]',
      'iframe[src*="consent"]',
      'iframe[src*="cookie"]',
      'iframe[src*="privacy"]',
      'iframe[src*="sourcepoint"]',
      'iframe[src*="consentmanager"]',
    ];

    // Consent prompts overlay the page: the frame or a close ancestor is
    // fixed/sticky or stacked high. In-flow frames (ads, embeds) are skipped.
    function isOverlay(iframe) {
      let el = iframe;
      for (let depth = 0; el && el !== document.body && depth < 10; depth++) {
        const style = getComputedStyle(el);
        if (style.position === 'fixed' || style.position === 'sticky') return true;
        if ((parseInt(style.zIndex, 10) || 0) >= 1000) return true;
        el = el.parentElement;
      }
      return false;
    }
    function isShown(iframe) {
      const rect = iframe.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return false;
      const style = getComputedStyle(iframe);
      return style.display !== 'none' && style.visibility !== 'hidden';
    }
    // A src keyword must sit in host or path: ad and tracking frames often
    // carry "cookie=" or "privacy=" in their query string.
    function srcKeywordMatches(iframe, sel) {
      const prefix = 'iframe[src*="';
      if (!sel.startsWith(prefix)) return true;
      const keyword = sel.slice(prefix.length, sel.indexOf('"', prefix.length));
      try {
        const url = new URL(iframe.src, location.href);
        return (url.hostname + url.pathname).toLowerCase().includes(keyword);
      } catch {
        return false;
      }
    }
    function findFrame(sel) {
      for (const iframe of document.querySelectorAll(sel)) {
        if (!isShown(iframe) || !srcKeywordMatches(iframe, sel) || !isOverlay(iframe)) continue;
        return iframe;
      }
      return null;
    }

    // Cross-origin consent frames are handed back so the caller can attach to them.
    const crossOrigin = [];
    for (const sel of iframeSelectors) {
      const iframe = findFrame(sel);
      if (!iframe) continue;
      let doc = null;
      try {
        doc = iframe.contentDocument || iframe.contentWindow?.document || null;
      } catch {
        doc = null;
      }
      if (!doc) {
        const locator = iframe.id ? '#' + CSS.escape(iframe.id) : sel;
        if (!crossOrigin.includes(locator)) crossOrigin.push(locator);
        continue;
      }
      const hit = clickAccept(doc);
      if (hit) return { dismissed: true, method: hit.method, detail: sel + ' > ' + hit.detail };
    }
    return { dismissed: false, crossOrigin };
  })()`;

  return await ctx.withRetry(targetWsUrl, async (conn) => {
    await ctx.ensureEnabled(targetWsUrl);
    const result = await evaluateOnPage<{
      dismissed: boolean;
      method?: "iframe" | "iframe-text";
      detail?: string;
      crossOrigin?: string[];
    }>(conn, { expression, returnByValue: true });
    const value = result.result.value;
    if (!value) return { dismissed: false };
    if (value.dismissed) return { dismissed: true, method: value.method, detail: value.detail };

    const notes: string[] = [];
    for (const frame of value.crossOrigin ?? []) {
      let scope: FrameScope;
      try {
        scope = await ctx.openFrameScope(conn, targetWsUrl, frame);
      } catch (error) {
        notes.push(`consent iframe ${frame}: ${(error as Error).message}`);
        continue;
      }
      try {
        const inner = await evaluateOnPage<{
          method: "iframe" | "iframe-text";
          detail: string;
        } | null>(scope.client, {
          expression: `(${innerSearch})(document)`,
          returnByValue: true,
        });
        const hit = inner.result.value;
        if (hit) {
          return { dismissed: true, method: hit.method, detail: `${frame} >>> ${hit.detail}` };
        }
        notes.push(`consent iframe ${frame}: no accept button found`);
      } catch (error) {
        notes.push(`consent iframe ${frame}: ${(error as Error).message}`);
      } finally {
        scope.release();
      }
    }
    return notes.length ? { dismissed: false, detail: notes.join("; ") } : { dismissed: false };
  });
}

/**
 * Use the CDP Accessibility tree to find and click consent buttons.
 * This works even when consent banners use shadow DOM or obfuscated class names.
 * Also queries cross-origin iframe frames via Page.getFrameTree for Sourcepoint etc.
 */
export async function dismissViaA11y(
  ctx: PageOps,
  targetWsUrl: string,
): Promise<DismissCookieBannerResult> {
  return await ctx.withRetry(targetWsUrl, async (conn) => {
    await conn.send("Accessibility.enable");
    await conn.send("Page.enable");

    type AXNode = {
      nodeId: string;
      parentId?: string;
      backendDOMNodeId?: number;
      role?: { value: string };
      name?: { value: string };
      properties?: Array<{ name: string; value: { value: unknown } }>;
      ignored?: boolean;
    };

    // Collect a11y nodes from the main frame
    const { nodes } = await conn.send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree");

    // Node sets by origin. Nodes from consent-related iframe URLs are trusted
    // (the whole frame is a CMP); main-frame/about:blank nodes must additionally
    // sit under a dialog/consent-named ancestor before we click anything.
    const nodeSets: Array<{ nodes: AXNode[]; trusted: boolean }> = [{ nodes, trusted: false }];
    try {
      const { frameTree } = await conn.send<{
        frameTree: {
          frame: { id: string };
          childFrames?: Array<{ frame: { id: string; url?: string } }>;
        };
      }>("Page.getFrameTree");
      for (const child of frameTree.childFrames ?? []) {
        const url = child.frame.url ?? "";
        const consentFrame =
          /consent|cookie|privacy|sourcepoint|didomi|cmp|gdpr|trustarc|consentmanager|sp_message|onetrust|usercentrics|consent-cdn/i.test(
            url,
          );
        // Only query frames that look consent-related
        if (consentFrame || url === "about:blank") {
          try {
            const frameResult = await conn.send<{ nodes: AXNode[] }>(
              "Accessibility.getFullAXTree",
              { frameId: child.frame.id },
            );
            nodeSets.push({ nodes: frameResult.nodes, trusted: consentFrame });
          } catch {
            // frame may have been destroyed — skip
          }
        }
      }
    } catch {
      // Page.getFrameTree failed — proceed with main frame only
    }

    // Consent-related name patterns (EN, DE, FR, ES, IT, NL, PT, PL, SV, DA, NO)
    const consentPatterns = [
      // English
      /accept\s*(all)?\s*(cookies)?/i,
      /allow\s*(all)?\s*(cookies)?/i,
      /(i\s+)?agree(\s+to\s+all)?/i,
      /got\s*it/i,
      /^ok$/i,
      /^consent$/i,
      // German
      /(alle\s+)?akzeptieren/i,
      /alle\s+cookies\s+akzeptieren/i,
      /(alle\s+)?zustimmen/i,
      /einwilligen/i,
      /einverstanden/i,
      /alles\s+erlauben/i,
      /alles\s+akzeptieren/i,
      /geht\s+klar/i,
      /verstanden/i,
      // French
      /(j')?accepte(r)?(\s+tout)?/i,
      /(tout\s+)?accepter/i,
      /autoriser/i,
      // Spanish
      /aceptar(\s+todo)?/i,
      /aceptar\s+cookies/i,
      // Italian
      /accett(a|o)(\s+tutt[oi])?/i,
      /accetta\s+cookies/i,
      // Dutch
      /(alle\s+)?accepteren/i,
      /alles\s+accepteren/i,
      // Portuguese
      /aceitar(\s+tudo)?/i,
      /aceitar\s+cookies/i,
      // Polish
      /akceptuj(\s+wszystk[oi]e)?/i,
      /zgadzam\s+si/i,
      // Swedish
      /acceptera(\s+alla)?/i,
      // Danish
      /accepter(\s+alle)?/i,
      // Norwegian
      /aksepter(\s+alle)?/i,
    ];

    // Ancestor gate for untrusted node sets: the candidate must sit under a
    // dialog/alertdialog or an ancestor whose accessible name mentions
    // cookies/consent — otherwise the loose name patterns would click
    // arbitrary page buttons ("Accept invitation", "I agree" form submits).
    const consentAncestorName = /cookie|consent|privacy|gdpr|datenschutz|einwillig|zustimm/i;
    const hasConsentAncestor = (byId: Map<string, AXNode>, node: AXNode): boolean => {
      let current: AXNode | undefined = node.parentId ? byId.get(node.parentId) : undefined;
      let depth = 0;
      while (current && depth < 50) {
        const role = current.role?.value;
        if (role === "dialog" || role === "alertdialog") return true;
        const name = current.name?.value;
        if (name && consentAncestorName.test(name)) return true;
        current = current.parentId ? byId.get(current.parentId) : undefined;
        depth++;
      }
      return false;
    };

    // Find button/link nodes whose accessible name matches consent patterns
    const candidates: Array<{ nodeId: string; backendDOMNodeId: number; name: string }> = [];
    for (const { nodes: setNodes, trusted } of nodeSets) {
      const byId = new Map<string, AXNode>(setNodes.map((n) => [n.nodeId, n]));
      for (const node of setNodes) {
        if (node.ignored) continue;
        const role = node.role?.value;
        if (role !== "button" && role !== "link") continue;
        const name = node.name?.value?.trim();
        if (!name || name.length > 50) continue;

        // Check if the button is focusable/not disabled
        const isDisabled = node.properties?.some(
          (p) => p.name === "disabled" && p.value.value === true,
        );
        if (isDisabled) continue;

        for (const pat of consentPatterns) {
          if (pat.test(name) && node.backendDOMNodeId) {
            if (trusted || hasConsentAncestor(byId, node)) {
              candidates.push({
                nodeId: node.nodeId,
                backendDOMNodeId: node.backendDOMNodeId,
                name,
              });
            }
            break;
          }
        }
      }
    }

    if (candidates.length === 0) {
      return { dismissed: false };
    }

    // Click the first matching candidate via CDP DOM.focus + Runtime.evaluate
    const target = candidates[0];
    try {
      // Resolve the DOM node to get a JS object reference
      const { object } = await conn.send<{ object: { objectId?: string } }>("DOM.resolveNode", {
        backendNodeId: target.backendDOMNodeId,
      });
      if (object?.objectId) {
        // Call click() on the resolved object
        await conn.send("Runtime.callFunctionOn", {
          objectId: object.objectId,
          functionDeclaration: "function() { this.click(); }",
          returnByValue: true,
        });
        return { dismissed: true, method: "a11y" as const, detail: target.name };
      }
    } catch {
      // If DOM.resolveNode fails, try clicking via JS selector fallback
    }

    return { dismissed: false };
  });
}

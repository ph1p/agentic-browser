import { applyContentLimit } from "./content-limit.js";
import type {
  BrowserController,
  DismissCookieBannerResult,
  InteractPayload,
  InteractiveElementsOptions,
  InteractiveElementsResult,
  LaunchOptions,
  PageContentOptions,
  PageContentResult,
  PageState,
  ScreenshotOptions,
  ScreenshotResult,
  TabInfo,
} from "./types.js";

export class MockBrowserController implements BrowserController {
  private readonly pages = new Map<
    string,
    { url: string; title: string; text: string; html: string }
  >();

  async launch(
    sessionId: string,
    _options?: LaunchOptions,
  ): Promise<{ pid: number; cdpUrl: string; targetWsUrl: string }> {
    const cdpUrl = `mock://${sessionId}`;
    const targetWsUrl = cdpUrl;
    this.pages.set(cdpUrl, {
      url: "about:blank",
      title: "about:blank",
      text: "",
      html: "<html><body></body></html>",
    });
    return { pid: 1, cdpUrl, targetWsUrl };
  }

  async connect(
    cdpUrl: string,
    _options?: { userAgent?: string },
  ): Promise<{ pid: number; cdpUrl: string; targetWsUrl: string }> {
    this.pages.set(cdpUrl, {
      url: "about:blank",
      title: "about:blank",
      text: "",
      html: "<html><body></body></html>",
    });
    return { pid: 0, cdpUrl, targetWsUrl: cdpUrl };
  }

  async navigate(cdpUrl: string, url: string): Promise<string> {
    const page = this.pages.get(cdpUrl);
    if (!page) throw new Error("mock page missing");
    page.url = url;
    page.title = url;
    page.text = `Content of ${url}`;
    page.html = `<html><body>${page.text}</body></html>`;
    // Track navigation history for goBack/goForward
    this.history.splice(this.historyIndex + 1);
    this.history.push(url);
    this.historyIndex = this.history.length - 1;
    return url;
  }

  private readonly history: string[] = [];
  private historyIndex = -1;

  async interact(cdpUrl: string, payload: InteractPayload): Promise<string> {
    if (payload.action === "goBack") {
      if (this.historyIndex <= 0) return "no history to go back";
      this.historyIndex--;
      const page = this.pages.get(cdpUrl);
      if (page) page.url = this.history[this.historyIndex] ?? page.url;
      return `navigated back to ${page?.url ?? "previous page"}`;
    }
    if (payload.action === "goForward") {
      if (this.historyIndex >= this.history.length - 1) return "no history to go forward";
      this.historyIndex++;
      const page = this.pages.get(cdpUrl);
      if (page) page.url = this.history[this.historyIndex] ?? page.url;
      return `navigated forward to ${page?.url ?? "next page"}`;
    }
    if (payload.action === "refresh") return "page refreshed";
    if (payload.action === "dialog") {
      const dismiss = payload.text === "dismiss";
      return dismiss ? "dismissed confirm: mock dialog" : "accepted confirm: mock dialog";
    }
    return `interacted:${payload.action}`;
  }

  async screenshot(_targetWsUrl: string, options?: ScreenshotOptions): Promise<ScreenshotResult> {
    const format = options?.format ?? "jpeg";
    return {
      data: "bW9jaw==",
      mimeType: format === "png" ? "image/png" : "image/jpeg",
    };
  }

  async getCurrentUrl(cdpUrl: string): Promise<string> {
    const page = this.pages.get(cdpUrl);
    return page?.url ?? "about:blank";
  }

  private readonly tabs = new Map<string, string[]>();
  private tabCounter = 0;

  /** Tab ids are the page keys (targetWsUrl); the initial page is the cdpUrl itself. */
  private tabIds(cdpUrl: string): string[] {
    let ids = this.tabs.get(cdpUrl);
    if (!ids) {
      ids = this.pages.has(cdpUrl) ? [cdpUrl] : [];
      this.tabs.set(cdpUrl, ids);
    }
    return ids;
  }

  async getPageState(targetWsUrl: string): Promise<PageState> {
    const page = this.pages.get(targetWsUrl);
    if (!page) throw new Error("mock page missing");
    return { url: page.url, title: page.title, readyState: "complete" };
  }

  async listTabs(cdpUrl: string): Promise<TabInfo[]> {
    return this.tabIds(cdpUrl).map((id) => {
      const page = this.pages.get(id);
      return { id, url: page?.url ?? "about:blank", title: page?.title ?? "", targetWsUrl: id };
    });
  }

  async openTab(cdpUrl: string): Promise<TabInfo> {
    this.tabCounter += 1;
    const id = `${cdpUrl}/tab-${this.tabCounter}`;
    this.pages.set(id, {
      url: "about:blank",
      title: "about:blank",
      text: "",
      html: "<html><body></body></html>",
    });
    this.tabIds(cdpUrl).push(id);
    return { id, url: "about:blank", title: "about:blank", targetWsUrl: id };
  }

  async activateTab(cdpUrl: string, tabId: string): Promise<void> {
    if (!this.tabIds(cdpUrl).includes(tabId)) throw new Error(`Tab not found: ${tabId}`);
  }

  async closeTab(cdpUrl: string, tabId: string): Promise<void> {
    const ids = this.tabIds(cdpUrl);
    const index = ids.indexOf(tabId);
    if (index === -1) throw new Error(`Tab not found: ${tabId}`);
    ids.splice(index, 1);
    this.pages.delete(tabId);
  }

  async getContent(cdpUrl: string, options: PageContentOptions): Promise<PageContentResult> {
    const page = this.pages.get(cdpUrl);
    if (!page) throw new Error("mock page missing");
    if (options.mode === "summary") {
      return {
        mode: "summary",
        content: "",
        structuredContent: {
          mode: "summary",
          url: page.url,
          title: page.title,
          headings: [page.title],
          landmarks: [],
          alerts: [],
          frames: [],
          primaryActions: [],
          inputs: [],
          totalInteractiveElements: 0,
          truncatedInteractiveElements: false,
        },
      };
    }

    const raw =
      options.mode === "title" ? page.title : options.mode === "html" ? page.html : page.text;
    const limited = applyContentLimit(raw, options.maxChars);
    return {
      mode: options.mode,
      content: limited.content,
      truncated: limited.truncated || undefined,
      originalLength: limited.originalLength,
    };
  }

  async getInteractiveElements(
    _targetWsUrl: string,
    _options: InteractiveElementsOptions,
  ): Promise<InteractiveElementsResult> {
    return { elements: [], totalFound: 0, truncated: false };
  }

  async dismissCookieBanner(_targetWsUrl: string): Promise<DismissCookieBannerResult> {
    return { dismissed: false };
  }

  terminate(_pid: number): void {}

  closeConnection(_targetWsUrl: string): void {}
}

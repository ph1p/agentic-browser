export type InteractAction =
  | "click"
  | "type"
  | "press"
  | "waitFor"
  | "evaluate"
  | "scroll"
  | "hover"
  | "select"
  | "toggle"
  | "goBack"
  | "goForward"
  | "refresh"
  | "dialog";

export interface InteractPayload {
  action: InteractAction;
  selector?: string;
  fallbackSelectors?: string[];
  text?: string;
  key?: string;
  value?: string;
  scrollX?: number;
  scrollY?: number;
  timeoutMs?: number;
  /**
   * Locator of an iframe to run the action in. Needed for cross-origin frames,
   * which `>>>` cannot pierce from the page. Composed selectors like
   * `iframe#consent >>> button` are split automatically when the frame is
   * cross-origin, so this is only required for explicit control.
   */
  frame?: string;
}

export type PageContentMode = "title" | "text" | "html" | "a11y" | "summary";

export interface PageContentOptions {
  mode: PageContentMode;
  selector?: string;
  maxChars?: number;
}

export interface PageContentResult {
  mode: PageContentMode;
  content: string;
  truncated?: boolean;
  originalLength?: number;
  structuredContent?: Record<string, unknown>;
}

export const INTERACTIVE_ELEMENT_ROLES = [
  "link",
  "button",
  "input",
  "select",
  "textarea",
  "checkbox",
  "radio",
  "contenteditable",
  "custom",
] as const;

export type InteractiveElementRole = (typeof INTERACTIVE_ELEMENT_ROLES)[number];

export type ElementAction = "click" | "type" | "select" | "toggle" | "press";

export interface InteractiveElement {
  selector: string;
  fallbackSelectors?: string[];
  role: InteractiveElementRole;
  tagName: string;
  text: string;
  actions: ElementAction[];
  visible: boolean;
  enabled: boolean;
  href?: string;
  inputType?: string;
  ariaLabel?: string;
  placeholder?: string;
  currentValue?: string;
  /** Short handle ("e3") usable in place of the selector until the page changes. */
  ref?: string;
}

export interface InteractiveElementsOptions {
  roles?: InteractiveElementRole[];
  visibleOnly?: boolean;
  limit?: number;
  selector?: string;
  /** Case-insensitive substring filter on the element's href. */
  href?: string;
  /** Case-insensitive substring filter on text, aria-label, placeholder, value or title. */
  text?: string;
  /** Discover elements inside this iframe (works for cross-origin frames). */
  frame?: string;
}

/** An iframe whose content discovery could not enter from the page context. */
export interface CrossOriginFrameInfo {
  selector: string;
  title?: string;
  src?: string;
}

export interface InteractiveElementsResult {
  elements: InteractiveElement[];
  totalFound: number;
  truncated: boolean;
  /** Cross-origin iframes skipped by discovery — pass one as `frame` to look inside. */
  crossOriginFrames?: CrossOriginFrameInfo[];
}

export interface PageState {
  url: string;
  title: string;
  readyState: string;
}

export interface TabInfo {
  id: string;
  url: string;
  title: string;
  targetWsUrl: string;
}

export interface LaunchOptions {
  executablePath?: string;
  userProfileDir?: string;
  headless?: boolean;
  userAgent?: string;
}

export interface DismissCookieBannerResult {
  dismissed: boolean;
  method?: "a11y" | "selector" | "text" | "iframe" | "iframe-text";
  detail?: string;
}

export type ErrorCode =
  | "SELECTOR_NOT_FOUND"
  | "ELEMENT_COVERED"
  | "ELEMENT_NOT_EDITABLE"
  | "NAVIGATION_TIMEOUT"
  | "NAVIGATION_FAILED"
  | "CDP_DISCONNECTED"
  | "SESSION_DEAD"
  | "DIALOG_BLOCKING"
  | "TIMEOUT"
  | "UNKNOWN";

export interface ScreenshotOptions {
  format?: "jpeg" | "png";
  quality?: number;
  fullPage?: boolean;
}

export interface ScreenshotResult {
  data: string;
  mimeType: string;
}

export interface BrowserController {
  launch(
    sessionId: string,
    options?: LaunchOptions,
  ): Promise<{ pid: number; cdpUrl: string; targetWsUrl: string }>;
  connect(
    cdpUrl: string,
    options?: { userAgent?: string },
  ): Promise<{ pid: number; cdpUrl: string; targetWsUrl: string }>;
  navigate(targetWsUrl: string, url: string): Promise<string>;
  interact(targetWsUrl: string, payload: InteractPayload): Promise<string>;
  getContent(targetWsUrl: string, options: PageContentOptions): Promise<PageContentResult>;
  getInteractiveElements(
    targetWsUrl: string,
    options: InteractiveElementsOptions,
  ): Promise<InteractiveElementsResult>;
  dismissCookieBanner(targetWsUrl: string): Promise<DismissCookieBannerResult>;
  screenshot(targetWsUrl: string, options?: ScreenshotOptions): Promise<ScreenshotResult>;
  getCurrentUrl(targetWsUrl: string): Promise<string>;
  getPageState(targetWsUrl: string): Promise<PageState>;
  listTabs(cdpUrl: string): Promise<TabInfo[]>;
  openTab(cdpUrl: string): Promise<TabInfo>;
  activateTab(cdpUrl: string, tabId: string): Promise<void>;
  closeTab(cdpUrl: string, tabId: string): Promise<void>;
  terminate(pid: number): void;
  closeConnection?(targetWsUrl: string): void;
  dispose?(): void;
}

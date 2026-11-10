// Public entry point for the browser layer; implementation lives in ./browser/.
export * from "./browser/types.js";
export { CdpConnection } from "./browser/cdp-connection.js";
export { isProfileLocked } from "./browser/chrome-process.js";
export { ChromeCdpBrowserController, isConnectionError } from "./browser/chrome-controller.js";
export { MockBrowserController } from "./browser/mock-browser-controller.js";

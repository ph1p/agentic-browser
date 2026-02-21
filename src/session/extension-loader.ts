import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ExtensionLoadResult {
  extensionPath: string;
  loadedAt: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadControlExtension(): ExtensionLoadResult {
  // Resolve relative to the package root, not cwd().
  // In the built output this file is at dist/session/extension-loader.mjs (or similar chunk),
  // but tsdown bundles everything into dist/ — so we go up from dist/ to the package root.
  const packageRoot = path.resolve(__dirname, "..");
  return {
    extensionPath: path.resolve(packageRoot, "extension"),
    loadedAt: new Date().toISOString(),
  };
}

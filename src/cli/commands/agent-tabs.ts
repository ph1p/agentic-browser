import type { Runtime } from "../runtime.js";
import { requireSessionId, ensureReady, agentNavigate } from "./agent-core.js";

/** Accepts a full tab id or a unique prefix of one. */
export async function resolveTabId(runtime: Runtime, sessionId: string, idOrPrefix: string) {
  const tabs = await runtime.api.listTabs(sessionId);
  const exact = tabs.find((tab) => tab.id === idOrPrefix);
  if (exact) return exact.id;
  const matches = tabs.filter((tab) => tab.id.startsWith(idOrPrefix));
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length > 1) throw new Error(`Ambiguous tab id prefix: ${idOrPrefix}`);
  throw new Error(`Tab not found: ${idOrPrefix}`);
}

export async function agentTabs(runtime: Runtime) {
  const sessionId = requireSessionId(runtime);
  await ensureReady(runtime, sessionId);
  const tabs = await runtime.api.listTabs(sessionId);
  return {
    ok: true,
    action: "tabs",
    sessionId,
    tabs: tabs.map(({ id, url, title, active }) => ({ id, url, title, active })),
  };
}

export async function agentTabSwitch(runtime: Runtime, input: { id: string }) {
  const sessionId = requireSessionId(runtime);
  await ensureReady(runtime, sessionId);
  const tab = await runtime.api.switchTab(
    sessionId,
    await resolveTabId(runtime, sessionId, input.id),
  );
  return { ok: true, action: "tab", sessionId, id: tab.id, url: tab.url, title: tab.title };
}

export async function agentTabNew(runtime: Runtime, input: { url?: string }) {
  const sessionId = requireSessionId(runtime);
  await ensureReady(runtime, sessionId);
  const tab = await runtime.api.newTab(sessionId);
  if (!input.url) {
    return { ok: true, action: "tab-new", sessionId, id: tab.id, url: tab.url };
  }
  const navigated = await agentNavigate(runtime, { url: input.url });
  return { ...navigated, action: "tab-new", id: tab.id };
}

export async function agentTabClose(runtime: Runtime, input: { id: string }) {
  const sessionId = requireSessionId(runtime);
  await ensureReady(runtime, sessionId);
  const result = await runtime.api.closeTab(
    sessionId,
    await resolveTabId(runtime, sessionId, input.id),
  );
  return {
    ok: true,
    action: "tab-close",
    sessionId,
    closed: result.closed,
    active: { id: result.active.id, url: result.active.url, title: result.active.title },
  };
}

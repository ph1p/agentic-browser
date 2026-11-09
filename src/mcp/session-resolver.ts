export interface SessionResolver {
  resolve(sessionId?: string): Promise<string>;
  current(): string | undefined;
  set(sessionId: string): void;
  clear(): void;
}

/**
 * Tracks the active session and auto-starts one on demand. Concurrent callers
 * share a single in-flight start so only one session is launched.
 */
export function createSessionResolver(
  start: () => Promise<{ sessionId: string }>,
): SessionResolver {
  let activeSessionId: string | undefined;
  let pendingSession: Promise<string> | undefined;

  return {
    async resolve(sessionId?: string) {
      if (sessionId) return sessionId;
      if (activeSessionId) return activeSessionId;
      if (pendingSession) return pendingSession;

      const p = (async () => {
        const session = await start();
        activeSessionId = session.sessionId;
        return session.sessionId;
      })();
      pendingSession = p;
      try {
        return await p;
      } finally {
        pendingSession = undefined;
      }
    },
    current: () => activeSessionId,
    set(sessionId) {
      activeSessionId = sessionId;
    },
    clear() {
      activeSessionId = undefined;
    },
  };
}

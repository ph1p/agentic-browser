export interface Flushable {
  flushSync(): void;
}

const REGISTRY = Symbol.for("agentic-browser.flush-registry");

interface Registry {
  items: Set<Flushable>;
  onExit: () => void;
  onSigint: () => void;
  onSigterm: () => void;
}

interface ProcessWithFlushRegistry extends NodeJS.Process {
  [REGISTRY]?: Registry;
}

function flushAll(items: Set<Flushable>): void {
  for (const item of items) {
    try {
      item.flushSync();
    } catch {
      // one failing store must not stop the others or crash the exit path
    }
  }
}

function createRegistry(): Registry {
  const items = new Set<Flushable>();
  const onSignal = (signal: NodeJS.Signals) => {
    flushAll(items);
    // Only force exit when no other handler wants to decide shutdown.
    if (process.listenerCount(signal) === 1) {
      process.exit(0);
    }
  };
  return {
    items,
    onExit: () => flushAll(items),
    onSigint: () => onSignal("SIGINT"),
    onSigterm: () => onSignal("SIGTERM"),
  };
}

/**
 * Register an item to be flushed synchronously on process exit / SIGINT / SIGTERM.
 * Returns an idempotent unregister function; the process listeners are removed
 * once the last item is unregistered.
 */
export function registerFlushable(item: Flushable): () => void {
  const proc = process as ProcessWithFlushRegistry;
  let registry = proc[REGISTRY];
  if (!registry) {
    registry = createRegistry();
    proc[REGISTRY] = registry;
    process.on("exit", registry.onExit);
    process.on("SIGINT", registry.onSigint);
    process.on("SIGTERM", registry.onSigterm);
  }
  registry.items.add(item);

  const owner = registry;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    owner.items.delete(item);
    if (owner.items.size === 0 && proc[REGISTRY] === owner) {
      process.off("exit", owner.onExit);
      process.off("SIGINT", owner.onSigint);
      process.off("SIGTERM", owner.onSigterm);
      delete proc[REGISTRY];
    }
  };
}

/** Number of registered flushables (for tests). */
export function flushRegistrySize(): number {
  return (process as ProcessWithFlushRegistry)[REGISTRY]?.items.size ?? 0;
}

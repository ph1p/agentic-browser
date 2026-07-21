import { loadConfig } from "../lib/config.js";
import { Logger } from "../observability/logger.js";
import { EventStore } from "../observability/event-store.js";
import { SessionTokenService } from "../auth/session-token.js";
import { MemoryService } from "../memory/memory-service.js";

export interface AppContext {
  config: ReturnType<typeof loadConfig>;
  logger: Logger;
  eventStore: EventStore;
  tokenService: SessionTokenService;
  memoryService: MemoryService;
}

export function createAppContext(env: NodeJS.ProcessEnv = process.env): AppContext {
  const config = loadConfig(env);
  const logger = new Logger("app");
  const eventStore = new EventStore(config.dataDir);
  const tokenService = new SessionTokenService();
  const memoryService = new MemoryService(config.dataDir);

  return { config, logger, eventStore, tokenService, memoryService };
}

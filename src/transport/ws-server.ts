import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

import { Logger } from "../observability/logger.js";
import { SessionTokenService } from "../auth/session-token.js";

interface WsServerOptions {
  host: string;
  port: number;
  tokenService: SessionTokenService;
}

export class AuthenticatedWsServer {
  private readonly logger = new Logger("ws-server");
  private server?: WebSocketServer;

  constructor(private readonly options: WsServerOptions) {}

  start(onMessage: (socket: WebSocket, data: unknown) => void): void {
    this.server = new WebSocketServer({ host: this.options.host, port: this.options.port });
    this.server.on("connection", (socket: WebSocket, request: IncomingMessage) => {
      const url = new URL(request.url ?? "/", `http://${this.options.host}:${this.options.port}`);
      const sessionId = url.searchParams.get("sessionId");
      const token = url.searchParams.get("token");
      if (!sessionId || !token || !this.options.tokenService.validate(sessionId, token)) {
        this.logger.warning("Rejected websocket client", { sessionId });
        socket.close(4401, "Unauthorized");
        return;
      }

      socket.on("message", (payload: Buffer) => onMessage(socket, payload.toString("utf8")));
    });

    this.logger.info("WebSocket server started", {
      host: this.options.host,
      port: this.options.port,
    });
  }

  stop(): void {
    this.server?.close();
    this.server = undefined;
  }
}

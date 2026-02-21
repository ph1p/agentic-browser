import type { Command, ResultStatus, SessionStatus } from "../lib/domain-schemas.js";

export interface DispatchResult {
  resultStatus: ResultStatus;
  resultMessage: string;
  completedAt: string;
}

export class CommandDispatcher {
  dispatch(command: Command, sessionStatus: SessionStatus): DispatchResult {
    if (sessionStatus !== "ready") {
      const guidance =
        sessionStatus === "disconnected" || sessionStatus === "failed"
          ? "Session disconnected. Run session restart."
          : sessionStatus === "terminated"
            ? "Session terminated. Run session start."
            : "Session not ready yet. Wait for ready state.";
      return {
        resultStatus: "failed",
        resultMessage: guidance,
        completedAt: new Date().toISOString(),
      };
    }

    if (command.type === "navigate" && typeof command.payload.url === "string") {
      return {
        resultStatus: "success",
        resultMessage: `Navigated to ${command.payload.url}`,
        completedAt: new Date().toISOString(),
      };
    }

    return {
      resultStatus: "success",
      resultMessage: `Executed command ${command.type}`,
      completedAt: new Date().toISOString(),
    };
  }
}

import type { Runtime } from "../runtime.js";
import type { CommandType } from "../../lib/domain-schemas.js";

export async function runCommand(
  runtime: Runtime,
  input: {
    sessionId: string;
    commandId: string;
    type: CommandType;
    payload: Record<string, unknown>;
  },
) {
  if (!input.sessionId) {
    throw new Error("No active session. Start or restart a session first.");
  }
  try {
    return await runtime.api.executeCommand(input.sessionId, {
      commandId: input.commandId,
      type: input.type,
      payload: input.payload,
    });
  } catch (error) {
    throw new Error(`Command rejected: ${(error as Error).message}`);
  }
}

import { z } from "zod";

export const SessionStatusSchema = z.enum([
  "starting",
  "ready",
  "disconnected",
  "failed",
  "terminated",
]);

export const CommandTypeSchema = z.enum(["navigate", "interact", "restart", "terminate"]);
export const ResultStatusSchema = z.enum(["success", "failed", "timed_out"]);
export const ConnectionStateSchema = z.enum(["connecting", "ready", "disconnected", "failed"]);
export const EventCategorySchema = z.enum(["lifecycle", "security", "command"]);
export const EventSeveritySchema = z.enum(["info", "warning", "error"]);

export const SessionSchema = z
  .object({
    sessionId: z.string().min(1),
    status: SessionStatusSchema,
    browserType: z.literal("chrome"),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime().optional(),
    authTokenRef: z.string().min(1),
  })
  .refine(
    (session: { status: string; endedAt?: string }) =>
      session.status === "terminated" ? Boolean(session.endedAt) : true,
    {
      message: "endedAt is required for terminated sessions",
      path: ["endedAt"],
    },
  );

export const CommandSchema = z
  .object({
    commandId: z.string().min(1),
    sessionId: z.string().min(1),
    type: CommandTypeSchema,
    payload: z.record(z.string(), z.unknown()),
    submittedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
    resultStatus: ResultStatusSchema.optional(),
    resultMessage: z.string().optional(),
  })
  .refine(
    (command: { completedAt?: string; resultStatus?: string }) =>
      command.completedAt ? Boolean(command.resultStatus) : true,
    {
      message: "resultStatus is required when completedAt is set",
      path: ["resultStatus"],
    },
  );

export const ConnectionStateRecordSchema = z.object({
  sessionId: z.string().min(1),
  state: ConnectionStateSchema,
  lastHeartbeatAt: z.string().datetime().optional(),
  disconnectReason: z.string().optional(),
});

export const AuthorizationContextSchema = z.object({
  sessionId: z.string().min(1),
  tokenId: z.string().min(1),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
  revokedAt: z.string().datetime().optional(),
});

export const SessionEventSchema = z.object({
  eventId: z.string().min(1),
  sessionId: z.string().min(1),
  category: EventCategorySchema,
  message: z.string().min(1),
  createdAt: z.string().datetime(),
  severity: EventSeveritySchema,
});

export type SessionStatus = z.infer<typeof SessionStatusSchema>;
export type CommandType = z.infer<typeof CommandTypeSchema>;
export type ResultStatus = z.infer<typeof ResultStatusSchema>;
export type Session = z.infer<typeof SessionSchema>;
export type Command = z.infer<typeof CommandSchema>;
export type SessionEvent = z.infer<typeof SessionEventSchema>;
export type AuthorizationContext = z.infer<typeof AuthorizationContextSchema>;
export type ConnectionStateRecord = z.infer<typeof ConnectionStateRecordSchema>;

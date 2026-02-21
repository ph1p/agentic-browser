import crypto from "node:crypto";

interface TokenRecord {
  token: string;
  revokedAt?: string;
}

export class SessionTokenService {
  private readonly bySession = new Map<string, TokenRecord>();

  issue(sessionId: string): string {
    const token = crypto.randomBytes(24).toString("hex");
    this.bySession.set(sessionId, { token });
    return token;
  }

  validate(sessionId: string, token: string): boolean {
    const record = this.bySession.get(sessionId);
    if (!record || record.revokedAt) {
      return false;
    }
    const expected = Buffer.from(record.token);
    const provided = Buffer.from(token);
    if (expected.length !== provided.length) {
      return false;
    }
    return crypto.timingSafeEqual(expected, provided);
  }

  revoke(sessionId: string): void {
    const record = this.bySession.get(sessionId);
    if (!record) {
      return;
    }
    record.revokedAt = new Date().toISOString();
    this.bySession.set(sessionId, record);
  }

  get(sessionId: string): string | undefined {
    return this.bySession.get(sessionId)?.token;
  }

  seed(sessionId: string, token: string): void {
    this.bySession.set(sessionId, { token });
  }
}

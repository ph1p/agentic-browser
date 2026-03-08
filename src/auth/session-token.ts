import crypto from "node:crypto";

export class SessionTokenService {
  private readonly tokens = new Map<string, string>();

  issue(sessionId: string): string {
    const token = crypto.randomBytes(24).toString("hex");
    this.tokens.set(sessionId, token);
    return token;
  }

  validate(sessionId: string, token: string): boolean {
    const expected = this.tokens.get(sessionId);
    if (!expected) return false;
    const expectedBuf = Buffer.from(expected);
    const providedBuf = Buffer.from(token);
    if (expectedBuf.length !== providedBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, providedBuf);
  }

  revoke(sessionId: string): void {
    this.tokens.delete(sessionId);
  }

  get(sessionId: string): string | undefined {
    return this.tokens.get(sessionId);
  }

  seed(sessionId: string, token: string): void {
    this.tokens.set(sessionId, token);
  }
}

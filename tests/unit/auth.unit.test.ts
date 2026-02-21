import { describe, expect, it } from "vitest";

import { SessionTokenService } from "../../src/auth/session-token.js";

describe("SessionTokenService", () => {
  it("issues and validates token", () => {
    const service = new SessionTokenService();
    const token = service.issue("s1");
    expect(service.validate("s1", token)).toBe(true);
  });

  it("rejects revoked token", () => {
    const service = new SessionTokenService();
    const token = service.issue("s2");
    service.revoke("s2");
    expect(service.validate("s2", token)).toBe(false);
  });

  it("rejects token with different length without throwing", () => {
    const service = new SessionTokenService();
    service.issue("s3");
    expect(service.validate("s3", "short")).toBe(false);
  });
});

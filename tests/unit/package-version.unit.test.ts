import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { readPackageVersion } from "../../src/lib/package-version.js";

describe("readPackageVersion", () => {
  it("returns the version from package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(readPackageVersion()).toBe(pkg.version);
  });
});

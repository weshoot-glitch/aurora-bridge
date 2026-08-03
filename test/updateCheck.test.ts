import { describe, it, expect } from "vitest";
import { compareVersions, checkForUpdate } from "../src/core/updateCheck";

describe("update check", () => {
  it("compares dotted versions correctly (leading v ignored)", () => {
    expect(compareVersions("4.0.1", "4.0.0")).toBeGreaterThan(0);
    expect(compareVersions("v4.1.0", "4.0.9")).toBeGreaterThan(0);
    expect(compareVersions("4.0.0", "4.0.0")).toBe(0);
    expect(compareVersions("3.9.9", "4.0.0")).toBeLessThan(0);
    expect(compareVersions("4.0", "4.0.0")).toBe(0);
  });

  it("is disabled (null) when no release repo is configured", async () => {
    expect(await checkForUpdate("4.0.0", "")).toBeNull();
  });
});

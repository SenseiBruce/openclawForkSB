import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("coverage threshold gate", () => {
  it("keeps vitest coverage thresholds at 70", () => {
    const configPath = path.join(process.cwd(), "vitest.config.ts");
    const text = fs.readFileSync(configPath, "utf8");
    expect(text).toMatch(/lines:\s*70/);
    expect(text).toMatch(/functions:\s*70/);
    expect(text).toMatch(/branches:\s*70/);
    expect(text).toMatch(/statements:\s*70/);
  });
});

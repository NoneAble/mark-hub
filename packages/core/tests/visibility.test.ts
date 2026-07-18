import { describe, it, expect } from "vitest";
import { effectiveVisibility } from "../src/visibility";

describe("visibility", () => {
  it("takes most strict ancestor", () => {
    expect(effectiveVisibility("public", ["private"])).toBe("private");
    expect(effectiveVisibility("public", ["unlisted"])).toBe("unlisted");
    expect(effectiveVisibility("public", ["public"])).toBe("public");
  });

  it("private bookmark under public folder stays private", () => {
    expect(effectiveVisibility("private", ["public"])).toBe("private");
  });
});

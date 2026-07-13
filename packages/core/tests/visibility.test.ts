import { describe, it, expect } from "vitest";
import {
  effectiveVisibility,
  isPublicNavVisible,
  fromLiteMarkVisible,
} from "../src/visibility";

describe("visibility", () => {
  it("takes most strict ancestor", () => {
    expect(effectiveVisibility("public", ["private"])).toBe("private");
    expect(effectiveVisibility("public", ["unlisted"])).toBe("unlisted");
    expect(effectiveVisibility("public", ["public"])).toBe("public");
  });

  it("private bookmark under public folder stays private", () => {
    expect(isPublicNavVisible("private", ["public"])).toBe(false);
  });

  it("public bookmark under private folder is hidden", () => {
    expect(isPublicNavVisible("public", ["private"])).toBe(false);
  });

  it("maps LiteMark visible flag", () => {
    expect(fromLiteMarkVisible(true)).toBe("public");
    expect(fromLiteMarkVisible(false)).toBe("private");
  });
});

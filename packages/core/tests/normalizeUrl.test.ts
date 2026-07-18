import { describe, it, expect } from "vitest";
import { normalizeUrl } from "../src/normalizeUrl";

describe("normalizeUrl", () => {
  it("lowercases host and strips hash", () => {
    expect(normalizeUrl("https://Example.COM/Path#frag")).toBe(
      "https://example.com/Path",
    );
  });

  it("preserves path and query case (only host is lowercased)", () => {
    expect(
      normalizeUrl("https://EXAMPLE.com/CasePath?Token=ABC&utm_source=x"),
    ).toBe("https://example.com/CasePath?Token=ABC");
  });

  it("strips tracking params", () => {
    expect(
      normalizeUrl("https://ex.com/a?utm_source=x&id=1&fbclid=y"),
    ).toBe("https://ex.com/a?id=1");
  });

  it("strips trailing slash except root", () => {
    expect(normalizeUrl("https://ex.com/foo/")).toBe("https://ex.com/foo");
    expect(normalizeUrl("https://ex.com/")).toBe("https://ex.com/");
  });

  it("strips default ports", () => {
    expect(normalizeUrl("https://ex.com:443/a")).toBe("https://ex.com/a");
    expect(normalizeUrl("http://ex.com:80/a")).toBe("http://ex.com/a");
  });

  it("adds https when scheme missing", () => {
    expect(normalizeUrl("example.com/x")).toBe("https://example.com/x");
  });
});

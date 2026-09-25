import { describe, expect, it } from "vitest";
import {
  compareVersions,
  isDriveShareLink,
  isValidVersion,
  isWebLink,
  parseVersion,
  suggestNextVersion,
} from "./mobile-app-version";

describe("version numbers", () => {
  it("are numbers, not text", () => {
    expect(compareVersions("3.0.10", "3.0.9")).toBeGreaterThan(0);
    expect(compareVersions("10.0.0", "9.9.9")).toBeGreaterThan(0);
    expect(compareVersions("3.0.9", "3.1")).toBeLessThan(0);
  });

  it("ignore trailing zeros and a leading v", () => {
    expect(compareVersions("3.0", "3.0.0")).toBe(0);
    expect(compareVersions("v3.0.0", "3.0")).toBe(0);
    expect(parseVersion("v3.0.0")).toEqual([3]);
    expect(parseVersion(" 3.1.0 ")).toEqual([3, 1]);
  });

  it("must be dotted numbers", () => {
    for (const ok of ["3.0", "3.0.0", "v3.0.0", "12.34.56", "1.2.3.4"]) expect(isValidVersion(ok), ok).toBe(true);
    for (const bad of ["", "3", "abc", "3.x", "3.0.0-beta", "1.2.3.4.5", "3..0", "  "]) {
      expect(isValidVersion(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("sorts an invalid version as the oldest", () => {
    expect(compareVersions("junk", "1.0")).toBeLessThan(0);
    expect(compareVersions("1.0", "junk")).toBeGreaterThan(0);
    expect(compareVersions("junk", "junk")).toBe(0);
  });

  it("suggests the next patch number", () => {
    expect(suggestNextVersion("3.0.0")).toBe("3.0.1");
    expect(suggestNextVersion("3.0")).toBe("3.0.1");
    expect(suggestNextVersion("3.0.9")).toBe("3.0.10");
    expect(suggestNextVersion("v2.4.7")).toBe("2.4.8");
    expect(suggestNextVersion("nope")).toBeNull();
  });
});

describe("download links", () => {
  it("must be web links", () => {
    expect(isWebLink("https://example.test/app.apk")).toBe(true);
    expect(isWebLink("  http://192.168.1.5:8000/a.apk  ")).toBe(true);
    for (const bad of ["", "app.apk", "ftp://x/a.apk", "javascript:alert(1)", "https://", "https://a b"]) {
      expect(isWebLink(bad), bad).toBe(false);
    }
  });

  it("spots a Google Drive share link", () => {
    expect(isDriveShareLink("https://drive.google.com/file/d/ABC123/view?usp=sharing")).toBe(true);
    expect(isDriveShareLink("https://drive.google.com/open?id=ABC123")).toBe(true);
    expect(isDriveShareLink("https://drive.google.com/uc?export=download&id=ABC123")).toBe(true);
    expect(isDriveShareLink("https://example.test/file/d/ABC123/view")).toBe(false);
    expect(isDriveShareLink("https://drive.google.com/drive/folders/abc")).toBe(false);
    expect(isDriveShareLink("not a link")).toBe(false);
  });
});

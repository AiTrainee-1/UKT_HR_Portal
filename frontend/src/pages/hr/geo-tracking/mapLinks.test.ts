import { describe, expect, it } from "vitest";
import {
  GOOGLE_VIEW_STORAGE_KEY,
  coordsText,
  googleDirectionsUrl,
  googleEmbedUrl,
  googleMapsUrl,
  readGoogleView,
  saveGoogleView,
} from "./mapLinks";

const memory = (initial: Record<string, string> = {}) => {
  const data = { ...initial };
  return {
    data,
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
  };
};

describe("Google Maps links", () => {
  it("opens the place on Google Maps by its coordinates (6 decimals, about a tenth of a metre)", () => {
    expect(googleMapsUrl(11.1321, 77.32546)).toBe(
      "https://www.google.com/maps/search/?api=1&query=11.132100,77.325460",
    );
  });

  it("asks Google for directions to the place", () => {
    expect(googleDirectionsUrl(11.1321, 77.32546)).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=11.132100,77.325460",
    );
  });

  it("embeds the place with Google's keyless embed, at a zoom Google accepts", () => {
    expect(googleEmbedUrl(11.1321, 77.32546)).toBe(
      "https://www.google.com/maps?q=11.132100,77.325460&z=18&output=embed&hl=en",
    );
    expect(googleEmbedUrl(11.1321, 77.32546, 99)).toContain("&z=21&");
    expect(googleEmbedUrl(11.1321, 77.32546, 0)).toContain("&z=1&");
    // no key, no account: nothing that identifies the employee or the company is in the address
    expect(googleEmbedUrl(11.1321, 77.32546)).not.toMatch(/key=|employee|token/i);
  });

  it("writes the coordinates the way they are pasted into a search box", () => {
    expect(coordsText(11.1321, 77.32546)).toBe("11.132100, 77.325460");
  });
});

describe("the Google view switch", () => {
  it("is off until the person turns it on, and remembers the choice", () => {
    const storage = memory();
    expect(readGoogleView(storage)).toBe(false);
    saveGoogleView(true, storage);
    expect(storage.data[GOOGLE_VIEW_STORAGE_KEY]).toBe("on");
    expect(readGoogleView(storage)).toBe(true);
    saveGoogleView(false, storage);
    expect(readGoogleView(storage)).toBe(false);
  });

  it("never throws when the browser storage is missing or refuses", () => {
    const refusing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readGoogleView(refusing)).toBe(false);
    expect(() => saveGoogleView(true, refusing)).not.toThrow();
    expect(readGoogleView(null)).toBe(false);
    expect(() => saveGoogleView(true, null)).not.toThrow();
  });
});

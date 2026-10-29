import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readJourneyDetail, readJourneyTrail } from "@/lib/api-client/custom-hooks";
import { buildTimeline, mapModel, trailModel } from "./logic";
import PlaceDetails from "./PlaceDetails";
import { all, detailFixture, installBrowserStubs, mount, q, text, trailFixture, unmount } from "./testing";

// The details panel of Journey History in jsdom, for what the page itself cannot pick in jsdom: a dot of the route (the dots are
// drawn on a canvas by Leaflet, which jsdom does not have), and a journey with nothing on its map.

const build = (over: Parameters<typeof detailFixture>[1] = {}) => {
  const detail = readJourneyDetail(detailFixture(7, over));
  const rows = buildTimeline(detail.segments, detail.events);
  return { detail, rows, model: mapModel(detail, rows), trail: trailModel(readJourneyTrail(trailFixture(7)), rows) };
};

const show = (selectedKey: string | null, parts = build()) => {
  const Panel = () => (
    <PlaceDetails
      detail={parts.detail}
      model={parts.model}
      rows={parts.rows}
      trail={parts.trail}
      selectedKey={selectedKey}
    />
  );
  mount("/", Panel);
};

beforeAll(installBrowserStubs);
beforeEach(() => window.localStorage.clear());
afterEach(unmount);

describe("PlaceDetails: a recorded position", () => {
  it("shows when and where it was, how good the fix was, and how fast the phone was going", () => {
    const parts = build();
    const dot = parts.trail!.dots.find((d) => d.stopNumber === 1)!;
    show(dot.key, parts);
    expect(text(q("place-heading"))).toBe("Recorded position");
    expect(q("place-details")!.dataset.kind).toBe("picked");
    const facts = text(q("place-facts"));
    expect(facts).toContain("Time (IST)");
    expect(facts).toMatch(/28 Oct, 09:3\d:00/);
    expect(facts).toContain("±12 m (good)");
    expect(facts).toContain("0 km/h");
    expect(facts).toContain("Still");
    expect(facts).toContain("64%");
    expect(facts).toContain("Mobile data");
    expect(facts).toContain("GPS + network");
    expect(text(q("place-details"))).toContain("during stop 1");
    expect(q("open-google-maps")!.getAttribute("href")).toBe(
      `https://www.google.com/maps/search/?api=1&query=${dot.pos[0].toFixed(6)},${dot.pos[1].toFixed(6)}`,
    );
    expect(all("place-end")).toHaveLength(0);
  });

  it("says a position the pipeline set aside is not part of the route, and how poor it was", () => {
    const parts = build();
    const poor = parts.trail!.dots.find((d) => !d.point.used)!;
    show(poor.key, parts);
    expect(text(q("place-details"))).toContain("set aside: poor accuracy or a GPS jump");
    expect(text(q("place-facts"))).toContain("±180 m (poor)");
  });

  it("falls back to where the journey ended when the picked position is no longer in the trail", () => {
    show("pt-123");
    expect(q("place-details")!.dataset.kind).toBe("picked");
    expect(text(q("place-heading"))).toBe("End of the journey");
  });
});

describe("PlaceDetails: nothing to show", () => {
  it("says no location has been recorded yet for a journey with nothing on its map", () => {
    const parts = build({ segments: [], events: [], track: { lastLatitude: null, lastLongitude: null } });
    parts.detail = { ...parts.detail, path: [] };
    parts.model = mapModel(parts.detail, parts.rows);
    parts.trail = null;
    show(null, parts);
    expect(q("place-details")!.dataset.kind).toBe("none");
    expect(text(q("place-details"))).toContain("No location has been recorded yet");
    expect(q("open-google-maps")).toBeNull();
    expect(q("google-view-toggle")).toBeNull();
  });

  it("calls the last place of a journey that is still being recorded its latest position", () => {
    const parts = build({ track: { status: "active", state: "moving", endedAt: null, endReason: "" } });
    show(null, parts);
    expect(text(q("place-heading"))).toBe("Latest position");
  });
});

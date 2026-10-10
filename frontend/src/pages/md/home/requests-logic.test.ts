import { describe, expect, it } from "vitest";
import {
  summarisePending,
  waitingDays,
  waitingForText,
  waitingText,
  waitingTone,
  type PendingRequest,
} from "./requests-logic";

const NOW = new Date("2026-10-10T10:00:00+05:30");

const request = (over: Partial<PendingRequest> & Pick<PendingRequest, "id">): PendingRequest => ({
  kind: "leave",
  who: `Person ${over.id}`,
  what: "Casual Leave",
  detail: "",
  createdAt: "2026-10-09T09:00:00+05:30",
  waitingFor: ["hr"],
  ...over,
});

describe("waiting", () => {
  it("counts whole days and never goes below zero", () => {
    expect(waitingDays("2026-10-10T08:00:00+05:30", NOW)).toBe(0);
    expect(waitingDays("2026-10-09T09:00:00+05:30", NOW)).toBe(1);
    expect(waitingDays("2026-10-01T09:00:00+05:30", NOW)).toBe(9);
    expect(waitingDays("2026-10-12T09:00:00+05:30", NOW)).toBe(0);
    expect(waitingDays("not a date", NOW)).toBe(0);
  });

  it("says it in words and tones it", () => {
    expect(waitingText(0)).toBe("today");
    expect(waitingText(1)).toBe("1 day");
    expect(waitingText(4)).toBe("4 days");
    expect([0, 1, 2, 3, 4].map(waitingTone)).toEqual(["fresh", "fresh", "watch", "watch", "late"]);
  });

  it("says who a request is waiting for", () => {
    expect(waitingForText(["hr"])).toBe("Waiting for HR");
    expect(waitingForText(["hod"])).toBe("Waiting for Department Head");
    expect(waitingForText(["hod", "hr"])).toBe("Waiting for Department Head or HR");
    expect(waitingForText([])).toBe("Waiting for HR");
  });
});

describe("summarisePending", () => {
  it("ranks every pending request, the oldest first, and counts by kind", () => {
    const d = summarisePending(
      [
        request({ id: 1, createdAt: "2026-10-08T09:00:00+05:30", kind: "permission" }),
        request({ id: 2, createdAt: "2026-10-05T09:00:00+05:30", kind: "outpass" }),
        request({ id: 3, createdAt: "2026-10-09T09:00:00+05:30", kind: "leave" }),
        request({ id: 4, createdAt: "2026-10-06T09:00:00+05:30", kind: "leave", waitingFor: ["hod"] }),
      ],
      NOW,
    );
    expect(d.items.map((r) => r.id)).toEqual([2, 4, 1, 3]);
    expect(d.counts).toEqual({ leave: 2, permission: 1, outpass: 1 });
    expect(d.total).toBe(4);
    expect(d.oldestDays).toBe(5);
  });

  it("includes what waits for a Department Head: the MD sees every pending request, whoever's turn it is", () => {
    const d = summarisePending([request({ id: 1, waitingFor: ["hod"] }), request({ id: 2, waitingFor: ["hr"] })], NOW);
    expect(d.total).toBe(2);
    expect(d.items.map((r) => r.waitingFor)).toEqual([["hod"], ["hr"]]);
  });

  it("cuts the list but not the counts, and ties go to the lower id", () => {
    const same = "2026-10-09T09:00:00+05:30";
    const d = summarisePending(
      [3, 1, 2, 5, 4].map((id) => request({ id, createdAt: same })),
      NOW,
      2,
    );
    expect(d.items.map((r) => r.id)).toEqual([1, 2]);
    expect(d.total).toBe(5);
  });

  it("is quiet when nothing waits: no oldest, no items", () => {
    expect(summarisePending([], NOW)).toEqual({
      items: [],
      counts: { leave: 0, permission: 0, outpass: 0 },
      total: 0,
      oldestDays: null,
    });
  });

  it("puts a request with no readable date last and does not let it set the oldest", () => {
    const d = summarisePending(
      [request({ id: 1, createdAt: "" }), request({ id: 2, createdAt: "2026-10-08T09:00:00+05:30" })],
      NOW,
    );
    expect(d.items.map((r) => r.id)).toEqual([2, 1]);
    expect(d.oldestDays).toBe(2);
  });
});

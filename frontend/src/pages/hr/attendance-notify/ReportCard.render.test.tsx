import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readChatReport, type NotifyChatReport } from "@/lib/api-client/custom-hooks/attendance-notify";
import ReportCard from "./ReportCard";

// The report card the HR chat page (and the chat preview) draws for an Attendance Notify message.

vi.mock("@/contexts/AuthContext", async (original) => ({
  ...(await original<typeof import("@/contexts/AuthContext")>()),
  useAuth: () => ({ token: "t", user: null }),
}));

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function draw(report: NotifyChatReport) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(ReportCard, { report })));
}

const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

const row = (i: number) => ({
  date: "2026-11-17",
  category: i % 2 ? "cl" : "absent",
  employeeId: i,
  code: `E${i}`,
  name: `Person ${i}`,
  department: "Stitching",
  designation: "Tailor",
  employmentType: "production",
  detail: i % 2 ? "First half CL · Personal work" : "",
  photoUrl: null,
});

describe("the chat report card", () => {
  it("shows the title, the counts of its categories and the first lines, then all of them", () => {
    draw(
      readChatReport({
        title: "Morning absentees",
        dateLabel: "Tue, 17 Nov 2026",
        counts: { absent: 6, cl: 4, permission: 9 },
        categories: ["absent", "cl"],
        content: "both",
        employees: 10,
        total: 300,
        rows: Array.from({ length: 10 }, (_, i) => row(i)),
      })!,
    );
    expect(text(q("report-card"))).toContain("Morning absentees");
    expect(text(q("report-card-people"))).toBe("10 employees of 300");
    // only the report's categories: Permission is not one of them
    expect(text(q("report-card-counts"))).toBe("Absent· 6CL· 4");
    expect(document.body.querySelectorAll('[data-testid="report-row"]')).toHaveLength(8);
    expect(text(document.body.querySelector('[data-testid="report-row"]:nth-child(2)'))).toContain(
      "First half CL · Personal work",
    );
    act(() => q("report-card-more")!.click());
    expect(document.body.querySelectorAll('[data-testid="report-row"]')).toHaveLength(10);
  });

  it("a summary-only report has counts and no list; an empty one says so", () => {
    draw(
      readChatReport({
        title: "Summary",
        counts: { absent: 0 },
        categories: ["absent"],
        content: "summary",
        rows: [],
      })!,
    );
    expect(document.body.querySelectorAll('[data-testid="report-row"]')).toHaveLength(0);
    expect(text(q("report-card"))).toContain("Nobody in these categories.");
  });
});

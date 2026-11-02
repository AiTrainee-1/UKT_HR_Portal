import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { EMPTY_STATS, type HubItem, type HubResponse } from "./logic";
import { StatusCell } from "./parts";
import { normalizeReminders, reminderOf, reminderText, withReminders } from "./reminders";

const item = (over: Partial<HubItem> = {}): HubItem => ({
  key: "leave-1",
  kind: "leave",
  id: 1,
  employee: {
    id: 1,
    code: "E001",
    name: "Asha Kumar",
    department: null,
    departmentId: null,
    designation: null,
    branch: null,
    branchId: null,
    type: "staff",
    photoUrl: null,
  },
  label: "Casual Leave",
  summary: "2026-10-12 · 1 day",
  reason: null,
  date: "2026-10-12",
  details: [],
  status: "pending",
  rawStatus: "pending",
  statusLabel: null,
  queue: "hr",
  approval: null,
  submittedAt: "2026-10-10T04:00:00Z",
  decided: null,
  extra: {},
  ...over,
});

const hub = (items: HubItem[]): HubResponse => ({
  kinds: [],
  stats: EMPTY_STATS,
  items,
  limit: 200,
  options: { branches: [], departments: [] },
});

describe("HR reminders on the Requests hub", () => {
  it("reads the list leniently", () => {
    expect(normalizeReminders(null)).toEqual([]);
    expect(normalizeReminders({ reminders: "x" })).toEqual([]);
    expect(
      normalizeReminders({
        reminders: [
          { key: "leave-1", remindedAt: "2026-10-31T04:35:00Z", count: 2 },
          { key: "", remindedAt: "x" },
          { key: "request-4", remindedAt: "2026-10-31T05:00:00Z" },
          null,
        ],
      }),
    ).toEqual([
      { key: "leave-1", remindedAt: "2026-10-31T04:35:00Z", count: 2 },
      { key: "request-4", remindedAt: "2026-10-31T05:00:00Z", count: 1 },
    ]);
  });

  it("puts the reminder on the waiting request only", () => {
    const waiting = item();
    const decided = item({ key: "leave-2", id: 2, status: "approved" });
    const out = withReminders(hub([waiting, decided]), [
      { key: "leave-1", remindedAt: "2026-10-31T04:35:00Z", count: 1 },
      { key: "leave-2", remindedAt: "2026-10-31T04:35:00Z", count: 1 },
    ]);
    expect(reminderOf(out.items[0])).toEqual({ remindedAt: "2026-10-31T04:35:00Z", count: 1 });
    expect(reminderOf(out.items[1])).toBeNull();
    // nothing to add: the very same object comes back (no re-render)
    const same = hub([waiting]);
    expect(withReminders(same, [])).toBe(same);
    expect(withReminders(same, undefined)).toBe(same);
  });

  it("says when the employee reminded HR", () => {
    const at = new Date(2026, 9, 31, 10, 5).toISOString();
    expect(reminderText({ remindedAt: at, count: 1 })).toBe("Employee reminded HR on 31 Oct, 10:05");
    expect(reminderText({ remindedAt: at, count: 3 })).toBe(
      "Employee reminded HR on 31 Oct, 10:05 (3 times this week)",
    );
    expect(reminderText({ remindedAt: "nope", count: 1 })).toBe("");
    expect(reminderText(null)).toBe("");
  });
});

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

function mount(node: React.ReactElement) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

describe("the status cell", () => {
  it("shows the reminder line on a reminded, waiting request", () => {
    const at = new Date(2026, 9, 31, 10, 5).toISOString();
    const reminded = item({ extra: { hrReminder: { remindedAt: at, count: 1 } } });
    const el = mount(<StatusCell item={reminded} now={new Date(2026, 9, 31, 12)} />);
    expect(el.querySelector('[data-testid="reminded-leave-1"]')?.textContent).toContain(
      "Employee reminded HR on 31 Oct, 10:05",
    );
  });

  it("shows nothing without a reminder", () => {
    const el = mount(<StatusCell item={item()} now={new Date(2026, 9, 31, 12)} />);
    expect(el.querySelector('[data-testid^="reminded-"]')).toBeNull();
  });
});

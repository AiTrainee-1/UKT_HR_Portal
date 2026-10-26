import { describe, expect, it } from "vitest";
import { THEMES, type ThemeId } from "@/lib/themes";
import { everyoneText, statusOf, type ThemeStatusInput } from "./status";

// The labels on a theme card, from their three separate sources: the org-wide theme (only once the server has said so),
// this device's own choice (localStorage only) and what is really on <html data-theme>.

const base: ThemeStatusInput = {
  org: "default",
  orgState: "confirmed",
  device: null,
  applied: "default",
  previewing: false,
};
const ids = THEMES.map((t) => t.id);
const only = (input: ThemeStatusInput, key: "everyone" | "device" | "showing" | "previewed"): ThemeId[] =>
  ids.filter((id) => statusOf(id, input)[key]);

describe("theme card labels", () => {
  it("org-wide theme only: that card is 'for everyone' and showing; nothing says 'on this device'", () => {
    const input = { ...base, org: "premium", applied: "premium" } as const;
    expect(only(input, "everyone")).toEqual(["premium"]);
    expect(only(input, "device")).toEqual([]);
    expect(only(input, "showing")).toEqual(["premium"]);
    expect(only(input, "previewed")).toEqual([]);
  });

  it("a missing device choice is no choice: it never turns into 'same as the org-wide theme'", () => {
    for (const id of ids) {
      const s = statusOf(id, { ...base, org: id, applied: id, device: null });
      expect(s.device, id).toBe(false);
      expect(s.everyone, id).toBe(true);
    }
  });

  it("device choice only: the device's card says so, the org-wide card keeps its own label, showing follows the device", () => {
    const input = { ...base, org: "default", device: "clean", applied: "clean" } as const;
    expect(only(input, "everyone")).toEqual(["default"]);
    expect(only(input, "device")).toEqual(["clean"]);
    expect(only(input, "showing")).toEqual(["clean"]);
  });

  it("both the same: one card wears both labels (and is showing)", () => {
    const input = { ...base, org: "clean", device: "clean", applied: "clean" } as const;
    expect(only(input, "everyone")).toEqual(["clean"]);
    expect(only(input, "device")).toEqual(["clean"]);
    expect(only(input, "showing")).toEqual(["clean"]);
  });

  it("both different: two cards, each with its own label, and only the device's is showing", () => {
    const input = { ...base, org: "premium", device: "clean", applied: "clean" } as const;
    expect(only(input, "everyone")).toEqual(["premium"]);
    expect(only(input, "device")).toEqual(["clean"]);
    expect(only(input, "showing")).toEqual(["clean"]);
  });

  it("a preview: the previewed card is showing and previewed, and the saved labels do not move", () => {
    const input = { ...base, org: "default", device: "clean", applied: "dark", previewing: true } as const;
    expect(only(input, "showing")).toEqual(["dark"]);
    expect(only(input, "previewed")).toEqual(["dark"]);
    expect(only(input, "everyone")).toEqual(["default"]);
    expect(only(input, "device")).toEqual(["clean"]);
    // previewing the theme that is already saved is not 'only previewed'
    expect(only({ ...input, applied: "clean" }, "previewed")).toEqual([]);
  });

  it("'showing' is what was applied to <html>, not what the saved choices would imply", () => {
    expect(only({ ...base, org: "premium", device: "clean", applied: "default" }, "showing")).toEqual(["default"]);
  });

  it("a cached copy of the org-wide theme is never 'for everyone': only the server's answer is", () => {
    for (const orgState of ["cached", "unreachable"] as const) {
      expect(only({ ...base, org: "premium", orgState, applied: "premium" }, "everyone"), orgState).toEqual([]);
    }
    expect(only({ ...base, org: "premium", orgState: "confirmed", applied: "premium" }, "everyone")).toEqual([
      "premium",
    ]);
  });

  it("the summary names the org-wide theme only when the server has said so", () => {
    expect(everyoneText("Premium Theme", "confirmed")).toBe("Premium Theme");
    expect(everyoneText("Premium Theme", "cached")).toBe("Checking with the server...");
    expect(everyoneText("Premium Theme", "unreachable")).toContain("last known");
    expect(everyoneText("Premium Theme", "unreachable")).toContain("Premium Theme");
  });
});

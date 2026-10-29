import { describe, expect, it } from "vitest";
import { DEFAULT_GEO_SETTINGS, readGeoSettings, type GeoTrackingSettings } from "@/lib/api-client/custom-hooks";
import { NUMBER_SPECS, needsPhotoConfirm, sameForm, toForm, toPatch, validate } from "./rules";

// The form model of "Geo-tracking rules": what is shown (minutes for the long times), what is refused (in words), and what a
// save sends (only what changed, in the server's units).

const saved: GeoTrackingSettings = { ...DEFAULT_GEO_SETTINGS, noticeVersion: 3, noticeText: "We record your route." };

describe("the form", () => {
  it("shows stop, gap and signal-lost times in minutes and the rest as the server keeps them", () => {
    const form = toForm(saved);
    expect(form.stopMinutes).toBe("3");
    expect(form.gapMinutes).toBe("5");
    expect(form.signalLostMinutes).toBe("10");
    expect(form.stopRadiusM).toBe("50");
    expect(form.sampleMovingSeconds).toBe("3");
    expect(form.uploadBatchPoints).toBe("30");
    expect(form.retentionDays).toBe("365");
    expect(form.dayEndTime).toBe("23:50");
    expect(form.ondutyPunchPhotos).toBe("1");
    expect(form.reaccept).toBe(false);
    expect(form.reverseGeocodeProvider).toBe("off");
  });

  it("shows a stop of 90 seconds as 1.5 minutes", () => {
    expect(toForm({ ...saved, stopSeconds: 90 }).stopMinutes).toBe("1.5");
  });

  it("is unchanged until somebody edits it", () => {
    expect(sameForm(toForm(saved), toForm(saved))).toBe(true);
    expect(sameForm(toForm(saved), { ...toForm(saved), stopMinutes: "4" })).toBe(false);
    expect(toPatch(toForm(saved), saved)).toEqual({});
  });
});

describe("validation, in words", () => {
  it("accepts the server's defaults", () => {
    expect(validate(toForm(saved), saved)).toEqual({});
  });

  it("refuses an empty or non-numeric field and says which one", () => {
    const errors = validate({ ...toForm(saved), stopMinutes: "", gapMinutes: "abc" }, saved);
    expect(errors.stopMinutes).toBe("Stationary after: enter a number between 1 and 60 minutes.");
    expect(errors.gapMinutes).toMatch(/^Gap after: enter a number between 1 and 60 minutes\./);
  });

  it("refuses a number outside its range, with the range", () => {
    const form = toForm(saved);
    const errors = validate(
      { ...form, stopRadiusM: "5", maxSpeedKmh: "900", uploadBatchPoints: "501", retentionDays: "3" },
      saved,
    );
    expect(errors.stopRadiusM).toBe("Stop radius: must be between 10 and 500 metres.");
    expect(errors.maxSpeedKmh).toBe("Ignore jumps faster than: must be between 30 and 500 km/h.");
    expect(errors.uploadBatchPoints).toBe("Phone: send after: must be between 5 and 500 positions.");
    expect(errors.retentionDays).toMatch(/must be between 7 and 3650 days/);
  });

  it("asks for a whole number where a fraction makes no sense", () => {
    const errors = validate({ ...toForm(saved), sampleMovingSeconds: "10.5", stopMinutes: "2.5" }, saved);
    expect(errors.sampleMovingSeconds).toBe("Phone: position every (moving): use a whole number.");
    expect(errors.stopMinutes).toBeUndefined(); // minutes may be half-minutes
    // ...but the server keeps whole seconds
    expect(validate({ ...toForm(saved), stopMinutes: "2.3333" }, saved).stopMinutes).toBe(
      "Stationary after: use a whole number of seconds (2.5 minutes is fine).",
    );
  });

  it("refuses a day end that is not a time of day", () => {
    expect(validate({ ...toForm(saved), dayEndTime: "" }, saved).dayEndTime).toMatch(/choose a time of day/);
    expect(validate({ ...toForm(saved), dayEndTime: "24:10" }, saved).dayEndTime).toMatch(/choose a time of day/);
    // the server closes the day's duties between 12:00 and 23:59
    expect(validate({ ...toForm(saved), dayEndTime: "11:59" }, saved).dayEndTime).toMatch(/between 12:00 and 23:59/);
    expect(validate({ ...toForm(saved), dayEndTime: "12:00" }, saved).dayEndTime).toBeUndefined();
    expect(validate({ ...toForm(saved), dayEndTime: "23:59" }, saved).dayEndTime).toBeUndefined();
  });

  it("refuses to blank the notice, but does not stop other changes when the saved notice was already empty", () => {
    expect(validate({ ...toForm(saved), noticeText: "  " }, saved).noticeText).toMatch(/Write the notice/);
    expect(validate({ ...toForm(saved), noticeText: "x".repeat(5001) }, saved).noticeText).toBe(
      "The notice can be at most 5000 characters (it is 5001).",
    );
    const noNotice = { ...saved, noticeText: "" };
    expect(validate({ ...toForm(noNotice), stopMinutes: "4" }, noNotice)).toEqual({});
  });

  it("has a range for every number of the form", () => {
    for (const spec of NUMBER_SPECS) {
      expect(spec.min).toBeLessThan(spec.max);
      const low = { ...toForm(saved), [spec.key]: String(spec.min - 1) };
      const high = { ...toForm(saved), [spec.key]: String(spec.max + 1) };
      expect(validate(low, saved)[spec.key], spec.key).toBeTruthy();
      expect(validate(high, saved)[spec.key], spec.key).toBeTruthy();
      expect(validate({ ...toForm(saved), [spec.key]: String(spec.max) }, saved)[spec.key], spec.key).toBeUndefined();
    }
  });
});

describe("what a save sends", () => {
  it("only what changed, in the server's units (minutes back to seconds)", () => {
    const form = { ...toForm(saved), stopMinutes: "4", gapMinutes: "7.5", stopRadiusM: "60", dayEndTime: "23:30" };
    expect(toPatch(form, saved)).toEqual({ stopSeconds: 240, gapSeconds: 450, stopRadiusM: 60, dayEndTime: "23:30" });
  });

  it("sends the photo rule as 1 or 2, the geocoder choice, the switch and the notice", () => {
    const form = {
      ...toForm(saved),
      ondutyPunchPhotos: "2" as const,
      reverseGeocodeProvider: "nominatim" as const,
      enabled: false,
      noticeText: "New notice",
    };
    expect(toPatch(form, saved)).toEqual({
      enabled: false,
      ondutyPunchPhotos: 2,
      noticeText: "New notice",
      noticeVersion: 4, // a changed notice is a new version: everybody accepts it again
      reverseGeocodeProvider: "nominatim",
    });
  });

  it("raises the notice version by one when everybody must accept again, once even if the text changed too", () => {
    expect(toPatch({ ...toForm(saved), reaccept: true }, saved)).toEqual({ noticeVersion: 4 });
    expect(toPatch({ ...toForm(saved), reaccept: true, noticeText: "Changed" }, saved)).toEqual({
      noticeText: "Changed",
      noticeVersion: 4,
    });
  });

  it("ignores a time the server sent with seconds", () => {
    const withSeconds = readGeoSettings({ ...DEFAULT_GEO_SETTINGS, dayEndTime: "23:50:00" });
    expect(toPatch(toForm(withSeconds), withSeconds)).toEqual({});
  });

  it("asks to confirm only when the rule moves from one photo to two", () => {
    expect(needsPhotoConfirm({ ...toForm(saved), ondutyPunchPhotos: "2" }, saved)).toBe(true);
    expect(needsPhotoConfirm(toForm(saved), saved)).toBe(false);
    const two = { ...saved, ondutyPunchPhotos: 2 as const };
    expect(needsPhotoConfirm(toForm(two), two)).toBe(false);
    expect(needsPhotoConfirm({ ...toForm(two), ondutyPunchPhotos: "1" }, two)).toBe(false);
  });
});

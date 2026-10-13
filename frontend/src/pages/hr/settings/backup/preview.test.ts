import { describe, expect, it } from "vitest";
import {
  backupFileName,
  backupPath,
  daysValue,
  driveProblem,
  folderIdFromLink,
  formatSize,
  nextRuns,
  parseDays,
  readServiceAccountKey,
  retentionCutsFiles,
  retentionExample,
  retentionProblem,
  scheduleFormFrom,
  type Weekday,
} from "./preview";

// India time has no daylight saving: 05:30 ahead of UTC all year.
const ist = (text: string) => new Date(`${text}+05:30`);
const asIst = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 16);

describe("next scheduled runs (backup_scheduler's CronTrigger, Asia/Kolkata)", () => {
  // Every expected list below is what APScheduler 3.11's CronTrigger.get_next_fire_time returned for the same case.
  const cases: [string, string, string, string[]][] = [
    ["2026-10-12T01:00:00", "02:00", "*", ["2026-10-12T02:00", "2026-10-13T02:00", "2026-10-14T02:00"]],
    ["2026-10-12T01:00:00", "02:00", "mon,wed,fri", ["2026-10-12T02:00", "2026-10-14T02:00", "2026-10-16T02:00"]],
    ["2026-10-12T02:00:00", "02:00", "mon,wed,fri", ["2026-10-12T02:00", "2026-10-14T02:00", "2026-10-16T02:00"]],
    ["2026-10-12T02:00:01", "02:00", "mon,wed,fri", ["2026-10-14T02:00", "2026-10-16T02:00", "2026-10-19T02:00"]],
    ["2026-10-12T23:30:00", "23:45", "sat,sun", ["2026-10-17T23:45", "2026-10-18T23:45", "2026-10-24T23:45"]],
    ["2026-10-17T10:00:00", "00:00", "mon-fri", ["2026-10-19T00:00", "2026-10-20T00:00", "2026-10-21T00:00"]],
    ["2026-12-31T22:00:00", "21:15", "thu", ["2027-01-07T21:15", "2027-01-14T21:15", "2027-01-21T21:15"]],
  ];
  it.each(cases)("from %s at %s on %s", (now, time, days, expected) => {
    expect(nextRuns(ist(now), time, parseDays(days)).map(asIst)).toEqual(expected);
  });

  it("gives nothing for a time it cannot read", () => {
    expect(nextRuns(ist("2026-10-12T01:00:00"), "", null)).toEqual([]);
  });
});

describe("days", () => {
  it("reads what is stored, ranges included, and writes it back in week order", () => {
    expect(parseDays("*")).toBeNull();
    expect(parseDays("")).toBeNull();
    expect(parseDays("mon-fri")).toEqual(["mon", "tue", "wed", "thu", "fri"]);
    expect(parseDays("fri,mon")).toEqual(["mon", "fri"]);
    expect(parseDays("mon,tue,wed,thu,fri,sat,sun")).toBeNull();
    expect(daysValue(["fri", "mon"] as Weekday[])).toBe("mon,fri");
    expect(daysValue(null)).toBe("*");
    expect(daysValue([])).toBe("*");
  });
});

describe("backup file and folder", () => {
  it("names the file the way build_full_backup does", () => {
    expect(backupFileName(new Date(2026, 9, 12, 14, 30, 5))).toBe("UKTex_Full_backup_2026-10-12_14-30-05.zip");
  });

  it("joins the folder and the file with the folder's own separator", () => {
    const file = "UKTex_Full_backup_2026-10-12_14-30-00.zip";
    expect(backupPath("D:/backups/uktextile", file)).toBe(`D:/backups/uktextile/${file}`);
    expect(backupPath("D:\\backups\\uktextile", file)).toBe(`D:\\backups\\uktextile\\${file}`);
    expect(backupPath("/data/backups/", file)).toBe(`/data/backups/${file}`);
    expect(backupPath("  ", file)).toBe(file);
  });

  it("prints sizes as the old page did", () => {
    expect(formatSize(6_698_753)).toBe("6.39 MB");
    expect(formatSize(3 * 1024 * 1024 * 1024)).toBe("3.00 GB");
  });
});

describe("keep the last N (prune_old_backups)", () => {
  const today = new Date(2026, 9, 13);

  it("keeps the newest N after a new backup and deletes the rest", () => {
    expect(retentionExample(3, today)).toEqual({
      kept: ["13 Oct", "12 Oct", "11 Oct"],
      deleted: ["10 Oct", "9 Oct", "8 Oct"],
    });
    expect(retentionExample(0, today).deleted).toEqual([]);
    expect(retentionExample(14, today).deleted).toEqual([]);
  });

  it("asks before a smaller number is saved", () => {
    const saved = scheduleFormFrom({ isEnabled: true, time: "02:00", daysOfWeek: "*", retentionCount: 14 } as never);
    expect(retentionCutsFiles(saved, { ...saved, retention: "3" })).toBe(true);
    expect(retentionCutsFiles(saved, { ...saved, retention: "20" })).toBe(false);
    expect(retentionCutsFiles(saved, { ...saved, retention: "0" })).toBe(false);
    expect(retentionCutsFiles({ ...saved, retention: "0" }, { ...saved, retention: "30" })).toBe(true);
    expect(retentionCutsFiles(saved, { ...saved, retention: "x" })).toBe(false);
  });

  it("takes whole numbers only", () => {
    expect(retentionProblem("14")).toBeNull();
    expect(retentionProblem("0")).toBeNull();
    for (const bad of ["", "-1", "2.5", "ten"]) expect(retentionProblem(bad)).not.toBeNull();
  });
});

describe("Google Drive", () => {
  it("finds the folder ID inside a pasted folder link", () => {
    expect(folderIdFromLink("https://drive.google.com/drive/folders/1aBcD2eFgH3iJkL4mNoP5qRsT6uVwXyZ")).toBe(
      "1aBcD2eFgH3iJkL4mNoP5qRsT6uVwXyZ",
    );
    expect(folderIdFromLink("https://drive.google.com/drive/u/0/folders/0AbC_d-9?usp=sharing")).toBe("0AbC_d-9");
    expect(folderIdFromLink("https://drive.google.com/open?id=1XyZ")).toBe("1XyZ");
    expect(folderIdFromLink("1aBcD2eFgH3iJkL4mNoP5qRsT6uVwXyZ")).toBeNull();
  });

  it("reads a key the way google-auth will", () => {
    const good = JSON.stringify({
      type: "service_account",
      project_id: "uktex-backups",
      private_key: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n",
      client_email: "backup-bot@uktex-backups.iam.gserviceaccount.com",
      token_uri: "https://oauth2.googleapis.com/token",
    });
    expect(readServiceAccountKey(good)).toEqual({
      ok: true,
      clientEmail: "backup-bot@uktex-backups.iam.gserviceaccount.com",
      projectId: "uktex-backups",
      warning: null,
    });
    expect(readServiceAccountKey('{"type": "service_account", ...}')).toMatchObject({ ok: false });
    expect(readServiceAccountKey("[1]")).toMatchObject({ ok: false });
    expect(readServiceAccountKey('{"client_email": "a@b.c"}')).toEqual({
      ok: false,
      problem: "Google will refuse this key: it has no private_key, token_uri.",
    });
    const oauth = JSON.parse(good) as Record<string, string>;
    oauth.type = "authorized_user";
    expect(readServiceAccountKey(JSON.stringify(oauth))).toMatchObject({ ok: true, warning: expect.any(String) });
  });

  it("will not switch uploads on without a folder and a key (the server refuses it too)", () => {
    expect(driveProblem(true, "", true)).toMatch(/folder ID and a service account key/);
    expect(driveProblem(true, "1AbC", false)).toMatch(/folder ID and a service account key/);
    expect(driveProblem(true, " 1AbC ", true)).toBeNull();
    expect(driveProblem(false, "", false)).toBeNull();
  });
});

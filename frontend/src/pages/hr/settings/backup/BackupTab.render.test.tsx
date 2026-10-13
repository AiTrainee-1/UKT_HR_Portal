import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderMdPage, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import BackupTab from "../BackupTab";
import { BACKUP_SETTINGS } from "../BackupTab.meta";

// jsdom render checks of the Backup tab against a fake server: every flow it had still sends the same requests (run
// now, schedule, Google Drive, upload + validate, restore), the new folder save sends only the folder, nothing that
// deletes or replaces data happens without a confirm, and the explanations follow the values on screen. Nothing here
// makes a backup or restores one: every request is answered by the fixtures below.

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }), toast }));

const ADMIN = { role: "hr", employeeId: null, name: "Test HR", isSuperAdmin: true, permissions: {} };
const KEY = JSON.stringify({
  type: "service_account",
  project_id: "uktex-backups",
  private_key: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n",
  client_email: "backup-bot@uktex-backups.iam.gserviceaccount.com",
  token_uri: "https://oauth2.googleapis.com/token",
});

type Sent = { path: string; method: string; body: unknown };

const status = (over: Record<string, unknown> = {}) => ({
  backupDirectory: "D:/backups/uktextile",
  pgDumpAvailable: true,
  backups: [
    {
      file: "UKTex_Full_backup_2026-10-11_02-00-03.zip",
      sizeBytes: 6_698_753,
      createdAt: "2026-10-11T02:00:03",
      inDatabase: true,
    },
    {
      file: "UKTex_Full_backup_2026-10-10_02-00-02.zip",
      sizeBytes: 6_699_101,
      createdAt: "2026-10-10T02:00:02",
      inDatabase: false,
    },
  ],
  schedule: {
    isEnabled: false,
    time: "02:00",
    daysOfWeek: "*",
    retentionCount: 14,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunSummary: null,
  },
  driveConfigured: false,
  ...over,
});

const drive = (over: Record<string, unknown> = {}) => ({
  isEnabled: false,
  folderId: "",
  hasServiceAccountKey: false,
  lastUploadAt: null,
  lastUploadStatus: null,
  lastUploadSummary: null,
  ...over,
});

let page: RenderedPage | undefined;
let sent: Sent[];

beforeEach(() => {
  sent = [];
  toast.mockClear();
});
afterEach(() => {
  page?.unmount();
  page = undefined;
  vi.useRealTimers();
});

async function open({
  backup = status(),
  driveConfig = drive(),
  settings = { companyName: "UK Textiles", companyLogo: null, companyWideRulesEditable: true } as Record<
    string,
    unknown
  >,
  me = ADMIN,
}: {
  backup?: Record<string, unknown>;
  driveConfig?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  me?: Record<string, unknown>;
} = {}) {
  const record = (path: string) => (_params: URLSearchParams, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
      sent.push({ path, method, body });
    }
    return method;
  };
  page = await renderMdPage(
    () => <BackupTab />,
    {
      "/api/auth/me": me,
      "/api/backup": backup,
      "/api/payroll-settings": (params, init) => {
        record("/api/payroll-settings")(params, init);
        return settings;
      },
      "/api/backup/drive": (params, init) =>
        record("/api/backup/drive")(params, init) === "GET"
          ? driveConfig
          : { ...driveConfig, ...JSON.parse(String(init!.body)), hasServiceAccountKey: true },
      "/api/backup/schedule": (params, init) => {
        record("/api/backup/schedule")(params, init);
        return { ...(backup.schedule as object), ...JSON.parse(String(init!.body)) };
      },
      "/api/backup/run": (params, init) => {
        record("/api/backup/run")(params, init);
        return {
          ok: true,
          file: "UKTex_Full_backup_2026-10-12_10-00-00.zip",
          path: "x",
          sizeBytes: 7_340_032,
          backups: [],
        };
      },
      "/api/backup/drive/test": (params, init) => {
        record("/api/backup/drive/test")(params, init);
        return { ok: true, folderName: "UKTex Backups" };
      },
      "/api/backup/restore/validate": (params, init) => {
        record("/api/backup/restore/validate")(params, init);
        return {
          ok: true,
          stagedPath: "C:/app/backend/backup_staging/2026-10-12_10-00-00_UKTex_Full_backup_2026-08-24_16-23-56.zip",
          manifest: { createdAt: "2026-08-24T16:23:56" },
          mediaFileCount: 120,
          sizeBytes: 6_698_753,
          warnings: [],
          staleness: {
            backupCreatedAt: "2026-08-24T16:23:56",
            backupCounts: { employees: 398, payrollRecords: 9121, salarySlips: 2977 },
            currentCounts: { employees: 412, payrollRecords: 9880, salarySlips: 3150 },
            isOlderThanCurrentData: true,
          },
          guidedScript: "@echo off",
        };
      },
      "/api/backup/restore/run": (params, init) => {
        record("/api/backup/restore/run")(params, init);
        return { ok: true, message: "Restore started." };
      },
      "/api/backup/restore/status": { active: false, ok: true, detail: "Restore complete", step: "done" },
    },
    { path: "/hr/settings?tab=backup" },
  );
  return page;
}

const $ = <T extends Element = HTMLElement>(selector: string) =>
  (page!.container.querySelector<T>(selector) ?? document.body.querySelector<T>(selector))!;
const button = (name: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim().includes(name))!;
const posts = (path: string) => sent.filter((s) => s.path === path);

async function press(name: string) {
  await act(async () => {
    button(name).click();
  });
  await page!.settle();
}

describe("Backup tab", () => {
  it("draws every setting the search knows about, under the same title", async () => {
    await open();
    for (const meta of BACKUP_SETTINGS) {
      const block = $(`[data-setting-id="${meta.id}"]`);
      expect(block, meta.id).toBeTruthy();
      expect(block.querySelector("h4")!.textContent).toBe(meta.title);
      expect(block.querySelector('[data-testid="setting-purpose"]')!.textContent).toBe(meta.purpose);
    }
  });

  it("says truthfully where each copy goes: manual backups are never uploaded to Drive", async () => {
    await open();
    const routes = $('[data-testid="backup-routes"]').textContent;
    expect(routes).toContain("Not uploaded to Google Drive");
    expect(routes).toContain("Only a zip you upload under Restore Backup");
    expect(page!.text()).toContain("survives a redeploy");
    expect(page!.text()).toContain("only on the server disk");
  });

  it("saves the backup folder on its own, without running a backup", async () => {
    await open({ backup: status({ backupDirectory: "" }) });
    const input = $<HTMLInputElement>("#backup-directory-input");
    expect(input.value).toBe("");
    expect($('[data-setting-id="backup-directory"]').textContent).toContain("the application's own backups folder");
    await page!.type("#backup-directory-input", "D:\\Backups\\HR");
    expect($('[data-setting-id="backup-directory"]').textContent).toMatch(/D:\\Backups\\HR\\UKTex_Full_backup_\d{4}-/);
    await press("Save Backup Folder");
    expect(posts("/api/payroll-settings")).toEqual([
      { path: "/api/payroll-settings", method: "PUT", body: { backupDirectory: "D:\\Backups\\HR" } },
    ]);
    expect(posts("/api/backup/run")).toEqual([]);
  });

  it("runs a backup into the folder in the box, and refuses an empty one before asking the server", async () => {
    await open();
    await press("Run Backup Now");
    expect(posts("/api/backup/run")).toEqual([
      { path: "/api/backup/run", method: "POST", body: { directory: "D:/backups/uktextile" } },
    ]);
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Backup completed",
        description: expect.stringContaining("Only the newest 14 backup files are kept"),
      }),
    );
    await page!.type("#backup-directory-input", "  ");
    await press("Run Backup Now");
    expect(posts("/api/backup/run")).toHaveLength(1);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Enter a backup directory first" }));
  });

  it("makes a branch login save a new folder before running a backup", async () => {
    await open({ settings: { companyWideRulesEditable: false } });
    await page!.type("#backup-directory-input", "D:/branch-backups");
    expect(button("Run Backup Now").disabled).toBe(true);
    expect(page!.text()).toContain("Save the folder first.");
  });

  it("keeps 'Keep the last' editable while the schedule is off, since manual backups prune too", async () => {
    await open();
    expect($<HTMLInputElement>("#backup-retention-input").disabled).toBe(false);
    expect($('[data-setting-id="backup-schedule-days"]').textContent).toContain("no automatic backups");
  });

  it("asks before saving a smaller 'Keep the last', and saves only after the confirm", async () => {
    await open();
    await page!.type("#backup-retention-input", "3");
    expect($('[data-setting-id="backup-retention"]').textContent).toContain("Deleted from the folder");
    await press("Save Schedule");
    expect(posts("/api/backup/schedule")).toEqual([]);
    expect(document.body.textContent).toContain("Keep only the newest 3 backup files?");
    await press("Cancel");
    expect(posts("/api/backup/schedule")).toEqual([]);

    await press("Save Schedule");
    await press("Keep 3 and save");
    expect(posts("/api/backup/schedule")).toEqual([
      {
        path: "/api/backup/schedule",
        method: "PUT",
        body: { isEnabled: false, time: "02:00", daysOfWeek: "*", retentionCount: 3 },
      },
    ]);
  });

  it("shows the next automatic runs for the days picked and saves them in week order", async () => {
    vi.setSystemTime(new Date("2026-10-12T01:00:00+05:30"));
    await open({ backup: status({ schedule: { ...status().schedule, isEnabled: true } }) });
    await press("Fri");
    await press("Mon");
    const preview = $('[data-setting-id="backup-schedule-days"]').textContent ?? "";
    expect(preview).toMatch(/Next.*Mon.*12 Oct/);
    expect(preview).toMatch(/Then.*Fri.*16 Oct/);
    expect(preview).toMatch(/Then.*Mon.*19 Oct/);
    await press("Save Schedule");
    expect(posts("/api/backup/schedule")[0].body).toEqual({
      isEnabled: true,
      time: "02:00",
      daysOfWeek: "mon,fri",
      retentionCount: 14,
    });
  });

  it("will not switch Drive uploads on without a folder and a key", async () => {
    await open();
    await act(async () => {
      $<HTMLButtonElement>("#drive-enabled-switch").click();
    });
    await page!.settle();
    expect(page!.text()).toContain("needs a Shared Drive folder ID and a service account key");
    expect(button("Save Google Drive Settings").disabled).toBe(true);
  });

  it("reads a pasted key in the browser, saves it once, and never shows it again", async () => {
    await open();
    await page!.type("#drive-folder-input", "https://drive.google.com/drive/folders/1aBcD2eFgH3iJkL4mNoP5qRsT6uVwXyZ");
    expect(page!.text()).toContain("That is a folder link, not the ID");
    await press("Use this ID");
    expect($<HTMLInputElement>("#drive-folder-input").value).toBe("1aBcD2eFgH3iJkL4mNoP5qRsT6uVwXyZ");
    await page!.type("#drive-key-input", KEY);
    expect(page!.text()).toContain("backup-bot@uktex-backups.iam.gserviceaccount.com");
    await act(async () => {
      $<HTMLButtonElement>("#drive-enabled-switch").click();
    });
    await page!.settle();
    await press("Test Connection");
    expect(posts("/api/backup/drive/test")[0].body).toEqual({
      folderId: "1aBcD2eFgH3iJkL4mNoP5qRsT6uVwXyZ",
      serviceAccountJson: KEY,
    });
    await press("Save Google Drive Settings");
    expect(posts("/api/backup/drive")[0].body).toEqual({
      isEnabled: true,
      folderId: "1aBcD2eFgH3iJkL4mNoP5qRsT6uVwXyZ",
      serviceAccountJson: KEY,
    });
  });

  it("keeps a saved key unless a new one is pasted", async () => {
    await open({ driveConfig: drive({ hasServiceAccountKey: true, folderId: "1AbC", isEnabled: true }) });
    expect(page!.container.querySelector("#drive-key-input")).toBeNull();
    expect(page!.text()).toContain("A key is saved (hidden).");
    await page!.type("#drive-folder-input", "2XyZ");
    await press("Save Google Drive Settings");
    expect(posts("/api/backup/drive")[0].body).toEqual({ isEnabled: true, folderId: "2XyZ" });
  });

  it("restores only after a checked file, a confirm and the word RESTORE", async () => {
    await open();
    expect(button("Restore Now (Automated)").disabled).toBe(true);

    const input = $<HTMLInputElement>("#restore-backup-file");
    const file = new File(["zip"], "UKTex_Full_backup_2026-08-24_16-23-56.zip", { type: "application/zip" });
    await act(async () => {
      Object.defineProperty(input, "files", { value: [file], configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page!.settle();
    await press("Upload & Validate");
    expect(posts("/api/backup/restore/validate")).toHaveLength(1);
    expect(page!.text()).toContain("This backup is older than what's currently live");

    await press("Restore Now (Automated)");
    expect(document.body.textContent).toContain("Replace all live data with this backup?");
    expect(button("Confirm Restore").disabled).toBe(true);
    await page!.type("#restore-confirm-text", "restore");
    expect(button("Confirm Restore").disabled).toBe(true);
    await page!.type("#restore-confirm-text", "RESTORE");
    expect(posts("/api/backup/restore/run")).toEqual([]);
    await press("Confirm Restore");
    expect(posts("/api/backup/restore/run")).toEqual([
      {
        path: "/api/backup/restore/run",
        method: "POST",
        body: {
          stagedPath: "C:/app/backend/backup_staging/2026-10-12_10-00-00_UKTex_Full_backup_2026-08-24_16-23-56.zip",
        },
      },
    ]);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Backup restored successfully" }));
  });

  it("offers the automated restore to super admins only", async () => {
    await open({ me: { ...ADMIN, isSuperAdmin: false, permissions: { settings: "edit" } } });
    expect(button("Restore Now (Automated)")).toBeUndefined();
    expect(page!.text()).toContain("Your login is not a super admin: use the guided script.");
  });
});

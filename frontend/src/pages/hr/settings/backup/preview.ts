import type { BackupScheduleInfo } from "@/lib/api-client/custom-hooks";

/**
 * The Backup tab's rules, mirrored from the server so a value can be explained before it is saved:
 * backend/api/backup_service.py (file names, retention), backup_scheduler.py (the CronTrigger that runs the schedule, in
 * India time), backup_views.py (what the schedule and Google Drive saves accept) and google_drive.py (the key).
 */

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const WEEKDAY_LABEL: Record<Weekday, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};

/** Same steps as the old page: 1 decimal place is not enough for a few-MB backup, so two. */
export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

const two = (n: number) => String(n).padStart(2, "0");

/** backup_service.build_full_backup: UKTex_Full_backup_<YYYY-MM-DD_HH-MM-SS>.zip, from the server's own clock. */
export function backupFileName(at: Date): string {
  const date = `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;
  const time = `${two(at.getHours())}-${two(at.getMinutes())}-${two(at.getSeconds())}`;
  return `UKTex_Full_backup_${date}_${time}.zip`;
}

/** Where the file lands: the folder joined with the file name, with the separator the folder itself uses. */
export function backupPath(directory: string, fileName: string): string {
  const dir = directory.trim();
  if (!dir) return fileName;
  if (/[\\/]$/.test(dir)) return dir + fileName;
  return `${dir}${dir.includes("\\") && !dir.includes("/") ? "\\" : "/"}${fileName}`;
}

/** The weekdays a stored value means ("*" = every day; ranges such as mon-fri are spelled out). Null = every day. */
export function parseDays(daysOfWeek: string | null | undefined): Weekday[] | null {
  const text = (daysOfWeek ?? "").trim().toLowerCase().replace(/\s/g, "");
  if (!text || text === "*") return null;
  const picked = new Set<Weekday>();
  for (const token of text.split(",")) {
    const [from, to] = token.split("-") as [Weekday, Weekday | undefined];
    const a = WEEKDAYS.indexOf(from);
    const b = to === undefined ? a : WEEKDAYS.indexOf(to);
    if (a < 0 || b < 0) continue;
    for (let i = a; i <= b; i++) picked.add(WEEKDAYS[i]);
  }
  return picked.size === 0 || picked.size === 7 ? null : WEEKDAYS.filter((d) => picked.has(d));
}

/** What a save sends: "*" for every day, else the picked days in week order (the scheduler accepts both). */
export function daysValue(days: Weekday[] | null): string {
  if (!days || days.length === 0 || days.length === 7) return "*";
  return WEEKDAYS.filter((d) => days.includes(d)).join(",");
}

const IST_OFFSET_MS = 330 * 60_000;
const SUNDAY_FIRST: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/**
 * The next times the scheduled backup starts, as backup_scheduler's CronTrigger(hour, minute, day_of_week,
 * timezone="Asia/Kolkata") computes them: the first slot at or after `now`, then the following ones.
 */
export function nextRuns(now: Date, time: string, days: Weekday[] | null, count = 3): Date[] {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return [];
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const istNow = new Date(now.getTime() + IST_OFFSET_MS);
  const runs: Date[] = [];
  for (let offset = 0; runs.length < count && offset < 7 * count + 8; offset++) {
    const day = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate() + offset));
    if (days && !days.includes(SUNDAY_FIRST[day.getUTCDay()])) continue;
    const at = new Date(day.getTime() + (hour * 60 + minute) * 60_000 - IST_OFFSET_MS);
    if (at.getTime() >= now.getTime()) runs.push(at);
  }
  return runs;
}

/** "Mon 12 Oct, 02:00 AM" in India time, the zone the schedule runs in. */
export function istLabel(at: Date): string {
  return at.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * backup_service.prune_old_backups after a new backup: the newest `keep` zips in the folder stay, older ones are
 * deleted (0 keeps them all). The example folder holds one backup for each of the five days before `today`.
 */
export function retentionExample(keep: number, today: Date): { kept: string[]; deleted: string[] } {
  const label = (daysAgo: number) =>
    new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysAgo).toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
    });
  const newestFirst = [0, 1, 2, 3, 4, 5].map(label);
  if (keep <= 0) return { kept: newestFirst, deleted: [] };
  return { kept: newestFirst.slice(0, keep), deleted: newestFirst.slice(keep) };
}

/** A whole number of backups to keep (0 = keep all), or the reason it is not one. */
export function retentionProblem(text: string): string | null {
  return /^\d+$/.test(text.trim()) ? null : "Type a whole number of backups (0 keeps every backup).";
}

export type ScheduleForm = { isEnabled: boolean; time: string; days: Weekday[] | null; retention: string };

export function scheduleFormFrom(info: BackupScheduleInfo | undefined): ScheduleForm {
  return {
    isEnabled: info?.isEnabled ?? false,
    time: info?.time || "02:00",
    days: parseDays(info?.daysOfWeek),
    retention: String(info?.retentionCount ?? 14),
  };
}

export function sameSchedule(a: ScheduleForm, b: ScheduleForm): boolean {
  return (
    a.isEnabled === b.isEnabled &&
    a.time === b.time &&
    daysValue(a.days) === daysValue(b.days) &&
    a.retention.trim() === b.retention.trim()
  );
}

/** Saving a smaller "keep the last" deletes backup files at the next backup, so it is confirmed first. */
export function retentionCutsFiles(saved: ScheduleForm, form: ScheduleForm): boolean {
  if (retentionProblem(form.retention)) return false;
  const next = Number(form.retention.trim());
  const before = Number(saved.retention.trim());
  return next > 0 && (before === 0 || next < before);
}

/** The folder ID inside a pasted Google Drive folder link (https://drive.google.com/drive/folders/<id>), else null. */
export function folderIdFromLink(text: string): string | null {
  const match = /drive\.google\.com\/.*?(?:\/folders\/|[?&]id=)([A-Za-z0-9_-]+)/.exec(text.trim());
  return match ? match[1] : null;
}

export type KeyCheck =
  { ok: true; clientEmail: string; projectId: string | null; warning: string | null } | { ok: false; problem: string };

/** What google_drive._build_drive_service will make of a pasted key (it needs valid JSON with these fields). */
export function readServiceAccountKey(text: string): KeyCheck {
  let info: unknown;
  try {
    info = JSON.parse(text);
  } catch {
    return { ok: false, problem: "This is not valid JSON: paste the whole key file, from the first { to the last }." };
  }
  if (!info || typeof info !== "object" || Array.isArray(info)) {
    return { ok: false, problem: "This is not a key file: it should start with { and end with }." };
  }
  const key = info as Record<string, unknown>;
  const missing = ["client_email", "private_key", "token_uri"].filter((f) => typeof key[f] !== "string" || !key[f]);
  if (missing.length) return { ok: false, problem: `Google will refuse this key: it has no ${missing.join(", ")}.` };
  return {
    ok: true,
    clientEmail: String(key.client_email),
    projectId: typeof key.project_id === "string" ? key.project_id : null,
    warning:
      key.type === "service_account" ? null : 'This is not a service account key ("type" is not service_account).',
  };
}

/** backup_views.backup_drive_view: uploads cannot be switched on without both a folder and a key. */
export function driveProblem(isEnabled: boolean, folderId: string, hasKey: boolean): string | null {
  if (!isEnabled || (folderId.trim() && hasKey)) return null;
  return "Google Drive upload needs a Shared Drive folder ID and a service account key before it can be switched on.";
}

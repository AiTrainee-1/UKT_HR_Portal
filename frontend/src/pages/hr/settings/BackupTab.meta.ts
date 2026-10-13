import type { SettingMeta } from "./kit/catalog";

const MANUAL = "Manual Backup";
const SCHEDULE = "Scheduled Backup";
const DRIVE = "Google Drive (optional offsite copy)";
const RESTORE = "Restore Backup";
const BACKUP = ["backup", "zip", "database"];

/** Every setting on the Backup tab, for the page's search (see kit/catalog.ts). */
export const BACKUP_SETTINGS: SettingMeta[] = [
  {
    id: "backup-directory",
    tab: "backup",
    section: MANUAL,
    title: "Backup Directory (on the server machine)",
    purpose:
      "The folder on the application server (not on your computer) where backup zip files are written. It is created if it does not exist.",
    keywords: [...BACKUP, "folder", "directory", "path", "location", "server"],
  },
  {
    id: "backup-run-now",
    tab: "backup",
    section: MANUAL,
    title: "Take a backup now",
    purpose:
      "Makes a full backup immediately: the database dump plus every uploaded file, zipped into the folder above.",
    keywords: [...BACKUP, "run backup now", "manual", "pg_dump"],
  },
  {
    id: "backup-recent",
    tab: "backup",
    section: MANUAL,
    title: "Recent backups",
    purpose:
      "The newest backups the server still has (up to 20), from the backup folder and from the copies kept in the database. Download saves one to your computer: your copy away from the server.",
    keywords: [...BACKUP, "download", "list", "files"],
  },
  {
    id: "backup-schedule-enabled",
    tab: "backup",
    section: SCHEDULE,
    title: "Run automatically",
    purpose: "Turns the automatic backup on or off.",
    keywords: [...BACKUP, "schedule", "automatic", "scheduled", "on", "off", "last run"],
  },
  {
    id: "backup-schedule-time",
    tab: "backup",
    section: SCHEDULE,
    title: "Time of day",
    purpose:
      "The time, in India time, the automatic backup starts. Pick a quiet hour: dumping the database and zipping every file keeps the server busy.",
    keywords: [...BACKUP, "schedule", "time", "hour", "night"],
  },
  {
    id: "backup-schedule-days",
    tab: "backup",
    section: SCHEDULE,
    title: "Days",
    purpose: "Which weekdays the automatic backup runs.",
    keywords: [...BACKUP, "schedule", "weekdays", "every day", "next run"],
  },
  {
    id: "backup-retention",
    tab: "backup",
    section: SCHEDULE,
    title: "Keep the last",
    purpose:
      "How many of the newest backup files the backup folder keeps. After every successful backup, made by hand or automatically, older zips in the folder are deleted. 0 keeps them all.",
    keywords: [...BACKUP, "retention", "keep", "delete", "old backups", "prune", "count"],
  },
  {
    id: "drive-enabled",
    tab: "backup",
    section: DRIVE,
    title: "Upload backups to Google Drive",
    purpose:
      "Uploads a copy of every automatic (scheduled) backup to the Shared Drive folder below. Backups made with Run Backup Now are not uploaded.",
    keywords: [...BACKUP, "google drive", "drive", "offsite", "cloud", "upload", "last upload"],
  },
  {
    id: "drive-folder-id",
    tab: "backup",
    section: DRIVE,
    title: "Shared Drive Folder ID",
    purpose:
      "Which Google Drive folder receives the uploads. It must be inside a Shared Drive: a folder in someone's own My Drive connects, but the upload then fails because a service account has no storage of its own.",
    keywords: [...BACKUP, "google drive", "folder", "shared drive", "id"],
  },
  {
    id: "drive-key",
    tab: "backup",
    section: DRIVE,
    title: "Service Account Key (JSON)",
    purpose:
      "The Google service account key file that lets the server write to the folder without anyone's Google password. Once saved it is never shown again.",
    keywords: [...BACKUP, "google drive", "service account", "key", "json", "credentials", "client_email"],
  },
  {
    id: "restore-upload",
    tab: "backup",
    section: RESTORE,
    title: "Backup file to restore",
    purpose:
      "Choose a UKTex_Full_backup zip (downloaded from Recent backups or from Google Drive) and have it checked. Checking changes nothing live.",
    keywords: [...BACKUP, "restore", "upload", "validate", "check"],
  },
  {
    id: "restore-guided",
    tab: "backup",
    section: RESTORE,
    title: "Guided restore (script for IT)",
    purpose:
      "A Windows script that does the restore by hand on the server machine, with the application stopped: it unpacks the zip, drops and reloads the database and swaps the uploaded-files folder.",
    keywords: [...BACKUP, "restore", "script", "bat", "manual", "it"],
  },
  {
    id: "restore-automated",
    tab: "backup",
    section: RESTORE,
    title: "Automated restore",
    purpose: "The portal restores itself from the checked backup, after taking a safety backup of the current state.",
    keywords: [...BACKUP, "restore", "automatic", "super admin", "rollback"],
  },
];

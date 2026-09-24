// system: hooks/types split out of the former single custom-hooks.ts (see ./index.ts).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch, getApiOrigin } from "../custom-fetch";

// ── Database Backup (Settings → Backup) ───────────────────────────────────────

export type BackupFileItem = {
  file: string;
  sizeBytes: number;
  createdAt: string;
  /** True once this backup is in the database and safe from a redeploy
   *  wiping local disk -see the download helper below. */
  inDatabase?: boolean;
};

export type BackupScheduleInfo = {
  isEnabled: boolean;
  time: string | null;
  daysOfWeek: string;
  retentionCount: number;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunSummary: string | null;
};

export type BackupStatus = {
  backupDirectory: string;
  pgDumpAvailable: boolean;
  backups: BackupFileItem[];
  schedule: BackupScheduleInfo;
  driveConfigured: boolean;
};

export const getBackupStatusQueryKey = () => ["/api/backup"] as const;

export const useBackupStatus = () =>
  useQuery<BackupStatus>({
    queryKey: getBackupStatusQueryKey(),
    queryFn: () => customFetch<BackupStatus>("/api/backup"),
  });

export const useRunBackup = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (directory: string) =>
      customFetch<{ ok: boolean; file: string; path: string; sizeBytes: number; backups: BackupFileItem[] }>(
        "/api/backup/run",
        { method: "POST", body: JSON.stringify({ directory }) },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getBackupStatusQueryKey() });
    },
  });
};

export const useUpdateBackupSchedule = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { isEnabled: boolean; time: string; daysOfWeek: string; retentionCount: number }) =>
      customFetch<BackupScheduleInfo>("/api/backup/schedule", { method: "PUT", body: JSON.stringify(data) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getBackupStatusQueryKey() });
    },
  });
};

export type BackupDriveInfo = {
  isEnabled: boolean;
  folderId: string;
  hasServiceAccountKey: boolean;
  lastUploadAt: string | null;
  lastUploadStatus: string | null;
  lastUploadSummary: string | null;
};

export const getBackupDriveQueryKey = () => ["/api/backup/drive"] as const;

export const useDriveConfig = () =>
  useQuery<BackupDriveInfo>({
    queryKey: getBackupDriveQueryKey(),
    queryFn: () => customFetch<BackupDriveInfo>("/api/backup/drive"),
  });

export const useUpdateDriveConfig = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { isEnabled: boolean; folderId: string; serviceAccountJson?: string }) =>
      customFetch<BackupDriveInfo>("/api/backup/drive", { method: "PUT", body: JSON.stringify(data) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getBackupDriveQueryKey() });
      queryClient.invalidateQueries({ queryKey: getBackupStatusQueryKey() });
    },
  });
};

export const useTestDriveConnection = () =>
  useMutation({
    mutationFn: (data: { folderId?: string; serviceAccountJson?: string }) =>
      customFetch<{ ok: boolean; folderName?: string; warning?: string }>("/api/backup/drive/test", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });

export type RestoreStaleness = {
  backupCreatedAt?: string;
  backupCounts: { employees: number; payrollRecords: number; salarySlips: number };
  currentCounts: { employees: number; payrollRecords: number; salarySlips: number };
  isOlderThanCurrentData: boolean;
} | null;

export type RestoreValidateResult = {
  ok: boolean;
  stagedPath: string;
  manifest: { createdAt?: string; dbName?: string; mediaFileCount?: number };
  mediaFileCount: number;
  sizeBytes: number;
  warnings: string[];
  staleness: RestoreStaleness;
  guidedScript: string;
};

/** Raw fetch + FormData, not customFetch -multipart bodies aren't JSON.
 * Mirrors ManualPunchImport.tsx's handleUpload exactly. */
export const uploadRestoreFile = async (file: File, token: string | null): Promise<RestoreValidateResult> => {
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetch(`${getApiOrigin()}/api/backup/restore/validate`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: formData,
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error((body as { error?: string }).error ?? "Failed to validate backup file");
  }
  return body as RestoreValidateResult;
};

export const runAutomatedRestore = async (
  stagedPath: string,
  token: string | null,
): Promise<{ ok: boolean; message: string }> => {
  const response = await fetch(`${getApiOrigin()}/api/backup/restore/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ stagedPath }),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error((body as { error?: string }).error ?? "Failed to start restore");
  }
  return body as { ok: boolean; message: string };
};

export type RestoreStatus = {
  active: boolean;
  step?: string;
  detail?: string;
  ok?: boolean | null;
  updatedAt?: string;
};

export const useRestoreStatus = (enabled: boolean) =>
  useQuery<RestoreStatus>({
    queryKey: ["/api/backup/restore/status"],
    queryFn: () => customFetch<RestoreStatus>("/api/backup/restore/status"),
    enabled,
    refetchInterval: (query) => (query.state.data?.active ? 2000 : false),
  });

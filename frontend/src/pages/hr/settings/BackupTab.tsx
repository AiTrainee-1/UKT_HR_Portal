import { Skeleton } from "@/components/ui/skeleton";
import { useBackupStatus, usePayrollSettings } from "@/lib/api-client/custom-hooks";
import { useLevel } from "@/lib/tab-access";
import { BACKUP_FEATURE_MODULE } from "./constants";
import { DriveSection } from "./backup/DriveSection";
import { HowItWorks } from "./backup/HowItWorks";
import { ManualBackupSection } from "./backup/ManualBackupSection";
import { RestoreSection } from "./backup/RestoreSection";
import { ScheduleSection } from "./backup/ScheduleSection";

/**
 * Settings -> Backup: full backups (database + uploaded files) made by hand or on a schedule, an optional Google Drive
 * copy of the scheduled ones, and restoring the whole system from a backup zip. Each part lives in ./backup/.
 *
 * Schedule, Google Drive and Restore each have their own permission key (they follow the tab while unset): a hidden one is
 * not drawn, a View-only one is drawn read-only (its fields and buttons disabled, as for a View-only tab).
 */
export default function BackupTab({ readOnly = false }: { readOnly?: boolean }) {
  const { data: status, isLoading } = useBackupStatus();
  const { data: settings } = usePayrollSettings();
  const branchLogin = settings?.companyWideRulesEditable === false;
  const levelOf = useLevel();
  const part = (feature: "schedule" | "drive" | "restore") => levelOf(BACKUP_FEATURE_MODULE[feature]);
  const shows = (feature: "schedule" | "drive" | "restore") => part(feature) !== "hidden";
  const locked = (feature: "schedule" | "drive" | "restore") => readOnly || part(feature) !== "edit";

  if (isLoading && !status) {
    return <Skeleton className="h-96 w-full rounded-2xl" data-testid="backup-loading" />;
  }

  return (
    <div className="space-y-4">
      <HowItWorks />
      <ManualBackupSection status={status} readOnly={readOnly} branchLogin={branchLogin} />
      {shows("schedule") && <ScheduleSection schedule={status?.schedule} readOnly={locked("schedule")} />}
      {shows("drive") && (
        <DriveSection
          driveConfigured={status?.driveConfigured}
          scheduleEnabled={Boolean(status?.schedule?.isEnabled)}
          readOnly={locked("drive")}
        />
      )}
      {shows("restore") && <RestoreSection readOnly={locked("restore")} />}
    </div>
  );
}

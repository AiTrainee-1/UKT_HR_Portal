import { Skeleton } from "@/components/ui/skeleton";
import { useBackupStatus, usePayrollSettings } from "@/lib/api-client/custom-hooks";
import { DriveSection } from "./backup/DriveSection";
import { HowItWorks } from "./backup/HowItWorks";
import { ManualBackupSection } from "./backup/ManualBackupSection";
import { RestoreSection } from "./backup/RestoreSection";
import { ScheduleSection } from "./backup/ScheduleSection";

/**
 * Settings -> Backup: full backups (database + uploaded files) made by hand or on a schedule, an optional Google Drive
 * copy of the scheduled ones, and restoring the whole system from a backup zip. Each part lives in ./backup/.
 */
export default function BackupTab({ readOnly = false }: { readOnly?: boolean }) {
  const { data: status, isLoading } = useBackupStatus();
  const { data: settings } = usePayrollSettings();
  const branchLogin = settings?.companyWideRulesEditable === false;

  if (isLoading && !status) {
    return <Skeleton className="h-96 w-full rounded-2xl" data-testid="backup-loading" />;
  }

  return (
    <div className="space-y-4">
      <HowItWorks />
      <ManualBackupSection status={status} readOnly={readOnly} branchLogin={branchLogin} />
      <ScheduleSection schedule={status?.schedule} readOnly={readOnly} />
      <DriveSection
        driveConfigured={status?.driveConfigured}
        scheduleEnabled={Boolean(status?.schedule?.isEnabled)}
        readOnly={readOnly}
      />
      <RestoreSection readOnly={readOnly} />
    </div>
  );
}

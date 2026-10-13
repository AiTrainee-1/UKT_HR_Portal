import { useEffect, useState } from "react";
import { AlertTriangle, Database, FileDown, Loader2, RotateCcw, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import {
  runAutomatedRestore,
  uploadRestoreFile,
  useRestoreStatus,
  type RestoreValidateResult,
} from "@/lib/api-client/custom-hooks";
import { SettingBlock, SettingsSection } from "../kit/SettingBlock";
import { ConfirmDialog } from "./ConfirmDialog";
import { formatSize } from "./preview";

const when = (iso: string | undefined) => (iso ? new Date(iso).toLocaleString("en-IN") : "an unknown date");

/** What the validation found: the backup's date and size, and how it compares with what is live now. */
function ValidationResult({ validated }: { validated: RestoreValidateResult }) {
  const s = validated.staleness;
  return (
    <div className="space-y-3" data-testid="restore-validated">
      <div className="space-y-1 rounded-lg border border-green-100 bg-green-50 p-3 text-xs text-green-700">
        <p>Backup date: {validated.manifest.createdAt ? when(validated.manifest.createdAt) : "unknown"}</p>
        <p>
          Size: {formatSize(validated.sizeBytes)} · Files: {validated.mediaFileCount}
        </p>
      </div>
      {s?.isOlderThanCurrentData && (
        <div className="space-y-1.5 rounded-lg border-2 border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
          <p className="flex items-center gap-1.5 font-bold">
            <AlertTriangle size={13} /> This backup is older than what's currently live
          </p>
          <p>
            Restoring will discard everything created since{" "}
            {s.backupCreatedAt ? when(s.backupCreatedAt) : "this backup"}.
          </p>
          <p className="tabular-nums">
            Current: <strong>{s.currentCounts.employees}</strong> employees,{" "}
            <strong>{s.currentCounts.payrollRecords}</strong> payroll records,{" "}
            <strong>{s.currentCounts.salarySlips}</strong> salary slips - this backup:{" "}
            <strong>{s.backupCounts.employees}</strong> employees, <strong>{s.backupCounts.payrollRecords}</strong>{" "}
            payroll records, <strong>{s.backupCounts.salarySlips}</strong> salary slips
          </p>
        </div>
      )}
      {s === null && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-500">
          This is an older-format backup with no row counts recorded, so staleness can't be compared automatically:
          check the backup date above carefully before restoring.
        </div>
      )}
    </div>
  );
}

/**
 * Restore Backup: upload a backup zip and have it checked (nothing live changes), then either download a script for
 * IT to run by hand or, for a super admin, restore it automatically after typing RESTORE in a confirm dialog.
 */
export function RestoreSection({ readOnly }: { readOnly: boolean }) {
  const { toast } = useToast();
  const { user, token } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validated, setValidated] = useState<RestoreValidateResult | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [restoring, setRestoring] = useState(false);
  const { data: restoreStatus } = useRestoreStatus(restoring);

  // Tells the outcome once, when a restore goes from running to finished.
  useEffect(() => {
    if (!restoring || !restoreStatus || restoreStatus.active) return;
    if (restoreStatus.ok) {
      toast({ title: "Backup restored successfully", description: restoreStatus.detail });
    } else {
      toast({ title: "Restore failed", description: restoreStatus.detail, variant: "destructive" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoring, restoreStatus?.active, restoreStatus?.ok]);

  const pickFile = (f: File | null) => {
    setFile(f);
    setValidated(null);
  };

  const validate = async () => {
    if (!file) return;
    setValidating(true);
    try {
      const result = await uploadRestoreFile(file, token);
      setValidated(result);
      toast(
        result.warnings.length
          ? { title: "Backup validated with warnings", description: result.warnings.join(" ") }
          : { title: "Backup validated", description: "Review the details below before restoring." },
      );
    } catch (e) {
      toast({
        title: "Validation failed",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setValidating(false);
    }
  };

  const downloadScript = () => {
    if (!validated) return;
    const url = URL.createObjectURL(new Blob([validated.guidedScript], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "restore_uktextiles.bat";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const closeConfirm = (open: boolean) => {
    setConfirmOpen(open);
    if (!open) setConfirmText("");
  };

  const startRestore = async () => {
    if (!validated || confirmText !== "RESTORE") return;
    closeConfirm(false);
    setRestoring(true);
    try {
      await runAutomatedRestore(validated.stagedPath, token);
      toast({ title: "Restore started", description: "The application will be briefly unavailable." });
    } catch (e) {
      setRestoring(false);
      toast({
        title: "Failed to start restore",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  const backupDate = validated?.manifest.createdAt ? when(validated.manifest.createdAt) : "the backup's date";

  return (
    <SettingsSection
      icon={RotateCcw}
      title="Restore Backup"
      purpose="Brings the whole portal back to the moment a backup was taken. It reads only the zip you upload here, never the backup folder or Google Drive."
      testId="backup-restore-section"
    >
      <div className="mb-3 rounded-lg border border-red-100 bg-red-50 p-3 text-xs leading-relaxed text-red-700">
        Restoring replaces the whole live system with what is inside the backup: every table in the database (employees,
        attendance, payroll, users and roles, and all settings, this page's included) and every uploaded file. Anything
        created since that backup was taken disappears from the live app. The automated restore first takes a safety
        backup of the current state into the backup folder, so it can be undone from there; the guided script does not.
      </div>

      {restoring && restoreStatus ? (
        <div className="space-y-1 rounded-lg border border-blue-100 bg-blue-50 p-4 text-sm text-blue-700" role="status">
          <p className="font-semibold">
            {restoreStatus.active
              ? "Restoring… do not close this page"
              : restoreStatus.ok
                ? "Restore complete"
                : "Restore failed"}
          </p>
          <p className="text-xs">{restoreStatus.detail}</p>
        </div>
      ) : (
        <>
          <SettingBlock
            id="restore-upload"
            labelFor={file ? undefined : "restore-backup-file"}
            title="Backup file to restore"
            purpose="Choose a UKTex_Full_backup zip (downloaded from Recent backups or from Google Drive) and have it checked. Checking changes nothing live."
            affects={[
              {
                where: "Upload & Validate",
                what: "checks that the zip is a real backup (database dump inside, no damaged files) and compares its employee, payroll and slip counts with what is live",
              },
            ]}
            note="An uploaded file stays on the server's disk after it has been checked."
          >
            {!file ? (
              <label
                htmlFor="restore-backup-file"
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragActive(true);
                }}
                onDragLeave={() => setDragActive(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragActive(false);
                  pickFile(e.dataTransfer.files?.[0] ?? null);
                }}
                className={`relative flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed p-7 text-center transition-all ${
                  dragActive ? "border-red-400 bg-red-50" : "border-gray-200 bg-gray-50/50 hover:border-red-300"
                }`}
              >
                <input
                  id="restore-backup-file"
                  type="file"
                  accept=".zip"
                  disabled={readOnly}
                  onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                />
                <Upload size={20} className="text-gray-400" />
                <p className="text-sm font-medium text-gray-600">Drop a backup .zip here, or click to browse</p>
              </label>
            ) : (
              <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 p-3">
                <div className="flex min-w-0 items-center gap-2 text-sm">
                  <Database size={15} className="shrink-0 text-gray-400" />
                  <span className="truncate font-medium">{file.name}</span>
                  <span className="shrink-0 text-xs text-gray-400">{formatSize(file.size)}</span>
                </div>
                <button
                  type="button"
                  onClick={() => pickFile(null)}
                  className="text-gray-400 hover:text-red-500"
                  aria-label="Choose another file"
                >
                  <X size={15} />
                </button>
              </div>
            )}
            {file && !validated && (
              <Button size="sm" onClick={validate} disabled={readOnly || validating} className="gap-1.5">
                {validating ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                {validating ? "Validating…" : "Upload & Validate"}
              </Button>
            )}
            {validated && <ValidationResult validated={validated} />}
          </SettingBlock>

          <SettingBlock
            id="restore-guided"
            title="Guided restore (script for IT)"
            purpose="A Windows script that does the restore by hand on the server machine, with the application stopped: it unpacks the zip, drops and reloads the database and swaps the uploaded-files folder."
            affects={[
              { where: "Nothing", what: "until someone runs the script on the server; then everything is replaced" },
            ]}
            note="The script takes no safety backup, and it contains the database password in plain text: keep it private and delete it after use."
          >
            <Button
              size="sm"
              variant="outline"
              onClick={downloadScript}
              disabled={readOnly || !validated}
              className="gap-1.5"
            >
              <FileDown size={13} /> Download Restore Script + Instructions
            </Button>
            {!validated && <p className="text-xs text-gray-500">Check a backup file above first.</p>}
          </SettingBlock>

          <SettingBlock
            id="restore-automated"
            tone="danger"
            title="Automated restore"
            purpose="The portal restores itself from the checked backup, after taking a safety backup of the current state."
            affects={[
              {
                where: "Everyone",
                what: "every page, the employee web and mobile apps and the biometric devices' pushes are refused (under maintenance) until it finishes",
              },
              {
                where: "All live data",
                what: `goes back to ${backupDate}: everything recorded since then is gone from the live app (it stays in the safety backup)`,
              },
              {
                where: "Automatic jobs",
                what: "the backup schedule and other timed jobs keep their old timing until the server is restarted",
              },
            ]}
            note="Only a super admin can start it, after typing RESTORE to confirm."
          >
            {user?.isSuperAdmin ? (
              <>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => setConfirmOpen(true)}
                  disabled={readOnly || !validated}
                  className="gap-1.5"
                >
                  <RotateCcw size={13} /> Restore Now (Automated)
                </Button>
                {!validated && <p className="text-xs text-gray-500">Check a backup file above first.</p>}
              </>
            ) : (
              <p className="text-xs text-gray-500">Your login is not a super admin: use the guided script.</p>
            )}
          </SettingBlock>
        </>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={closeConfirm}
        title="Replace all live data with this backup?"
        confirmLabel="Confirm Restore"
        onConfirm={startRestore}
        confirmDisabled={confirmText !== "RESTORE"}
        destructive
        testId="restore-confirm"
        extra={
          <div className="space-y-1.5">
            <label htmlFor="restore-confirm-text" className="text-xs font-semibold text-gray-700">
              This will replace all live data. Type RESTORE to confirm.
            </label>
            <Input
              id="restore-confirm-text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="RESTORE"
              autoComplete="off"
            />
          </div>
        }
      >
        <p>
          Everything goes back to <b>{backupDate}</b>: employees, attendance, payroll, requests, users and settings
          recorded since then disappear from the live app.
        </p>
        <p>
          A safety backup of the current state is taken first, into the backup folder. While the restore runs, the whole
          portal, the employee apps and the biometric devices are offline.
        </p>
      </ConfirmDialog>
    </SettingsSection>
  );
}

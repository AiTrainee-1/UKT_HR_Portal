import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { Clock, Database, Upload, X, AlertTriangle, Download } from "lucide-react";
import {
  useBackupStatus,
  useRunBackup,
  useUpdateBackupSchedule,
  useDriveConfig,
  useUpdateDriveConfig,
  useTestDriveConnection,
  uploadRestoreFile,
  runAutomatedRestore,
  useRestoreStatus,
  type BackupScheduleInfo,
  type RestoreValidateResult,
  type BackupFileItem,
  downloadAuthedFile,
} from "@/lib/api-client/custom-hooks";
import { TimePicker12h } from "@/components/ui/time-picker-12h";
import { useAuth } from "@/contexts/AuthContext";

const DAY_OPTIONS: { value: string; label: string }[] = [
  { value: "mon", label: "Mon" },
  { value: "tue", label: "Tue" },
  { value: "wed", label: "Wed" },
  { value: "thu", label: "Thu" },
  { value: "fri", label: "Fri" },
  { value: "sat", label: "Sat" },
  { value: "sun", label: "Sun" },
];

const RECENT_BACKUPS_VISIBLE = 3;

function formatBackupFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function RecentBackupsList({ backups }: { backups: BackupFileItem[] }) {
  const { token } = useAuth();
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const visible = expanded ? backups : backups.slice(0, RECENT_BACKUPS_VISIBLE);
  const hiddenCount = backups.length - visible.length;

  const handleDownload = async (file: string) => {
    setDownloading(file);
    try {
      // Always a fresh fetch from the server -this endpoint reads the
      // database copy (falling back to local disk only for a backup made
      // before that existed), never anything cached in the browser. That is
      // what "fetched from the cloud at that moment" means here.
      await downloadAuthedFile(`/api/backup/download/${encodeURIComponent(file)}`, file, () => token);
    } catch (e: any) {
      toast({ title: "Download failed", description: e?.message, variant: "destructive" });
    } finally {
      setDownloading(null);
    }
  };

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-gray-600">Recent backups</p>
      <div className="border rounded-lg divide-y">
        {visible.map((b) => (
          <div key={b.file} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
            <div className="min-w-0">
              <span className="font-mono text-gray-700 truncate block">{b.file}</span>
              <span className="text-gray-400">
                {formatBackupFileSize(b.sizeBytes)} · {new Date(b.createdAt).toLocaleString("en-IN")}
              </span>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 gap-1.5"
              disabled={downloading === b.file}
              onClick={() => handleDownload(b.file)}
            >
              <Download size={13} />
              {downloading === b.file ? "Downloading…" : "Download"}
            </Button>
          </div>
        ))}
      </div>
      {hiddenCount > 0 && (
        <button type="button" onClick={() => setExpanded(true)} className="text-xs font-semibold text-purple-600">
          … {hiddenCount} more
        </button>
      )}
      {expanded && backups.length > RECENT_BACKUPS_VISIBLE && (
        <button type="button" onClick={() => setExpanded(false)} className="text-xs font-semibold text-purple-600 ml-3">
          Show less
        </button>
      )}
    </div>
  );
}

function BackupScheduleCard({ schedule }: { schedule: BackupScheduleInfo | undefined }) {
  const { toast } = useToast();
  const updateSchedule = useUpdateBackupSchedule();
  const [isEnabled, setIsEnabled] = useState(false);
  const [time, setTime] = useState("02:00");
  const [days, setDays] = useState<string[]>(["*"]);
  const [retentionCount, setRetentionCount] = useState(14);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (schedule && !loaded) {
      setIsEnabled(schedule.isEnabled);
      setTime(schedule.time || "02:00");
      setDays(schedule.daysOfWeek === "*" ? ["*"] : schedule.daysOfWeek.split(",").filter(Boolean));
      setRetentionCount(schedule.retentionCount);
      setLoaded(true);
    }
  }, [schedule, loaded]);

  const toggleDay = (day: string) => {
    setDays((prev) => {
      const withoutStar = prev.filter((d) => d !== "*");
      const next = withoutStar.includes(day) ? withoutStar.filter((d) => d !== day) : [...withoutStar, day];
      return next.length === 0 ? ["*"] : next;
    });
  };

  const save = async () => {
    try {
      await updateSchedule.mutateAsync({
        isEnabled,
        time,
        daysOfWeek: days.join(","),
        retentionCount,
      });
      toast({ title: "Backup schedule saved" });
    } catch (err) {
      toast({
        title: "Failed to save schedule",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    }
  };

  return (
    <Card className="border-0 shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-bold flex items-center gap-2">
          <Clock size={15} className="text-purple-500" /> Scheduled Backup
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Run automatically</p>
            <p className="text-[11px] text-gray-400">
              Creates a full backup on the schedule below, with no one needing to click anything.
            </p>
          </div>
          <Switch checked={isEnabled} onCheckedChange={setIsEnabled} />
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <TimePicker12h label="Time of day" value={time} onChange={setTime} disabled={!isEnabled} />
          <div className="space-y-1.5">
            <Label className="text-xs">Keep the last</Label>
            <Input
              type="number"
              min={0}
              value={retentionCount}
              disabled={!isEnabled}
              onChange={(e) => setRetentionCount(Math.max(0, parseInt(e.target.value, 10) || 0))}
              className="w-24"
            />
            <p className="text-[11px] text-gray-400">
              Older local backups beyond this count are deleted automatically after each successful run. 0 = keep all.
            </p>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Days</Label>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              disabled={!isEnabled}
              onClick={() => setDays(["*"])}
              className={`text-xs px-2.5 py-1 rounded-full border ${days.includes("*") ? "bg-purple-600 text-white border-purple-600" : "border-gray-200 text-gray-500"}`}
            >
              Every day
            </button>
            {DAY_OPTIONS.map((d) => (
              <button
                key={d.value}
                type="button"
                disabled={!isEnabled}
                onClick={() => toggleDay(d.value)}
                className={`text-xs px-2.5 py-1 rounded-full border ${!days.includes("*") && days.includes(d.value) ? "bg-purple-600 text-white border-purple-600" : "border-gray-200 text-gray-500"}`}
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>

        {schedule?.lastRunAt && (
          <p className="text-[11px] text-gray-400">
            Last run: {new Date(schedule.lastRunAt).toLocaleString("en-IN")} —{" "}
            <span className={schedule.lastRunStatus === "success" ? "text-green-600" : "text-red-500"}>
              {schedule.lastRunStatus === "success" ? "Succeeded" : "Failed"}
            </span>
            {schedule.lastRunSummary ? ` (${schedule.lastRunSummary})` : ""}
          </p>
        )}

        <Button size="sm" onClick={save} disabled={updateSchedule.isPending}>
          {updateSchedule.isPending ? "Saving…" : "Save Schedule"}
        </Button>
      </CardContent>
    </Card>
  );
}

function DriveConfigCard() {
  const { toast } = useToast();
  const { data: drive } = useDriveConfig();
  const updateDrive = useUpdateDriveConfig();
  const testConnection = useTestDriveConnection();
  const [isEnabled, setIsEnabled] = useState(false);
  const [folderId, setFolderId] = useState("");
  const [serviceAccountJson, setServiceAccountJson] = useState("");
  const [replacingKey, setReplacingKey] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);

  useEffect(() => {
    if (drive && !loaded) {
      setIsEnabled(drive.isEnabled);
      setFolderId(drive.folderId);
      setReplacingKey(!drive.hasServiceAccountKey);
      setLoaded(true);
    }
  }, [drive, loaded]);

  // Whether the key textarea (rather than the "Replace key" button) is what's
  // actually on screen right now -the only correct signal for "is there a
  // freshly-typed/pasted key to send." Deliberately not just `replacingKey`:
  // that flag starts false and only flips once the initial GET resolves, but
  // the textarea already renders before that (whenever no key is saved yet),
  // so gating on `replacingKey` alone could silently drop a pasted key.
  const keyInputVisible = !(drive?.hasServiceAccountKey && !replacingKey);

  const save = async () => {
    try {
      await updateDrive.mutateAsync({
        isEnabled,
        folderId,
        ...(keyInputVisible && serviceAccountJson.trim() ? { serviceAccountJson } : {}),
      });
      toast({ title: "Google Drive settings saved" });
      setServiceAccountJson("");
      setReplacingKey(false);
    } catch (err) {
      toast({
        title: "Failed to save",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    }
  };

  const test = async () => {
    try {
      const result = await testConnection.mutateAsync({
        folderId,
        ...(keyInputVisible && serviceAccountJson.trim() ? { serviceAccountJson } : {}),
      });
      if (result.warning) {
        toast({ title: "Connected, but check this first", description: result.warning, variant: "destructive" });
      } else {
        toast({
          title: "Connection successful",
          description: result.folderName ? `Folder: ${result.folderName}` : undefined,
        });
      }
    } catch (err) {
      toast({
        title: "Connection failed",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    }
  };

  return (
    <Card className="border-0 shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-bold flex items-center gap-2">
          <Upload size={15} className="text-purple-500" /> Google Drive (optional offsite copy)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-gray-500">
          Local storage is always the primary backup and the only place Restore reads from. Turning this on additionally
          uploads a copy of every backup to a Google Drive folder, in case something ever happens to this server itself.
        </p>

        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">Upload backups to Google Drive</p>
          <Switch checked={isEnabled} onCheckedChange={setIsEnabled} />
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label className="text-xs">Shared Drive Folder ID</Label>
            <Input
              value={folderId}
              onChange={(e) => setFolderId(e.target.value)}
              placeholder="1AbCDefGhIJklmNoPQRstuVWxyz"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Service Account Key (JSON)</Label>
            {!keyInputVisible ? (
              <Button size="sm" variant="outline" onClick={() => setReplacingKey(true)}>
                Replace key
              </Button>
            ) : (
              <textarea
                value={serviceAccountJson}
                onChange={(e) => setServiceAccountJson(e.target.value)}
                placeholder='{"type": "service_account", ...}'
                rows={3}
                className="w-full rounded-md border px-3 py-2 text-xs font-mono bg-background"
              />
            )}
          </div>
        </div>

        {drive?.lastUploadAt && (
          <p className="text-[11px] text-gray-400">
            Last upload: {new Date(drive.lastUploadAt).toLocaleString("en-IN")} —{" "}
            <span className={drive.lastUploadStatus === "success" ? "text-green-600" : "text-red-500"}>
              {drive.lastUploadStatus === "success" ? "Succeeded" : "Failed"}
            </span>
            {drive.lastUploadSummary ? ` (${drive.lastUploadSummary})` : ""}
          </p>
        )}

        <div className="flex items-center gap-2">
          <Button size="sm" onClick={save} disabled={updateDrive.isPending}>
            {updateDrive.isPending ? "Saving…" : "Save"}
          </Button>
          <Button size="sm" variant="outline" onClick={test} disabled={testConnection.isPending}>
            {testConnection.isPending ? "Testing…" : "Test Connection"}
          </Button>
        </div>

        <button
          type="button"
          onClick={() => setShowInstructions((s) => !s)}
          className="text-xs font-semibold text-purple-600"
        >
          {showInstructions ? "Hide" : "Show"} Complete Instructions
        </button>
        {showInstructions && (
          <div className="text-xs text-gray-500 space-y-4 p-3 rounded-lg bg-gray-50 border border-gray-100">
            <p>
              These steps set up a <strong>Service Account</strong> -a bot account that lets this application connect to
              your Google Drive securely, without needing your personal Google password.
            </p>

            <div className="space-y-1.5">
              <p className="font-semibold text-gray-700">1. Create a Google Cloud Project</p>
              <ol className="list-decimal pl-4 space-y-1">
                <li>Go to the Google Cloud Console and log in with your Google account.</li>
                <li>In the top-left navigation bar, click the project dropdown (it might say "Select a project").</li>
                <li>
                  Click <strong>New Project</strong> in the top right of the dialog.
                </li>
                <li>
                  Give it a name (e.g. "Drive-Integration") and click <strong>Create</strong>. Once it's ready, make
                  sure it's selected in the top-left dropdown.
                </li>
              </ol>
            </div>

            <div className="space-y-1.5">
              <p className="font-semibold text-gray-700">2. Enable the Google Drive API</p>
              <ol className="list-decimal pl-4 space-y-1">
                <li>
                  In your new project, use the top search bar to search for <strong>Google Drive API</strong>.
                </li>
                <li>Click on it in the search results.</li>
                <li>
                  Click the blue <strong>Enable</strong> button.
                </li>
              </ol>
            </div>

            <div className="space-y-1.5">
              <p className="font-semibold text-gray-700">3. Create the Service Account and JSON Key</p>
              <p className="italic">Keep the downloaded JSON file secure -it acts as a password to your Drive files.</p>
              <ol className="list-decimal pl-4 space-y-1">
                <li>
                  Open the left-side navigation menu and go to <strong>IAM &amp; Admin → Service Accounts</strong>.
                </li>
                <li>
                  Click <strong>+ Create Service Account</strong> at the top of the page.
                </li>
                <li>
                  Give it a name and click <strong>Create and Continue</strong>, then click <strong>Done</strong> (you
                  can skip the optional role assignments).
                </li>
                <li>
                  Find your new service account in the list, click the three-dot menu next to it, and select{" "}
                  <strong>Manage keys</strong>.
                </li>
                <li>
                  Click <strong>Add Key → Create new key</strong>.
                </li>
                <li>
                  Choose <strong>JSON</strong> and click <strong>Create</strong> -the file downloads automatically.
                </li>
              </ol>
            </div>

            <div className="space-y-1.5">
              <p className="font-semibold text-gray-700">4. Grant the Service Account Access to Drive</p>
              <ol className="list-decimal pl-4 space-y-1">
                <li>Open the downloaded JSON file in any text editor.</li>
                <li>
                  Find the <code>client_email</code> field and copy the email address next to it (looks like{" "}
                  <code>your-app@your-project.iam.gserviceaccount.com</code>).
                </li>
                <li>
                  Go to Google Drive and open (or create) a <strong>Shared Drive</strong> -a regular "My Drive" folder
                  won't work, since service accounts have no storage quota outside a Shared Drive.
                </li>
                <li>
                  Right-click the Shared Drive (or a folder inside it) and select <strong>Share</strong>.
                </li>
                <li>
                  Paste the <code>client_email</code> address into the "Add people and groups" field.
                </li>
                <li>
                  Change the role to <strong>Content Manager</strong> (or Editor).
                </li>
                <li>
                  Uncheck "Notify people" (it's a bot account, it won't read the email) and click <strong>Share</strong>
                  .
                </li>
              </ol>
            </div>

            <div className="space-y-1.5">
              <p className="font-semibold text-gray-700">5. Get the Folder ID</p>
              <ol className="list-decimal pl-4 space-y-1">
                <li>Open that same Shared Drive or folder so you're looking at the files inside it.</li>
                <li>
                  Look at the URL in your browser's address bar -it looks like{" "}
                  <code>https://drive.google.com/drive/folders/1aBcD2eFgH3iJkL4mNoP5qRsT6uVwXyZ</code>.
                </li>
                <li>The Folder ID is the long string of letters and numbers at the end of the URL.</li>
              </ol>
            </div>

            <p>
              Once you have both the Folder ID and the JSON key, paste them into the fields above, click{" "}
              <strong>Test Connection</strong>, then <strong>Save</strong>.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RestoreBackupCard() {
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

  // Fires once when a restore transitions from active -> finished (ok
  // becomes true/false), so the outcome is impossible to miss even if HR
  // isn't staring at the inline status box the whole time.
  useEffect(() => {
    if (!restoring || !restoreStatus || restoreStatus.active) return;
    if (restoreStatus.ok) {
      toast({ title: "Backup restored successfully", description: restoreStatus.detail });
    } else {
      toast({ title: "Restore failed", description: restoreStatus.detail, variant: "destructive" });
    }
  }, [restoring, restoreStatus?.active, restoreStatus?.ok]);

  const pickFile = (f: File | null) => {
    setFile(f);
    setValidated(null);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    pickFile(e.dataTransfer.files?.[0] ?? null);
  };

  const validate = async () => {
    if (!file) return;
    setValidating(true);
    try {
      const result = await uploadRestoreFile(file, token);
      setValidated(result);
      if (result.warnings.length) {
        toast({ title: "Backup validated with warnings", description: result.warnings.join(" ") });
      } else {
        toast({ title: "Backup validated", description: "Review the details below before restoring." });
      }
    } catch (err) {
      toast({
        title: "Validation failed",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    } finally {
      setValidating(false);
    }
  };

  const downloadScript = () => {
    if (!validated) return;
    const blob = new Blob([validated.guidedScript], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "restore_uktextiles.bat";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const startAutomatedRestore = async () => {
    if (!validated || confirmText !== "RESTORE") return;
    setConfirmOpen(false);
    setRestoring(true);
    try {
      await runAutomatedRestore(validated.stagedPath, token);
      toast({ title: "Restore started", description: "The application will be briefly unavailable." });
    } catch (err) {
      setRestoring(false);
      toast({
        title: "Failed to start restore",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    }
  };

  return (
    <Card className="border-0 shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-bold flex items-center gap-2">
          <Upload size={15} className="text-red-500" /> Restore Backup
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="p-3 rounded-lg bg-red-50 border border-red-100 text-xs text-red-700">
          Restoring replaces the entire database and all uploaded files with what's inside the backup file — anything
          created since that backup was taken will be lost from the live app (though never destroyed outright: a fresh
          safety backup of the current state is always taken automatically right before any restore runs).
        </div>

        {restoring && restoreStatus ? (
          <div className="p-4 rounded-lg bg-blue-50 border border-blue-100 text-sm text-blue-700 space-y-1">
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
            {!file ? (
              <label
                htmlFor="restore-backup-file"
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragActive(true);
                }}
                onDragLeave={() => setDragActive(false)}
                onDrop={handleDrop}
                className={`relative border-2 border-dashed transition-all rounded-xl p-7 flex flex-col items-center gap-2 text-center cursor-pointer block ${
                  dragActive ? "border-red-400 bg-red-50" : "border-gray-200 hover:border-red-300 bg-gray-50/50"
                }`}
              >
                <input
                  id="restore-backup-file"
                  type="file"
                  accept=".zip"
                  onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                />
                <Upload size={20} className="text-gray-400" />
                <p className="text-sm font-medium text-gray-600">Drop a backup .zip here, or click to browse</p>
              </label>
            ) : (
              <div className="flex items-center justify-between p-3 rounded-lg border border-gray-200 bg-gray-50">
                <div className="flex items-center gap-2 text-sm">
                  <Database size={15} className="text-gray-400" />
                  <span className="font-medium truncate">{file.name}</span>
                  <span className="text-gray-400 text-xs">{formatBackupFileSize(file.size)}</span>
                </div>
                <button onClick={() => pickFile(null)} className="text-gray-400 hover:text-red-500">
                  <X size={15} />
                </button>
              </div>
            )}

            {file && !validated && (
              <Button size="sm" onClick={validate} disabled={validating}>
                {validating ? "Validating…" : "Upload & Validate"}
              </Button>
            )}

            {validated && (
              <div className="space-y-3">
                <div className="p-3 rounded-lg bg-green-50 border border-green-100 text-xs text-green-700 space-y-1">
                  <p>
                    Backup date:{" "}
                    {validated.manifest.createdAt
                      ? new Date(validated.manifest.createdAt).toLocaleString("en-IN")
                      : "unknown"}
                  </p>
                  <p>
                    Size: {formatBackupFileSize(validated.sizeBytes)} · Files: {validated.mediaFileCount}
                  </p>
                </div>

                {validated.staleness?.isOlderThanCurrentData && (
                  <div className="p-3 rounded-lg bg-amber-50 border-2 border-amber-300 text-xs text-amber-800 space-y-1.5">
                    <p className="font-bold flex items-center gap-1.5">
                      <AlertTriangle size={13} /> This backup is older than what's currently live
                    </p>
                    <p>
                      Restoring will discard everything created since{" "}
                      {validated.staleness.backupCreatedAt
                        ? new Date(validated.staleness.backupCreatedAt).toLocaleString("en-IN")
                        : "this backup"}
                      .
                    </p>
                    <p className="tabular-nums">
                      Current: <strong>{validated.staleness.currentCounts.employees}</strong> employees,{" "}
                      <strong>{validated.staleness.currentCounts.payrollRecords}</strong> payroll records,{" "}
                      <strong>{validated.staleness.currentCounts.salarySlips}</strong> salary slips
                      {" -"}This backup: <strong>{validated.staleness.backupCounts.employees}</strong> employees,{" "}
                      <strong>{validated.staleness.backupCounts.payrollRecords}</strong> payroll records,{" "}
                      <strong>{validated.staleness.backupCounts.salarySlips}</strong> salary slips
                    </p>
                    <p>
                      A safety backup of the current state is taken automatically before restoring, so this is always
                      undoable.
                    </p>
                  </div>
                )}
                {validated.staleness === null && (
                  <div className="p-3 rounded-lg bg-gray-50 border border-gray-200 text-xs text-gray-500">
                    This is an older-format backup with no row counts recorded, so staleness can't be compared
                    automatically -review the backup date above carefully before restoring.
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="outline" onClick={downloadScript}>
                    Download Restore Script + Instructions
                  </Button>
                  {user?.isSuperAdmin && (
                    <Button size="sm" variant="destructive" onClick={() => setConfirmOpen(true)}>
                      Restore Now (Automated)
                    </Button>
                  )}
                </div>
                <p className="text-[11px] text-gray-400">
                  Guided path: run the downloaded script yourself after stopping the application server — always
                  available. Automated path: the app does everything for you and briefly goes offline while it works
                  -available to super admins only.
                </p>
              </div>
            )}
          </>
        )}

        {confirmOpen && (
          <div className="p-4 rounded-lg border-2 border-red-300 bg-red-50 space-y-3">
            <p className="text-sm font-bold text-red-700">This will replace all live data. Type RESTORE to confirm.</p>
            <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="RESTORE" />
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="destructive"
                disabled={confirmText !== "RESTORE"}
                onClick={startAutomatedRestore}
              >
                Confirm Restore
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setConfirmOpen(false);
                  setConfirmText("");
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function BackupTab() {
  const { toast } = useToast();

  // ── Database backup ─────────────────────────────────────────────────────
  const { data: backupStatus } = useBackupStatus();

  const runBackup = useRunBackup();

  const [backupDir, setBackupDir] = useState("");

  const [backupDirLoaded, setBackupDirLoaded] = useState(false);

  useEffect(() => {
    if (backupStatus && !backupDirLoaded) {
      setBackupDir(backupStatus.backupDirectory || "D:/backups/uktextile");
      setBackupDirLoaded(true);
    }
  }, [backupStatus, backupDirLoaded]);

  const handleRunBackup = async () => {
    if (!backupDir.trim()) {
      toast({ title: "Enter a backup directory first", variant: "destructive" });
      return;
    }
    try {
      const result = await runBackup.mutateAsync(backupDir.trim());
      toast({
        title: "Backup completed",
        description: `${result.file} (${(result.sizeBytes / 1024 / 1024).toFixed(2)} MB)`,
      });
    } catch (err) {
      toast({
        title: "Backup failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  };

  return (
    <>
      <Card className="border-0 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-bold flex items-center gap-2">
            <Database size={15} className="text-purple-500" /> How Backup &amp; Restore Work
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs text-gray-500">
          <p>
            <strong>Backup</strong> creates one file containing everything the application needs to come back exactly as
            it is right now -the full database (every employee, payroll, and attendance record) plus every uploaded file
            (documents, resumes, ID/geo-punch photos). It runs on the schedule you set below, or any time you click "Run
            Backup Now." Backups are saved to a folder on this server; optionally, a copy of each one is also uploaded
            to Google Drive as an offsite safety net.
          </p>
          <p>
            <strong>Restore</strong> replaces the live application with what's inside a chosen backup file. Upload the
            file below to validate it first -nothing changes yet at that point. From there you can either download a
            script to run yourself with the server stopped (safest, fully manual), or let the application do it
            automatically (super admins only, the app briefly goes offline while it works). Either way, a fresh safety
            backup of the current state is taken automatically right before anything is touched.
          </p>
        </CardContent>
      </Card>

      <Card className="border-0 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-bold flex items-center gap-2">
            <Database size={15} className="text-purple-500" /> Manual Backup
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="p-3 rounded-lg bg-blue-50 border border-blue-100 text-xs text-blue-700">
            Full backup: the live database plus every uploaded file, into the folder below on the server machine. The
            filename includes the date and time, e.g. <strong>UKTex_Full_backup_2026-07-10_14-30-00.zip</strong>.
          </div>

          {backupStatus && !backupStatus.pgDumpAvailable && (
            <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
              <strong>pg_dump was not found on the server.</strong> Install the PostgreSQL client tools on the server
              machine (or add PostgreSQL's <code>bin</code> folder to PATH), then reload this page.
            </div>
          )}

          <div className="space-y-1.5">
            <Label className="text-xs">Backup Directory (on the server machine)</Label>
            <Input
              value={backupDir}
              onChange={(e) => setBackupDir(e.target.value)}
              placeholder="D:/backups/uktextile"
            />
            <p className="text-[11px] text-gray-400">
              The folder is created automatically if it doesn't exist. The directory is remembered after the first
              successful backup.
            </p>
          </div>

          <Button size="sm" onClick={handleRunBackup} disabled={runBackup.isPending}>
            {runBackup.isPending ? "Backing up…" : "Run Backup Now"}
          </Button>

          {(backupStatus?.backups?.length ?? 0) > 0 && <RecentBackupsList backups={backupStatus!.backups} />}
        </CardContent>
      </Card>

      <BackupScheduleCard schedule={backupStatus?.schedule} />
      <DriveConfigCard />
      <RestoreBackupCard />
    </>
  );
}

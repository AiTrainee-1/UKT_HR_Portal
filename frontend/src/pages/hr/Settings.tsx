import { useEffect, useState, type ReactNode } from "react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import {
  Building2, Clock, Mail, Database, IndianRupee, FileText, Upload, X,
  Fingerprint, CreditCard, Plus, Trash2, Power, Pencil, FileSignature, Award, Eye,
} from "lucide-react";
import {
  usePayrollSettings, useUpdatePayrollSettings,
  useListBiometricDevices, useCreateBiometricDevice, useUpdateBiometricDevice, useDeleteBiometricDevice,
  useIdCardSettings, useUpdateIdCardSettings,
  useBackupStatus, useRunBackup, useUpdateBackupSchedule,
  useDriveConfig, useUpdateDriveConfig, useTestDriveConnection,
  uploadRestoreFile, runAutomatedRestore, useRestoreStatus,
  type BackupScheduleInfo, type RestoreValidateResult, type BackupFileItem,
  useDocumentSettings, useUpdateDocumentSettings, previewDocumentPdf,
  type DocumentType,
} from "@/lib/api-client/custom-hooks";
import { TimePicker12h } from "@/components/ui/time-picker-12h";
import { useAuth, permissionLevel } from "@/contexts/AuthContext";
import ProductionShiftConfigCard from "@/components/ProductionShiftConfigCard";
import { lockMutatingControls } from "@/lib/view-only-lock";

// Settings tab -> its own permission key. Each Settings tab has a distinct
// settings.* entry in Account Management (see permission_registry.py) except
// "idcard", which is deliberately governed by the existing "id_cards"
// permission — the same one that already gates the ID Cards feature page,
// not a separate Settings concern.
const SETTINGS_TAB_MODULE: Record<string, string> = {
  company: "settings.company",
  attendance: "settings.attendance",
  devices: "settings.devices",
  idcard: "id_cards",
  documents: "settings.documents",
  payroll: "settings.payroll",
  "salary-slip": "settings.salary_slip",
  smtp: "settings.smtp",
  backup: "settings.backup",
};

function DocumentThemeCard({
  docType, title, icon, description,
}: { docType: DocumentType; title: string; icon: ReactNode; description: string }) {
  const { toast } = useToast();
  const { token } = useAuth();
  const { data, isLoading } = useDocumentSettings(docType);
  const updateSettings = useUpdateDocumentSettings(docType);
  const [form, setForm] = useState({
    primaryColor: "#0E4B3A", accentColor: "#C9A227", headingStyle: "serif" as "serif" | "sans",
    showWatermark: true, footerTagline: "Weaving Quality. Building Trust.", logoOverride: "",
  });
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    if (data) {
      setForm({
        primaryColor: data.primaryColor, accentColor: data.accentColor, headingStyle: data.headingStyle,
        showWatermark: data.showWatermark, footerTagline: data.footerTagline, logoOverride: data.logoOverride,
      });
    }
  }, [data]);

  const save = async () => {
    try {
      await updateSettings.mutateAsync(form);
      toast({ title: `${title} settings saved`, description: "Applies to every newly generated document." });
    } catch {
      toast({ title: "Failed to save", variant: "destructive" });
    }
  };

  const preview = async () => {
    setPreviewing(true);
    try {
      await previewDocumentPdf(`/api/document-settings/${docType}/preview`, () => token);
    } catch {
      toast({ title: "Failed to generate preview", variant: "destructive" });
    } finally {
      setPreviewing(false);
    }
  };

  return (
    <Card className="border-0 shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-bold flex items-center gap-2">{icon} {title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-gray-500">{description}</p>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Theme Color (Primary)</Label>
              <div className="flex items-center gap-2">
                <input type="color" value={form.primaryColor} onChange={e => setForm(f => ({ ...f, primaryColor: e.target.value }))} className="h-9 w-12 rounded border cursor-pointer" />
                <Input value={form.primaryColor} onChange={e => setForm(f => ({ ...f, primaryColor: e.target.value }))} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Accent Color</Label>
              <div className="flex items-center gap-2">
                <input type="color" value={form.accentColor} onChange={e => setForm(f => ({ ...f, accentColor: e.target.value }))} className="h-9 w-12 rounded border cursor-pointer" />
                <Input value={form.accentColor} onChange={e => setForm(f => ({ ...f, accentColor: e.target.value }))} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Heading Style</Label>
              <select
                value={form.headingStyle}
                onChange={e => setForm(f => ({ ...f, headingStyle: e.target.value as "serif" | "sans" }))}
                className="w-full h-9 rounded-md border px-3 text-sm bg-background"
              >
                <option value="serif">Serif (elegant)</option>
                <option value="sans">Sans (modern)</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Footer Tagline</Label>
              <Input
                value={form.footerTagline}
                onChange={e => setForm(f => ({ ...f, footerTagline: e.target.value }))}
                placeholder="e.g. Weaving Quality. Building Trust."
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label className="text-xs">Logo Override (optional — defaults to the Company Logo above)</Label>
              <div className="flex items-start gap-4">
                {form.logoOverride ? (
                  <div className="relative">
                    <img src={form.logoOverride} alt="Logo override" className="h-16 border border-gray-200 rounded-lg bg-white p-2 object-contain" />
                    <button
                      onClick={() => setForm(f => ({ ...f, logoOverride: "" }))}
                      className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full p-0.5"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ) : (
                  <label className="flex flex-col items-center justify-center w-36 h-16 border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:border-emerald-400 hover:bg-emerald-50 transition-colors">
                    <Upload size={16} className="text-gray-400 mb-1" />
                    <span className="text-xs text-gray-400">Upload logo</span>
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={e => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        const reader = new FileReader();
                        reader.onload = ev => setForm(f => ({ ...f, logoOverride: ev.target?.result as string }));
                        reader.readAsDataURL(file);
                      }}
                    />
                  </label>
                )}
              </div>
            </div>
            <div className="space-y-1.5 flex items-end">
              <label className="flex items-center gap-2 cursor-pointer">
                <button
                  type="button"
                  onClick={() => setForm(f => ({ ...f, showWatermark: !f.showWatermark }))}
                  className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                    form.showWatermark ? "bg-emerald-700 border-emerald-700" : "bg-white border-gray-300"
                  }`}
                >
                  {form.showWatermark && <span className="w-2 h-2 bg-white rounded-sm" />}
                </button>
                <span className="text-sm text-gray-700">Show faint watermark</span>
              </label>
            </div>
          </div>
        )}
        <div className="flex items-center gap-2 pt-1">
          <Button size="sm" onClick={save} disabled={updateSettings.isPending}>
            {updateSettings.isPending ? "Saving…" : `Save ${title} Settings`}
          </Button>
          <Button size="sm" variant="outline" onClick={preview} disabled={previewing}>
            {previewing ? "Generating…" : "Preview"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

const DAY_OPTIONS: { value: string; label: string }[] = [
  { value: "mon", label: "Mon" }, { value: "tue", label: "Tue" }, { value: "wed", label: "Wed" },
  { value: "thu", label: "Thu" }, { value: "fri", label: "Fri" }, { value: "sat", label: "Sat" },
  { value: "sun", label: "Sun" },
];

function formatBackupFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

const RECENT_BACKUPS_VISIBLE = 3;

function RecentBackupsList({ backups }: { backups: BackupFileItem[] }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? backups : backups.slice(0, RECENT_BACKUPS_VISIBLE);
  const hiddenCount = backups.length - visible.length;

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-gray-600">Recent backups in this folder</p>
      <div className="border rounded-lg divide-y">
        {visible.map(b => (
          <div key={b.file} className="flex items-center justify-between px-3 py-2 text-xs">
            <span className="font-mono text-gray-700 truncate">{b.file}</span>
            <span className="text-gray-400 shrink-0 ml-3">
              {formatBackupFileSize(b.sizeBytes)} · {new Date(b.createdAt).toLocaleString("en-IN")}
            </span>
          </div>
        ))}
      </div>
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="text-xs font-semibold text-purple-600"
        >
          … {hiddenCount} more
        </button>
      )}
      {expanded && backups.length > RECENT_BACKUPS_VISIBLE && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="text-xs font-semibold text-purple-600 ml-3"
        >
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
        isEnabled, time, daysOfWeek: days.join(","), retentionCount,
      });
      toast({ title: "Backup schedule saved" });
    } catch (err) {
      toast({ title: "Failed to save schedule", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
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
            <p className="text-[11px] text-gray-400">Creates a full backup on the schedule below, with no one needing to click anything.</p>
          </div>
          <Switch checked={isEnabled} onCheckedChange={setIsEnabled} />
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <TimePicker12h label="Time of day" value={time} onChange={setTime} disabled={!isEnabled} />
          <div className="space-y-1.5">
            <Label className="text-xs">Keep the last</Label>
            <Input
              type="number" min={0} value={retentionCount} disabled={!isEnabled}
              onChange={(e) => setRetentionCount(Math.max(0, parseInt(e.target.value, 10) || 0))}
              className="w-24"
            />
            <p className="text-[11px] text-gray-400">Older local backups beyond this count are deleted automatically after each successful run. 0 = keep all.</p>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Days</Label>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button" disabled={!isEnabled} onClick={() => setDays(["*"])}
              className={`text-xs px-2.5 py-1 rounded-full border ${days.includes("*") ? "bg-purple-600 text-white border-purple-600" : "border-gray-200 text-gray-500"}`}
            >
              Every day
            </button>
            {DAY_OPTIONS.map((d) => (
              <button
                key={d.value} type="button" disabled={!isEnabled} onClick={() => toggleDay(d.value)}
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
  // actually on screen right now — the only correct signal for "is there a
  // freshly-typed/pasted key to send." Deliberately not just `replacingKey`:
  // that flag starts false and only flips once the initial GET resolves, but
  // the textarea already renders before that (whenever no key is saved yet),
  // so gating on `replacingKey` alone could silently drop a pasted key.
  const keyInputVisible = !(drive?.hasServiceAccountKey && !replacingKey);

  const save = async () => {
    try {
      await updateDrive.mutateAsync({
        isEnabled, folderId,
        ...(keyInputVisible && serviceAccountJson.trim() ? { serviceAccountJson } : {}),
      });
      toast({ title: "Google Drive settings saved" });
      setServiceAccountJson("");
      setReplacingKey(false);
    } catch (err) {
      toast({ title: "Failed to save", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    }
  };

  const test = async () => {
    try {
      const result = await testConnection.mutateAsync({
        folderId, ...(keyInputVisible && serviceAccountJson.trim() ? { serviceAccountJson } : {}),
      });
      if (result.warning) {
        toast({ title: "Connected, but check this first", description: result.warning, variant: "destructive" });
      } else {
        toast({ title: "Connection successful", description: result.folderName ? `Folder: ${result.folderName}` : undefined });
      }
    } catch (err) {
      toast({ title: "Connection failed", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
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
          Local storage is always the primary backup and the only place Restore reads from. Turning this
          on additionally uploads a copy of every backup to a Google Drive folder, in case something ever
          happens to this server itself.
        </p>

        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">Upload backups to Google Drive</p>
          <Switch checked={isEnabled} onCheckedChange={setIsEnabled} />
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label className="text-xs">Shared Drive Folder ID</Label>
            <Input
              value={folderId} onChange={(e) => setFolderId(e.target.value)}
              placeholder="1AbCDefGhIJklmNoPQRstuVWxyz"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Service Account Key (JSON)</Label>
            {!keyInputVisible ? (
              <Button size="sm" variant="outline" onClick={() => setReplacingKey(true)}>Replace key</Button>
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
              These steps set up a <strong>Service Account</strong> — a bot account that lets this application
              connect to your Google Drive securely, without needing your personal Google password.
            </p>

            <div className="space-y-1.5">
              <p className="font-semibold text-gray-700">1. Create a Google Cloud Project</p>
              <ol className="list-decimal pl-4 space-y-1">
                <li>Go to the Google Cloud Console and log in with your Google account.</li>
                <li>In the top-left navigation bar, click the project dropdown (it might say "Select a project").</li>
                <li>Click <strong>New Project</strong> in the top right of the dialog.</li>
                <li>Give it a name (e.g. "Drive-Integration") and click <strong>Create</strong>. Once it's ready, make sure it's selected in the top-left dropdown.</li>
              </ol>
            </div>

            <div className="space-y-1.5">
              <p className="font-semibold text-gray-700">2. Enable the Google Drive API</p>
              <ol className="list-decimal pl-4 space-y-1">
                <li>In your new project, use the top search bar to search for <strong>Google Drive API</strong>.</li>
                <li>Click on it in the search results.</li>
                <li>Click the blue <strong>Enable</strong> button.</li>
              </ol>
            </div>

            <div className="space-y-1.5">
              <p className="font-semibold text-gray-700">3. Create the Service Account and JSON Key</p>
              <p className="italic">Keep the downloaded JSON file secure — it acts as a password to your Drive files.</p>
              <ol className="list-decimal pl-4 space-y-1">
                <li>Open the left-side navigation menu and go to <strong>IAM &amp; Admin → Service Accounts</strong>.</li>
                <li>Click <strong>+ Create Service Account</strong> at the top of the page.</li>
                <li>Give it a name and click <strong>Create and Continue</strong>, then click <strong>Done</strong> (you can skip the optional role assignments).</li>
                <li>Find your new service account in the list, click the three-dot menu next to it, and select <strong>Manage keys</strong>.</li>
                <li>Click <strong>Add Key → Create new key</strong>.</li>
                <li>Choose <strong>JSON</strong> and click <strong>Create</strong> — the file downloads automatically.</li>
              </ol>
            </div>

            <div className="space-y-1.5">
              <p className="font-semibold text-gray-700">4. Grant the Service Account Access to Drive</p>
              <ol className="list-decimal pl-4 space-y-1">
                <li>Open the downloaded JSON file in any text editor.</li>
                <li>Find the <code>client_email</code> field and copy the email address next to it (looks like <code>your-app@your-project.iam.gserviceaccount.com</code>).</li>
                <li>Go to Google Drive and open (or create) a <strong>Shared Drive</strong> — a regular "My Drive" folder won't work, since service accounts have no storage quota outside a Shared Drive.</li>
                <li>Right-click the Shared Drive (or a folder inside it) and select <strong>Share</strong>.</li>
                <li>Paste the <code>client_email</code> address into the "Add people and groups" field.</li>
                <li>Change the role to <strong>Content Manager</strong> (or Editor).</li>
                <li>Uncheck "Notify people" (it's a bot account, it won't read the email) and click <strong>Share</strong>.</li>
              </ol>
            </div>

            <div className="space-y-1.5">
              <p className="font-semibold text-gray-700">5. Get the Folder ID</p>
              <ol className="list-decimal pl-4 space-y-1">
                <li>Open that same Shared Drive or folder so you're looking at the files inside it.</li>
                <li>Look at the URL in your browser's address bar — it looks like <code>https://drive.google.com/drive/folders/1aBcD2eFgH3iJkL4mNoP5qRsT6uVwXyZ</code>.</li>
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
      toast({ title: "Validation failed", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
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
      toast({ title: "Failed to start restore", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
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
          Restoring replaces the entire database and all uploaded files with what's inside the backup file —
          anything created since that backup was taken will be lost from the live app (though never destroyed
          outright: a fresh safety backup of the current state is always taken automatically right before any restore runs).
        </div>

        {restoring && restoreStatus ? (
          <div className="p-4 rounded-lg bg-blue-50 border border-blue-100 text-sm text-blue-700 space-y-1">
            <p className="font-semibold">{restoreStatus.active ? "Restoring… do not close this page" : restoreStatus.ok ? "Restore complete" : "Restore failed"}</p>
            <p className="text-xs">{restoreStatus.detail}</p>
          </div>
        ) : (
          <>
            {!file ? (
              <label
                htmlFor="restore-backup-file"
                onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
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
                <button onClick={() => pickFile(null)} className="text-gray-400 hover:text-red-500"><X size={15} /></button>
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
                  <p>Backup date: {validated.manifest.createdAt ? new Date(validated.manifest.createdAt).toLocaleString("en-IN") : "unknown"}</p>
                  <p>Size: {formatBackupFileSize(validated.sizeBytes)} · Files: {validated.mediaFileCount}</p>
                </div>

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
                  Guided path: run the downloaded script yourself after stopping the application server —
                  always available. Automated path: the app does everything for you and briefly goes offline
                  while it works — available to super admins only.
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
              <Button size="sm" variant="destructive" disabled={confirmText !== "RESTORE"} onClick={startAutomatedRestore}>
                Confirm Restore
              </Button>
              <Button size="sm" variant="outline" onClick={() => { setConfirmOpen(false); setConfirmText(""); }}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function Settings() {
  const { toast } = useToast();
  const { user } = useAuth();
  const [settingsTab, setSettingsTab] = useState("company");

  const tabLevel = (tab: string) => permissionLevel(user, SETTINGS_TAB_MODULE[tab] ?? "settings");
  const isTabViewOnly = tabLevel(settingsTab) === "view";

  // Land on the first tab this role can actually see if the default
  // ("company") — or whichever tab was active before a permission change —
  // is hidden for them.
  useEffect(() => {
    if (tabLevel(settingsTab) === "hidden") {
      const firstVisible = Object.keys(SETTINGS_TAB_MODULE).find((t) => tabLevel(t) !== "hidden");
      if (firstVisible) setSettingsTab(firstVisible);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, settingsTab]);

  // Radix Tabs only mounts the active TabsContent, so locking document.body
  // whenever the active tab is view-only (same mechanism HrLayout uses
  // page-wide) only ever touches that one tab's controls.
  useEffect(() => {
    if (!isTabViewOnly) return;
    const relock = () => lockMutatingControls(document.body);
    relock();
    const observer = new MutationObserver(relock);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [isTabViewOnly, settingsTab]);

  // ── Company profile — persisted to PayrollSettings via the API ─────────
  const [company, setCompany] = useState({
    name: "UKTextiles", tagline: "Garments Manufacturing Excellence",
    address: "Chennai, Tamil Nadu, India", phone: "+91 9876543210",
    email: "hr@uktextiles.in", website: "https://uktextiles.in",
    gstin: "", pan: "", registration: "",
  });

  // ── Attendance mode + production windows — loaded from DB ─────────────
  const [attMode, setAttMode] = useState({
    attendanceMode: "strict" as "strict" | "simple",
    simpleHalfShiftCutoff: "13:30",
    shiftPunctualityWindowMinutes: 60,
    lastPunchPostShiftGraceHours: 9,
    firstPunchPreShiftBufferHours: 2,
    prodFirstHalfStart: "08:30",
    prodFirstHalfEnd: "12:30",
    prodSecondHalfStart: "13:30",
    prodSecondHalfEnd: "17:30",
    prodExtraStart: "17:50",
    prodExtraEnd: "20:00",
  });
  // ── Payroll — loaded from DB ───────────────────────────────────────────
  const { data: payrollSettingsData, isLoading: psLoading } = usePayrollSettings();
  const updatePayrollSettings = useUpdatePayrollSettings();

  // Production PF/EF salary-range rules (takes precedence over flat rates when enabled)
  const [pfEfEnabled, setPfEfEnabled] = useState(false);
  const [pfEfRules, setPfEfRules] = useState<
    { label: string; minSalary: number; maxSalary: number; pfRate: number; efRate: number }[]
  >([]);

  // Master switches for the flat PF/ESI payroll rules (default OFF — no
  // deduction is applied for that employee class until explicitly enabled)
  const [staffRulesEnabled, setStaffRulesEnabled] = useState(false);
  const [prodRulesEnabled, setProdRulesEnabled] = useState(false);

  // Night Shift Relaxation feature toggle (staff-only page in the sidebar)
  const [nightShiftEnabled, setNightShiftEnabled] = useState(true);

  const [payroll, setPayroll] = useState({
    // Staff
    pfRate: 0,
    esiRate: 0,
    esiApplicableBelow: 21000,
    // Production
    prodPfRate: 0,
    prodEsiRate: 0,
    prodEsiApplicableBelow: 21000,
    // General
    payDay: 5,
    productionPayType: "biweekly",
    defaultSalaryPerShift: 0,
    // Salary slip
    slipCompanyName: "UK TEXTILES - H.O",
    slipCompanyAddress: "TIRUPUR",
    minWageRate: 0,
    signatureImage: null as string | null,
    companyLogo: null as string | null,
    authorizedSignature: null as string | null,
    // SMTP
    smtpHost: "smtp.gmail.com",
    smtpPort: 587,
    smtpUsername: "",
    smtpPassword: "",
    smtpFromEmail: "",
    smtpFromName: "UKTextiles HR",
  });

  // Sync DB values into local state once loaded
  useEffect(() => {
    if (payrollSettingsData) {
      setCompany({
        name: payrollSettingsData.companyName || "UKTextiles",
        tagline: payrollSettingsData.companyTagline || "Garments Manufacturing Excellence",
        phone: payrollSettingsData.companyPhone || "",
        email: payrollSettingsData.companyEmail || "",
        website: payrollSettingsData.companyWebsite || "",
        gstin: payrollSettingsData.companyGstin || "",
        pan: payrollSettingsData.companyPan || "",
        address: payrollSettingsData.companyAddress || "",
        registration: payrollSettingsData.companyRegistration || "",
      });
      setPayroll({
        pfRate: payrollSettingsData.pfRate,
        esiRate: payrollSettingsData.esiRate,
        esiApplicableBelow: payrollSettingsData.esiApplicableBelow,
        prodPfRate: payrollSettingsData.prodPfRate,
        prodEsiRate: payrollSettingsData.prodEsiRate,
        prodEsiApplicableBelow: payrollSettingsData.prodEsiApplicableBelow,
        payDay: payrollSettingsData.payDay,
        productionPayType: payrollSettingsData.productionPayType,
        defaultSalaryPerShift: payrollSettingsData.defaultSalaryPerShift ?? 0,
        slipCompanyName: payrollSettingsData.slipCompanyName || "UK TEXTILES - H.O",
        slipCompanyAddress: payrollSettingsData.slipCompanyAddress || "TIRUPUR",
        minWageRate: payrollSettingsData.minWageRate || 0,
        signatureImage: payrollSettingsData.signatureImage || null,
        companyLogo: payrollSettingsData.companyLogo || null,
        authorizedSignature: payrollSettingsData.authorizedSignature || null,
        smtpHost: payrollSettingsData.smtpHost || "smtp.gmail.com",
        smtpPort: payrollSettingsData.smtpPort || 587,
        smtpUsername: payrollSettingsData.smtpUsername || "",
        smtpPassword: payrollSettingsData.smtpPassword || "",
        smtpFromEmail: payrollSettingsData.smtpFromEmail || "",
        smtpFromName: payrollSettingsData.smtpFromName || "UKTextiles HR",
      });
      setAttMode({
        attendanceMode: (payrollSettingsData.attendanceMode as "strict" | "simple") || "strict",
        simpleHalfShiftCutoff: payrollSettingsData.simpleHalfShiftCutoff || "13:30",
        shiftPunctualityWindowMinutes: payrollSettingsData.shiftPunctualityWindowMinutes ?? 60,
        lastPunchPostShiftGraceHours: payrollSettingsData.lastPunchPostShiftGraceHours ?? 9,
        firstPunchPreShiftBufferHours: payrollSettingsData.firstPunchPreShiftBufferHours ?? 2,
        prodFirstHalfStart: payrollSettingsData.prodFirstHalfStart || "08:30",
        prodFirstHalfEnd: payrollSettingsData.prodFirstHalfEnd || "12:30",
        prodSecondHalfStart: payrollSettingsData.prodSecondHalfStart || "13:30",
        prodSecondHalfEnd: payrollSettingsData.prodSecondHalfEnd || "17:30",
        prodExtraStart: payrollSettingsData.prodExtraStart || "17:50",
        prodExtraEnd: payrollSettingsData.prodExtraEnd || "20:00",
      });
      setPfEfEnabled(payrollSettingsData.prodPfEfEnabled ?? false);
      setPfEfRules(payrollSettingsData.prodPfEfRules ?? []);
      setStaffRulesEnabled(payrollSettingsData.staffPayrollRulesEnabled ?? false);
      setProdRulesEnabled(payrollSettingsData.prodPayrollRulesEnabled ?? false);
      setNightShiftEnabled(payrollSettingsData.nightShiftEnabled ?? true);
    }
  }, [payrollSettingsData]);

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

  // Company/Attendance/Payroll/Salary Slip/SMTP all persist to one shared
  // PayrollSettings record via one endpoint, but each tab now sends only its
  // own fields (rather than one bundled payload covering every tab) — the
  // backend checks edit permission per settings.* field group (see
  // FIELD_GROUPS in payroll_views.py), so a role with edit on only e.g.
  // Payroll must not have its save blocked by SMTP/Salary Slip fields it
  // never touched riding along in the same request.
  const savePayrollRates = async (result?: { title: string; description?: string }, errorTitle?: string) => {
    try {
      await updatePayrollSettings.mutateAsync({
        pfRate: payroll.pfRate,
        esiRate: payroll.esiRate,
        esiApplicableBelow: payroll.esiApplicableBelow,
        prodPfRate: payroll.prodPfRate,
        prodEsiRate: payroll.prodEsiRate,
        prodEsiApplicableBelow: payroll.prodEsiApplicableBelow,
        payDay: payroll.payDay,
        productionPayType: payroll.productionPayType,
        defaultSalaryPerShift: payroll.defaultSalaryPerShift,
        prodPfEfEnabled: pfEfEnabled,
        prodPfEfRules: pfEfRules,
        staffPayrollRulesEnabled: staffRulesEnabled,
        prodPayrollRulesEnabled: prodRulesEnabled,
      } as never);
      toast(result ?? {
        title: "Payroll settings saved",
        description: "New rates will apply to all payroll generated from now.",
      });
    } catch {
      toast({ title: errorTitle ?? "Failed to save payroll settings", variant: "destructive" });
    }
  };

  const saveSmtp = async () => {
    try {
      await updatePayrollSettings.mutateAsync({
        smtpHost: payroll.smtpHost,
        smtpPort: payroll.smtpPort,
        smtpUsername: payroll.smtpUsername,
        smtpPassword: payroll.smtpPassword,
        smtpFromEmail: payroll.smtpFromEmail,
        smtpFromName: payroll.smtpFromName,
      } as never);
      toast({
        title: "SMTP settings saved",
        description: "Email sending will use these credentials from now on.",
      });
    } catch {
      toast({ title: "Failed to save SMTP settings", variant: "destructive" });
    }
  };

  const saveSalarySlip = async () => {
    try {
      await updatePayrollSettings.mutateAsync({
        slipCompanyName: payroll.slipCompanyName,
        slipCompanyAddress: payroll.slipCompanyAddress,
        minWageRate: payroll.minWageRate,
        signatureImage: payroll.signatureImage ?? undefined,
        companyLogo: payroll.companyLogo ?? undefined,
        authorizedSignature: payroll.authorizedSignature ?? undefined,
      } as never);
      toast({ title: "Salary Slip settings saved" });
    } catch {
      toast({ title: "Failed to save Salary Slip settings", variant: "destructive" });
    }
  };

  const saveCompany = async () => {
    try {
      await updatePayrollSettings.mutateAsync({
        companyName: company.name,
        companyTagline: company.tagline,
        companyPhone: company.phone,
        companyEmail: company.email,
        companyWebsite: company.website,
        companyGstin: company.gstin,
        companyPan: company.pan,
        companyAddress: company.address,
        companyRegistration: company.registration,
        // null is meaningful here — it clears a previously saved logo
        companyLogo: payroll.companyLogo,
      } as never);
      toast({
        title: "Company settings saved",
        description: "The name and logo now update everywhere in the portal, including the sidebar.",
      });
    } catch {
      toast({ title: "Failed to save company settings", variant: "destructive" });
    }
  };

  // ── Biometric devices ────────────────────────────────────────────────────
  const { data: devices, isLoading: devicesLoading } = useListBiometricDevices();
  const createDevice = useCreateBiometricDevice();
  const updateDevice = useUpdateBiometricDevice();
  const deleteDevice = useDeleteBiometricDevice();
  const [showAddDevice, setShowAddDevice] = useState(false);
  const [newDevice, setNewDevice] = useState({
    name: "", deviceType: "aiface_mars", host: "", port: "", apiKey: "", password: "", notes: "",
  });
  const [editingDeviceId, setEditingDeviceId] = useState<number | null>(null);
  const [editDevice, setEditDevice] = useState({ host: "", port: "", password: "" });

  const startEditDevice = (d: { id: number; host: string; port: number | null; connectionConfig?: Record<string, unknown> }) => {
    setEditingDeviceId(d.id);
    setEditDevice({ host: d.host ?? "", port: d.port ? String(d.port) : "", password: String((d.connectionConfig as any)?.password ?? "") });
  };

  const saveEditDevice = async (id: number) => {
    try {
      await updateDevice.mutateAsync({
        id,
        data: {
          host: editDevice.host,
          port: editDevice.port ? Number(editDevice.port) : null,
          connectionConfig: { password: editDevice.password },
        } as any,
      });
      toast({ title: "Device updated" });
      setEditingDeviceId(null);
    } catch {
      toast({ title: "Failed to update device", variant: "destructive" });
    }
  };

  const addDevice = async () => {
    if (!newDevice.name.trim()) {
      toast({ title: "Device name is required", variant: "destructive" });
      return;
    }
    try {
      await createDevice.mutateAsync({
        name: newDevice.name,
        deviceType: newDevice.deviceType,
        host: newDevice.host || undefined,
        port: newDevice.port ? Number(newDevice.port) : undefined,
        apiKey: newDevice.apiKey || undefined,
        notes: newDevice.notes || undefined,
        connectionConfig: newDevice.password ? { password: newDevice.password } : undefined,
      } as any);
      toast({ title: "Device added" });
      setNewDevice({ name: "", deviceType: "aiface_mars", host: "", port: "", apiKey: "", password: "", notes: "" });
      setShowAddDevice(false);
    } catch {
      toast({ title: "Failed to add device", variant: "destructive" });
    }
  };

  // ── ID Card template settings ───────────────────────────────────────────
  const { data: idCardSettingsData, isLoading: idCardLoading } = useIdCardSettings();
  const updateIdCardSettings = useUpdateIdCardSettings();
  const [idCardForm, setIdCardForm] = useState({
    primaryColor: "#006496", secondaryColor: "#4FB8F0", textColor: "#0f172a",
    fontFamily: "Hanken Grotesk", backgroundStyle: "gradient", logoPosition: "left",
    cornerStyle: "rounded", showQrOnBack: true, footerText: "",
  });

  useEffect(() => {
    if (idCardSettingsData) setIdCardForm(idCardSettingsData);
  }, [idCardSettingsData]);

  const saveIdCardSettings = async () => {
    try {
      await updateIdCardSettings.mutateAsync(idCardForm);
      toast({ title: "ID card template saved", description: "Applies to all newly generated ID cards." });
    } catch {
      toast({ title: "Failed to save ID card settings", variant: "destructive" });
    }
  };

  const saveAttendanceMode = async () => {
    try {
      await updatePayrollSettings.mutateAsync({
        attendanceMode: attMode.attendanceMode,
        simpleHalfShiftCutoff: attMode.simpleHalfShiftCutoff,
        shiftPunctualityWindowMinutes: attMode.shiftPunctualityWindowMinutes,
        lastPunchPostShiftGraceHours: attMode.lastPunchPostShiftGraceHours,
        firstPunchPreShiftBufferHours: attMode.firstPunchPreShiftBufferHours,
        prodFirstHalfStart: attMode.prodFirstHalfStart,
        prodFirstHalfEnd: attMode.prodFirstHalfEnd,
        prodSecondHalfStart: attMode.prodSecondHalfStart,
        prodSecondHalfEnd: attMode.prodSecondHalfEnd,
        prodExtraStart: attMode.prodExtraStart,
        prodExtraEnd: attMode.prodExtraEnd,
      } as never);
      toast({
        title: "Attendance settings saved",
        description: `Mode: ${attMode.attendanceMode === "simple" ? "Simple (morning + evening punch)" : "Strict (4-punch engine)"}. Applies to new calculations.`,
      });
    } catch {
      toast({ title: "Failed to save attendance settings", variant: "destructive" });
    }
  };

  return (
    <HrLayout>
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-black text-gray-900">Settings</h2>
          <p className="text-muted-foreground text-sm mt-0.5">Configure system, attendance, payroll, and notification settings</p>
        </div>

        <Tabs value={settingsTab} onValueChange={setSettingsTab}>
          <PillTabs
            className="flex-wrap h-auto"
            items={[
              { value: "company", label: "Company", icon: <Building2 size={13} /> },
              { value: "attendance", label: "Attendance", icon: <Clock size={13} /> },
              { value: "devices", label: "Devices", icon: <Fingerprint size={13} /> },
              { value: "idcard", label: "ID Card", icon: <CreditCard size={13} /> },
              { value: "documents", label: "Company Documents", icon: <FileSignature size={13} /> },
              { value: "payroll", label: "Payroll", icon: <IndianRupee size={13} /> },
              { value: "salary-slip", label: "Salary Slip", icon: <FileText size={13} /> },
              { value: "smtp", label: "SMTP / Email", icon: <Mail size={13} /> },
              { value: "backup", label: "Backup", icon: <Database size={13} /> },
            ].filter((t) => tabLevel(t.value) !== "hidden")}
            value={settingsTab}
            onChange={setSettingsTab}
            size="sm"
          />

          {isTabViewOnly && (
            <div
              className="flex items-center gap-2 mt-3 px-3.5 py-2.5 rounded-xl text-sm font-semibold"
              style={{
                background: "rgba(245,158,11,0.08)",
                color: "#b45309",
                boxShadow: "inset 3px 3px 8px rgba(245,158,11,0.06), inset -3px -3px 8px rgba(255,255,255,0.9)",
              }}
            >
              <Eye size={15} strokeWidth={2} />
              View only — browse and inspect freely, changes can't be saved.
            </div>
          )}

          {/* Company */}
          <TabsContent value="company" className="mt-4">
            <Card className="border-0 shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-bold flex items-center gap-2">
                  <Building2 size={15} className="text-blue-500" /> Company Profile
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="p-3 rounded-lg bg-blue-50 border border-blue-100 text-xs text-blue-700">
                  These details are used across the entire portal — the sidebar, salary slips,
                  ID cards, and PDFs all pull the name and logo from here automatically.
                </div>

                {/* Logo upload */}
                <div className="space-y-2">
                  <Label className="text-xs">Company Logo</Label>
                  <div className="flex items-start gap-4">
                    {payroll.companyLogo ? (
                      <div className="relative">
                        <img
                          src={payroll.companyLogo}
                          alt="Company Logo"
                          className="h-20 border border-gray-200 rounded-lg bg-white p-2 object-contain"
                        />
                        <button
                          onClick={() => setPayroll(p => ({ ...p, companyLogo: null }))}
                          className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full p-0.5"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ) : (
                      <label className="flex flex-col items-center justify-center w-40 h-20 border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-colors">
                        <Upload size={18} className="text-gray-400 mb-1" />
                        <span className="text-xs text-gray-400">Upload logo</span>
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={e => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            const reader = new FileReader();
                            reader.onload = ev => setPayroll(p => ({ ...p, companyLogo: ev.target?.result as string }));
                            reader.readAsDataURL(file);
                          }}
                        />
                      </label>
                    )}
                  </div>
                </div>

                <div className="grid sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Company Name</Label>
                    <Input value={company.name} onChange={e => setCompany(c => ({ ...c, name: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Tagline</Label>
                    <Input value={company.tagline} onChange={e => setCompany(c => ({ ...c, tagline: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Phone</Label>
                    <Input value={company.phone} onChange={e => setCompany(c => ({ ...c, phone: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Email</Label>
                    <Input type="email" value={company.email} onChange={e => setCompany(c => ({ ...c, email: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Website</Label>
                    <Input value={company.website} onChange={e => setCompany(c => ({ ...c, website: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">GSTIN</Label>
                    <Input value={company.gstin} onChange={e => setCompany(c => ({ ...c, gstin: e.target.value }))} placeholder="27XXXXX..." />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">PAN</Label>
                    <Input value={company.pan} onChange={e => setCompany(c => ({ ...c, pan: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Registration Details</Label>
                    <Input value={company.registration} onChange={e => setCompany(c => ({ ...c, registration: e.target.value }))} placeholder="CIN / factory license no." />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Address</Label>
                  <Input value={company.address} onChange={e => setCompany(c => ({ ...c, address: e.target.value }))} />
                </div>
                <Button size="sm" onClick={saveCompany} disabled={updatePayrollSettings.isPending}>
                  {updatePayrollSettings.isPending ? "Saving…" : "Save Company Settings"}
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Devices */}
          <TabsContent value="devices" className="mt-4">
            <Card className="border-0 shadow-sm">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-bold flex items-center gap-2">
                    <Fingerprint size={15} className="text-cyan-500" /> Biometric / Punching Devices
                  </CardTitle>
                  <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setShowAddDevice(v => !v)}>
                    <Plus size={13} /> Add Device
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-xs text-gray-500">
                  Add and enable/disable additional attendance devices — supports employees working
                  across multiple units or branches. The <strong>.env</strong>-configured device (blue badge)
                  always keeps working exactly as before; devices added here are extra. When syncing
                  attendance (Attendance page), HR picks which device to pull from, including
                  "All Devices" to merge every enabled device plus the .env device.
                </p>

                {showAddDevice && (
                  <div className="p-4 border-2 border-cyan-100 bg-cyan-50/40 rounded-xl space-y-3">
                    <div className="grid sm:grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label className="text-xs">Device Name</Label>
                        <Input value={newDevice.name} onChange={e => setNewDevice(d => ({ ...d, name: e.target.value }))} placeholder="e.g. Main Gate Scanner" />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">Device Type</Label>
                        <select
                          value={newDevice.deviceType}
                          onChange={e => setNewDevice(d => ({ ...d, deviceType: e.target.value }))}
                          className="w-full h-9 rounded-md border px-3 text-sm bg-background"
                        >
                          <option value="aiface_mars">AiFace-Mars</option>
                          <option value="zkteco">ZKTeco</option>
                          <option value="essl">eSSL</option>
                          <option value="generic_http">Generic HTTP API</option>
                          <option value="other">Other</option>
                        </select>
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">Host / IP Address</Label>
                        <Input value={newDevice.host} onChange={e => setNewDevice(d => ({ ...d, host: e.target.value }))} placeholder="192.168.1.201" />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">Port</Label>
                        <Input type="number" value={newDevice.port} onChange={e => setNewDevice(d => ({ ...d, port: e.target.value }))} placeholder="4370" />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">Comm Password (ZKTeco, optional)</Label>
                        <Input type="password" value={newDevice.password} onChange={e => setNewDevice(d => ({ ...d, password: e.target.value }))} placeholder="0" />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">API Key / Token (optional)</Label>
                        <Input type="password" value={newDevice.apiKey} onChange={e => setNewDevice(d => ({ ...d, apiKey: e.target.value }))} />
                      </div>
                      <div className="space-y-1.5 sm:col-span-2">
                        <Label className="text-xs">Notes</Label>
                        <Input value={newDevice.notes} onChange={e => setNewDevice(d => ({ ...d, notes: e.target.value }))} />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={addDevice} disabled={createDevice.isPending}>
                        {createDevice.isPending ? "Adding…" : "Save Device"}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setShowAddDevice(false)}>Cancel</Button>
                    </div>
                  </div>
                )}

                {devicesLoading ? (
                  <p className="text-sm text-muted-foreground">Loading devices…</p>
                ) : (devices ?? []).length === 0 ? (
                  <p className="text-sm text-center text-muted-foreground py-6">No devices configured yet.</p>
                ) : (
                  <div className="space-y-2">
                    {(devices ?? []).map(d => (
                      <div key={d.id} className="border rounded-xl overflow-hidden">
                        <div className="flex items-center gap-3 p-3">
                          <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${d.isActive ? "bg-cyan-50" : "bg-gray-100"}`}>
                            <Fingerprint size={16} className={d.isActive ? "text-cyan-600" : "text-gray-400"} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="text-sm font-bold text-gray-800">{d.name}</p>
                              {d.isEnv && (
                                <span className="text-[10px] font-bold text-blue-700 bg-blue-100 px-1.5 py-0.5 rounded-full">.env</span>
                              )}
                              {!d.isActive && (
                                <span className="text-[10px] font-bold text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded-full">Disabled</span>
                              )}
                            </div>
                            <p className="text-[11px] text-gray-400">
                              {d.deviceType} {d.host ? `· ${d.host}${d.port ? `:${d.port}` : ""}` : ""}
                              {d.isEnv ? " · configured in backend/.env" : ""}
                            </p>
                          </div>
                          {typeof d.id === "number" && !d.isEnv && (
                            <div className="flex items-center gap-1 shrink-0">
                              <button
                                onClick={() => editingDeviceId === d.id ? setEditingDeviceId(null) : startEditDevice(d as any)}
                                className="p-1.5 rounded-lg text-gray-400 hover:text-cyan-600 hover:bg-cyan-50"
                                title="Edit connection (host, port, password)"
                              >
                                <Pencil size={13} />
                              </button>
                              <button
                                onClick={() => updateDevice.mutate({ id: d.id as number, data: { isActive: !d.isActive } })}
                                className={`p-1.5 rounded-lg hover:bg-gray-50 ${d.isActive ? "text-green-600" : "text-gray-400"}`}
                                title={d.isActive ? "Disable device" : "Enable device"}
                              >
                                <Power size={13} />
                              </button>
                              <button
                                onClick={() => deleteDevice.mutate(d.id as number)}
                                className="p-1.5 rounded-lg text-gray-300 hover:text-red-500 hover:bg-red-50"
                                title="Remove device"
                              >
                                <Trash2 size={13} />
                              </button>
                            </div>
                          )}
                        </div>
                        {editingDeviceId === d.id && (
                          <div className="p-3 border-t bg-gray-50 grid sm:grid-cols-3 gap-3">
                            <div className="space-y-1.5">
                              <Label className="text-xs">Host / IP Address</Label>
                              <Input value={editDevice.host} onChange={e => setEditDevice(v => ({ ...v, host: e.target.value }))} placeholder="192.168.1.201" />
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-xs">Port</Label>
                              <Input type="number" value={editDevice.port} onChange={e => setEditDevice(v => ({ ...v, port: e.target.value }))} placeholder="4370" />
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-xs">Comm Password (ZKTeco)</Label>
                              <Input type="password" value={editDevice.password} onChange={e => setEditDevice(v => ({ ...v, password: e.target.value }))} placeholder="0" />
                            </div>
                            <div className="sm:col-span-3 flex gap-2">
                              <Button size="sm" onClick={() => saveEditDevice(d.id as number)} disabled={updateDevice.isPending}>
                                {updateDevice.isPending ? "Saving…" : "Save Connection"}
                              </Button>
                              <Button size="sm" variant="outline" onClick={() => setEditingDeviceId(null)}>Cancel</Button>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ID Card Settings */}
          <TabsContent value="idcard" className="mt-4">
            <Card className="border-0 shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-bold flex items-center gap-2">
                  <CreditCard size={15} className="text-sky-500" /> Employee ID Card Template
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-xs text-gray-500">
                  These settings control the look of every ID card generated from the ID Cards page.
                </p>
                {idCardLoading ? (
                  <p className="text-sm text-muted-foreground">Loading…</p>
                ) : (
                  <div className="grid sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label className="text-xs">Primary Color</Label>
                      <div className="flex items-center gap-2">
                        <input type="color" value={idCardForm.primaryColor} onChange={e => setIdCardForm(f => ({ ...f, primaryColor: e.target.value }))} className="h-9 w-12 rounded border cursor-pointer" />
                        <Input value={idCardForm.primaryColor} onChange={e => setIdCardForm(f => ({ ...f, primaryColor: e.target.value }))} />
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Secondary Color</Label>
                      <div className="flex items-center gap-2">
                        <input type="color" value={idCardForm.secondaryColor} onChange={e => setIdCardForm(f => ({ ...f, secondaryColor: e.target.value }))} className="h-9 w-12 rounded border cursor-pointer" />
                        <Input value={idCardForm.secondaryColor} onChange={e => setIdCardForm(f => ({ ...f, secondaryColor: e.target.value }))} />
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Text Color</Label>
                      <div className="flex items-center gap-2">
                        <input type="color" value={idCardForm.textColor} onChange={e => setIdCardForm(f => ({ ...f, textColor: e.target.value }))} className="h-9 w-12 rounded border cursor-pointer" />
                        <Input value={idCardForm.textColor} onChange={e => setIdCardForm(f => ({ ...f, textColor: e.target.value }))} />
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Font Family</Label>
                      <select
                        value={idCardForm.fontFamily}
                        onChange={e => setIdCardForm(f => ({ ...f, fontFamily: e.target.value }))}
                        className="w-full h-9 rounded-md border px-3 text-sm bg-background"
                      >
                        <option value="Hanken Grotesk">Hanken Grotesk</option>
                        <option value="Inter">Inter</option>
                        <option value="Poppins">Poppins</option>
                        <option value="Roboto">Roboto</option>
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Background Style</Label>
                      <select
                        value={idCardForm.backgroundStyle}
                        onChange={e => setIdCardForm(f => ({ ...f, backgroundStyle: e.target.value }))}
                        className="w-full h-9 rounded-md border px-3 text-sm bg-background"
                      >
                        <option value="gradient">Gradient</option>
                        <option value="solid">Solid</option>
                        <option value="pattern">Pattern</option>
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Logo Position</Label>
                      <select
                        value={idCardForm.logoPosition}
                        onChange={e => setIdCardForm(f => ({ ...f, logoPosition: e.target.value }))}
                        className="w-full h-9 rounded-md border px-3 text-sm bg-background"
                      >
                        <option value="left">Left</option>
                        <option value="center">Center</option>
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Corner Style</Label>
                      <select
                        value={idCardForm.cornerStyle}
                        onChange={e => setIdCardForm(f => ({ ...f, cornerStyle: e.target.value }))}
                        className="w-full h-9 rounded-md border px-3 text-sm bg-background"
                      >
                        <option value="rounded">Rounded</option>
                        <option value="sharp">Sharp</option>
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Footer Text (optional)</Label>
                      <Input value={idCardForm.footerText} onChange={e => setIdCardForm(f => ({ ...f, footerText: e.target.value }))} placeholder="e.g. Valid for the current calendar year" />
                    </div>
                    <div className="space-y-1.5 flex items-end">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <button
                          type="button"
                          onClick={() => setIdCardForm(f => ({ ...f, showQrOnBack: !f.showQrOnBack }))}
                          className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                            idCardForm.showQrOnBack ? "bg-sky-600 border-sky-600" : "bg-white border-gray-300"
                          }`}
                        >
                          {idCardForm.showQrOnBack && <span className="w-2 h-2 bg-white rounded-sm" />}
                        </button>
                        <span className="text-sm text-gray-700">Show QR verification code on back</span>
                      </label>
                    </div>
                  </div>
                )}
                <Button size="sm" onClick={saveIdCardSettings} disabled={updateIdCardSettings.isPending}>
                  {updateIdCardSettings.isPending ? "Saving…" : "Save ID Card Template"}
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Company Documents */}
          <TabsContent value="documents" className="mt-4 space-y-4">
            <p className="text-xs text-gray-500 -mt-1">
              Theme each generated document independently. Colors, heading style, and an optional logo override —
              everything else (company name, address, contact info) is pulled from the Company tab automatically.
            </p>
            <DocumentThemeCard
              docType="offer_letter"
              title="Offer Letter"
              icon={<FileSignature size={15} className="text-emerald-700" />}
              description="Generated from an employee's profile — Employees → select employee → Generate Offer Letter."
            />
            <DocumentThemeCard
              docType="experience_letter"
              title="Experience Letter"
              icon={<Award size={15} className="text-emerald-700" />}
              description="Generated from an employee's profile — Employees → select employee → Generate Experience Letter."
            />
            <DocumentThemeCard
              docType="salary_slip"
              title="Salary Slip"
              icon={<IndianRupee size={15} className="text-emerald-700" />}
              description="Applies to the Salary Slip PDF generated from the Salary Slip page."
            />
            <DocumentThemeCard
              docType="resignation_letter"
              title="Resignation Letter"
              icon={<FileText size={15} className="text-emerald-700" />}
              description="Generated from Recruitment → Resignations once a resignation is approved."
            />
          </TabsContent>

          {/* Attendance */}
          <TabsContent value="attendance" className="mt-4 space-y-4">
            {/* ── Calculation Mode ── */}
            <Card className="border-0 shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-bold flex items-center gap-2">
                  <Clock size={15} className="text-amber-500" /> Attendance Calculation Mode
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid sm:grid-cols-2 gap-3">
                  {/* Strict */}
                  <button
                    onClick={() => setAttMode(a => ({ ...a, attendanceMode: "strict" }))}
                    className={`text-left p-4 rounded-xl border-2 transition-all ${
                      attMode.attendanceMode === "strict"
                        ? "border-amber-400 bg-amber-50/60 shadow-sm"
                        : "border-gray-200 bg-white hover:border-gray-300"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <p className="font-bold text-sm text-gray-900">Strict Mode (4-Punch)</p>
                      {attMode.attendanceMode === "strict" && (
                        <span className="text-[10px] font-bold text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">ACTIVE</span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 leading-relaxed">
                      Tracks all 4 punches: morning IN, lunch OUT, lunch return, evening OUT.
                      Half shift from missing punches, and applies the 3-free-late penalty rule.
                    </p>
                  </button>
                  {/* Simple */}
                  <button
                    onClick={() => setAttMode(a => ({ ...a, attendanceMode: "simple" }))}
                    className={`text-left p-4 rounded-xl border-2 transition-all ${
                      attMode.attendanceMode === "simple"
                        ? "border-green-400 bg-green-50/60 shadow-sm"
                        : "border-gray-200 bg-white hover:border-gray-300"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <p className="font-bold text-sm text-gray-900">Simple Mode (Recommended)</p>
                      {attMode.attendanceMode === "simple" && (
                        <span className="text-[10px] font-bold text-green-700 bg-green-100 px-2 py-0.5 rounded-full">ACTIVE</span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 leading-relaxed">
                      Morning punch + evening last punch = full shift. No lunch-break tracking.
                      Late = morning punch beyond grace period. Early leave is flagged.
                    </p>
                  </button>
                </div>

                {/* Both modes now share the same Full/Half Shift decision — a first
                    AND a distinct last punch, both within the punctuality window
                    below of the employee's assigned shift start/end time. Strict
                    mode additionally tracks lunch-return lateness on top of this. */}
                <div className="grid sm:grid-cols-2 gap-4 p-3 bg-amber-50/50 border border-amber-100 rounded-lg">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Shift Punctuality Window — Maximum First Punch Allowed (minutes)</Label>
                    <p className="text-[11px] text-gray-500 -mt-1">
                      First punch must be within this many minutes of shift start (and last punch within the
                      same window of shift end) to still count as Full Shift
                    </p>
                    <Input
                      type="number"
                      min={0}
                      step={5}
                      value={attMode.shiftPunctualityWindowMinutes}
                      onChange={e => setAttMode(a => ({ ...a, shiftPunctualityWindowMinutes: Math.max(0, Number(e.target.value) || 0) }))}
                      className="max-w-[140px]"
                    />
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <p className="text-[11px] text-gray-500">
                      Applies to every employee, every day — arriving within this window still counts toward a
                      Full Shift (though it's flagged <strong>Late</strong> once past the shift's own small
                      Grace Period, set per shift in <strong>Manage Shift</strong>). Only arriving <strong>past
                      this window</strong> caps the day at Half Shift. Applies to both calculation modes, staff
                      only. Shift start/end times and grace period always come from the shift assigned to each
                      employee — an employee with no shift assigned has no reference to check against, so this
                      never applies to them.
                    </p>
                  </div>
                </div>

                {/* Cross-midnight punch reattribution — a forgotten evening exit
                    punch made hours late, after midnight, gets misread as the
                    NEXT day's first punch without this, shifting every one of
                    that day's real punches down a slot. */}
                <div className="grid sm:grid-cols-2 gap-4 p-3 bg-blue-50/50 border border-blue-100 rounded-lg">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Forgotten Last-Out Grace (hours after shift end)</Label>
                    <p className="text-[11px] text-gray-500 -mt-1">
                      A punch made this many hours after shift end — even after midnight — is treated as that
                      day's own last-out instead of tomorrow's first punch. E.g. 9 hours after a 20:00 end
                      covers a punch as late as 05:00. Set to 0 to disable.
                    </p>
                    <Input
                      type="number"
                      min={0}
                      step={0.5}
                      value={attMode.lastPunchPostShiftGraceHours}
                      onChange={e => setAttMode(a => ({ ...a, lastPunchPostShiftGraceHours: Math.max(0, Number(e.target.value) || 0) }))}
                      className="max-w-[140px]"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Next-Day Early-Arrival Protection (hours before shift start)</Label>
                    <p className="text-[11px] text-gray-500 -mt-1">
                      The grace window above can never reach closer than this many hours before the next day's
                      own shift start — protects a genuinely early arrival from being stolen and misattributed
                      to yesterday. Set to 0 to remove this cap.
                    </p>
                    <Input
                      type="number"
                      min={0}
                      step={0.5}
                      value={attMode.firstPunchPreShiftBufferHours}
                      onChange={e => setAttMode(a => ({ ...a, firstPunchPreShiftBufferHours: Math.max(0, Number(e.target.value) || 0) }))}
                      className="max-w-[140px]"
                    />
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <p className="text-[11px] text-gray-500">
                      Only reattributes a punch when the earlier day genuinely looks like it's missing its own
                      closing punch (nothing recorded at or after that day's shift end) — an already-complete
                      day never has a stray next-day punch stolen from it. Staff only.
                    </p>
                  </div>
                </div>

                {attMode.attendanceMode === "simple" && (
                  <div className="grid sm:grid-cols-2 gap-4 p-3 bg-gray-50 border border-gray-200 rounded-lg">
                    <div className="space-y-1.5">
                      <Label className="text-xs text-gray-400">Legacy Half-Shift Cutoff Time</Label>
                      <p className="text-[11px] text-gray-400 -mt-1">
                        Historical only — no longer used for new calculations since the punctuality
                        window above replaced it. Kept only for reference.
                      </p>
                      <Input
                        type="time"
                        value={attMode.simpleHalfShiftCutoff}
                        onChange={e => setAttMode(a => ({ ...a, simpleHalfShiftCutoff: e.target.value }))}
                        disabled
                      />
                    </div>
                  </div>
                )}

                <Button size="sm" onClick={saveAttendanceMode} disabled={updatePayrollSettings.isPending}>
                  {updatePayrollSettings.isPending ? "Saving…" : "Save Attendance Mode"}
                </Button>
              </CardContent>
            </Card>

            {/* ── Night Shift Relaxation (staff-only feature toggle) ── */}
            <Card className="border-0 shadow-sm">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-bold flex items-center gap-2">
                    <Clock size={15} className="text-indigo-500" /> Night Shift Relaxation (Staff)
                  </CardTitle>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-bold ${nightShiftEnabled ? "text-green-600" : "text-gray-400"}`}>
                      {nightShiftEnabled ? "ENABLED" : "DISABLED"}
                    </span>
                    <Switch
                      checked={nightShiftEnabled}
                      onCheckedChange={async (v) => {
                        setNightShiftEnabled(v);
                        try {
                          await updatePayrollSettings.mutateAsync({ nightShiftEnabled: v } as never);
                          toast({
                            title: v ? "Night Shift Relaxation enabled" : "Night Shift Relaxation disabled",
                            description: v
                              ? "The Night Shift page is now visible in the sidebar."
                              : "The Night Shift page is hidden from the sidebar. Existing relaxation logic is unchanged.",
                          });
                        } catch {
                          setNightShiftEnabled(!v);
                          toast({ title: "Failed to update setting", variant: "destructive" });
                        }
                      }}
                    />
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-gray-500 leading-relaxed">
                  Staff who work late into the night get a grace window to report late the next
                  morning without being marked Late. This switch controls whether the
                  <strong> Night Shift</strong> page appears in the sidebar — the underlying
                  detection logic and rules keep working exactly as before either way.
                </p>
              </CardContent>
            </Card>

            {/* ── Production Punch Times & Shift Segments (replaces the old fixed 3-window model) ── */}
            <ProductionShiftConfigCard />

            {/* Production PF/ESI deductions are configured in the Payroll tab
                (prodPfRate / prodEsiRate / prodEsiApplicableBelow) — the only
                rates the payroll engine actually applies. */}

          </TabsContent>

          {/* Payroll */}
          <TabsContent value="payroll" className="mt-4">
            <Card className="border-0 shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-bold flex items-center gap-2">
                  <IndianRupee size={15} className="text-green-500" /> Payroll Rules
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Info banner */}
                <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800">
                  <strong>Note:</strong> Payroll rules are <strong>disabled by default</strong>.
                  Use the switch on each column to enable PF/ESI deductions for that employee
                  class — while a switch is off, no deduction is applied even if rates are set.
                  Changes apply to all new payroll runs — existing records are not affected.
                </div>

                {psLoading ? (
                  <p className="text-sm text-muted-foreground">Loading settings…</p>
                ) : (
                  <div className="grid sm:grid-cols-2 gap-6">
                    {/* ── Staff column ── */}
                    <div className={`space-y-3 ${staffRulesEnabled ? "" : "opacity-60"}`}>
                      <div className="flex items-center gap-2 pb-1 border-b">
                        <span className="text-xs font-semibold text-blue-700 bg-blue-50 px-2 py-0.5 rounded">Staff</span>
                        <span className="text-xs text-muted-foreground">Monthly salary employees</span>
                        <div className="ml-auto flex items-center gap-2">
                          <span className={`text-[10px] font-bold ${staffRulesEnabled ? "text-green-600" : "text-gray-400"}`}>
                            {staffRulesEnabled ? "ENABLED" : "DISABLED"}
                          </span>
                          <Switch checked={staffRulesEnabled} onCheckedChange={setStaffRulesEnabled} />
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">
                          PF Rate (%) <span className="text-muted-foreground font-normal">0 = disabled</span>
                        </Label>
                        <Input
                          type="number" min={0} max={100} step={0.01}
                          value={payroll.pfRate}
                          onChange={e => setPayroll(p => ({ ...p, pfRate: Number(e.target.value) }))}
                          placeholder="e.g. 12"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">
                          ESI Rate (%) <span className="text-muted-foreground font-normal">0 = disabled</span>
                        </Label>
                        <Input
                          type="number" min={0} max={100} step={0.01}
                          value={payroll.esiRate}
                          onChange={e => setPayroll(p => ({ ...p, esiRate: Number(e.target.value) }))}
                          placeholder="e.g. 0.75"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">ESI Applicable Below (&#8377;)</Label>
                        <Input
                          type="number" min={0}
                          value={payroll.esiApplicableBelow}
                          onChange={e => setPayroll(p => ({ ...p, esiApplicableBelow: Number(e.target.value) }))}
                        />
                      </div>
                    </div>

                    {/* ── Production column ── */}
                    <div className={`space-y-3 ${prodRulesEnabled ? "" : "opacity-60"}`}>
                      <div className="flex items-center gap-2 pb-1 border-b">
                        <span className="text-xs font-semibold text-orange-700 bg-orange-50 px-2 py-0.5 rounded">Production</span>
                        <span className="text-xs text-muted-foreground">Shift-based employees</span>
                        <div className="ml-auto flex items-center gap-2">
                          <span className={`text-[10px] font-bold ${prodRulesEnabled ? "text-green-600" : "text-gray-400"}`}>
                            {prodRulesEnabled ? "ENABLED" : "DISABLED"}
                          </span>
                          <Switch checked={prodRulesEnabled} onCheckedChange={setProdRulesEnabled} />
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">
                          PF Rate (%) <span className="text-muted-foreground font-normal">0 = disabled</span>
                        </Label>
                        <Input
                          type="number" min={0} max={100} step={0.01}
                          value={payroll.prodPfRate}
                          onChange={e => setPayroll(p => ({ ...p, prodPfRate: Number(e.target.value) }))}
                          placeholder="e.g. 12"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">
                          ESI Rate (%) <span className="text-muted-foreground font-normal">0 = disabled</span>
                        </Label>
                        <Input
                          type="number" min={0} max={100} step={0.01}
                          value={payroll.prodEsiRate}
                          onChange={e => setPayroll(p => ({ ...p, prodEsiRate: Number(e.target.value) }))}
                          placeholder="e.g. 0.75"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">ESI Applicable Below (&#8377;) <span className="text-muted-foreground font-normal">based on monthly estimate</span></Label>
                        <Input
                          type="number" min={0}
                          value={payroll.prodEsiApplicableBelow}
                          onChange={e => setPayroll(p => ({ ...p, prodEsiApplicableBelow: Number(e.target.value) }))}
                        />
                      </div>
                    </div>

                    {/* ── General (full width) ── */}
                    <div className="space-y-1.5">
                      <Label className="text-xs">Salary Pay Day (of month)</Label>
                      <Input
                        type="number" min={1} max={28}
                        value={payroll.payDay}
                        onChange={e => setPayroll(p => ({ ...p, payDay: Number(e.target.value) }))}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Production Employee Pay Cycle</Label>
                      <select
                        value={payroll.productionPayType}
                        onChange={e => setPayroll(p => ({ ...p, productionPayType: e.target.value }))}
                        className="w-full h-9 rounded-md border px-3 text-sm bg-background"
                      >
                        <option value="biweekly">Bi-Weekly (every 2 weeks)</option>
                        <option value="monthly">Monthly</option>
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">
                        Default Salary Per Shift (&#8377;) <span className="text-muted-foreground font-normal">pre-filled for new production employees</span>
                      </Label>
                      <Input
                        type="number" min={0} step={0.01}
                        value={payroll.defaultSalaryPerShift}
                        onChange={e => setPayroll(p => ({ ...p, defaultSalaryPerShift: Number(e.target.value) }))}
                        placeholder="e.g. 300"
                      />
                    </div>
                  </div>
                )}

                <Button
                  size="sm"
                  onClick={() => savePayrollRates()}
                  disabled={updatePayrollSettings.isPending || psLoading}
                >
                  {updatePayrollSettings.isPending ? "Saving…" : "Save Payroll Settings"}
                </Button>
              </CardContent>
            </Card>

            {/* ── Production PF / EF salary-range rules ── */}
            <Card className="border-0 shadow-sm mt-4">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-bold flex items-center gap-2">
                    <IndianRupee size={15} className="text-purple-500" /> Production PF / EF Salary-Range Rules
                  </CardTitle>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-bold ${pfEfEnabled ? "text-green-600" : "text-gray-400"}`}>
                      {pfEfEnabled ? "ENABLED" : "DISABLED"}
                    </span>
                    <Switch checked={pfEfEnabled} onCheckedChange={setPfEfEnabled} />
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="p-3 rounded-lg bg-blue-50 border border-blue-100 text-xs text-blue-700">
                  When <strong>enabled</strong>, production payroll picks the rule matching the employee's
                  monthly-equivalent earnings (bi-weekly gross × 2) and deducts PF / EF at that rule's rates —
                  overriding the flat Production PF/ESI rates above. Amounts appear in the payroll breakdown
                  and the salary slip. Max Salary <strong>0</strong> = no upper limit. When disabled, the flat
                  rates above apply.
                </div>
                {pfEfRules.length === 0 ? (
                  <p className="text-xs text-center text-muted-foreground py-3">No rules configured yet.</p>
                ) : (
                  <div className="space-y-2">
                    <div className="grid grid-cols-[1fr_100px_100px_80px_80px_32px] gap-2 text-[10px] text-gray-400 uppercase font-semibold px-1">
                      <span>Category</span><span>Min Salary</span><span>Max Salary</span><span>PF %</span><span>EF %</span><span />
                    </div>
                    {pfEfRules.map((rule, i) => (
                      <div key={i} className="grid grid-cols-[1fr_100px_100px_80px_80px_32px] gap-2 items-center">
                        <Input
                          placeholder="Category / label"
                          value={rule.label}
                          onChange={e => setPfEfRules(rs => rs.map((r, j) => j === i ? { ...r, label: e.target.value } : r))}
                          className="h-8 text-xs"
                        />
                        <Input
                          type="number" placeholder="Min ₹"
                          value={rule.minSalary}
                          onChange={e => setPfEfRules(rs => rs.map((r, j) => j === i ? { ...r, minSalary: Number(e.target.value) } : r))}
                          className="h-8 text-xs"
                        />
                        <Input
                          type="number" placeholder="Max ₹ (0 = no limit)"
                          value={rule.maxSalary}
                          onChange={e => setPfEfRules(rs => rs.map((r, j) => j === i ? { ...r, maxSalary: Number(e.target.value) } : r))}
                          className="h-8 text-xs"
                        />
                        <Input
                          type="number" placeholder="PF %"
                          value={rule.pfRate}
                          onChange={e => setPfEfRules(rs => rs.map((r, j) => j === i ? { ...r, pfRate: Number(e.target.value) } : r))}
                          className="h-8 text-xs"
                        />
                        <Input
                          type="number" placeholder="EF %"
                          value={rule.efRate}
                          onChange={e => setPfEfRules(rs => rs.map((r, j) => j === i ? { ...r, efRate: Number(e.target.value) } : r))}
                          className="h-8 text-xs"
                        />
                        <button
                          onClick={() => setPfEfRules(rs => rs.filter((_, j) => j !== i))}
                          className="p-1.5 rounded-lg text-gray-300 hover:text-red-500 hover:bg-red-50"
                        >
                          <X size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex gap-2">
                  <Button
                    size="sm" variant="outline"
                    onClick={() => setPfEfRules(rs => [...rs, { label: "", minSalary: 0, maxSalary: 0, pfRate: 0, efRate: 0 }])}
                  >
                    + Add Rule
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => savePayrollRates({ title: "PF/EF rules saved" }, "Failed to save PF/EF rules")}
                    disabled={updatePayrollSettings.isPending}
                  >
                    {updatePayrollSettings.isPending ? "Saving…" : "Save PF/EF Rules"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* SMTP */}
          <TabsContent value="smtp" className="mt-4">
            <Card className="border-0 shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-bold flex items-center gap-2">
                  <Mail size={15} className="text-blue-500" /> SMTP / Email Configuration
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="p-3 rounded-lg bg-amber-50 border border-amber-100 text-xs text-amber-700">
                  For Gmail: use <strong>smtp.gmail.com</strong>, port <strong>587</strong>, and an <strong>App Password</strong> (not your Google account password). Enable 2FA on your Google account, then generate an App Password under Google Account → Security.
                </div>
                <div className="grid sm:grid-cols-2 gap-4">
                  {([
                    { label: "SMTP Host", key: "smtpHost", placeholder: "smtp.gmail.com" },
                    { label: "SMTP Port", key: "smtpPort", placeholder: "587", isNum: true },
                    { label: "Username (Gmail address)", key: "smtpUsername", placeholder: "hr@gmail.com" },
                    { label: "App Password", key: "smtpPassword", type: "password", placeholder: "xxxx xxxx xxxx xxxx" },
                    { label: "From Email", key: "smtpFromEmail", placeholder: "hr@uktextiles.in" },
                    { label: "From Name", key: "smtpFromName", placeholder: "UKTextiles HR" },
                  ] as { label: string; key: string; placeholder: string; type?: string; isNum?: boolean }[]).map(({ label, key, type, placeholder, isNum }) => (
                    <div key={key} className="space-y-1.5">
                      <Label className="text-xs">{label}</Label>
                      <Input
                        type={type ?? "text"}
                        value={String((payroll as any)[key] ?? "")}
                        onChange={e => setPayroll(p => ({ ...p, [key]: isNum ? Number(e.target.value) : e.target.value }))}
                        placeholder={placeholder}
                      />
                    </div>
                  ))}
                </div>
                <div className="flex gap-3">
                  <Button
                    size="sm"
                    onClick={() => saveSmtp()}
                    disabled={updatePayrollSettings.isPending || psLoading}
                  >
                    {updatePayrollSettings.isPending ? "Saving…" : "Save SMTP Settings"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Backup */}
          <TabsContent value="backup" className="mt-4 space-y-4">
            <Card className="border-0 shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-bold flex items-center gap-2">
                  <Database size={15} className="text-purple-500" /> How Backup &amp; Restore Work
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-xs text-gray-500">
                <p>
                  <strong>Backup</strong> creates one file containing everything the application needs to
                  come back exactly as it is right now — the full database (every employee, payroll, and
                  attendance record) plus every uploaded file (documents, resumes, ID/geo-punch photos). It
                  runs on the schedule you set below, or any time you click "Run Backup Now." Backups are
                  saved to a folder on this server; optionally, a copy of each one is also uploaded to
                  Google Drive as an offsite safety net.
                </p>
                <p>
                  <strong>Restore</strong> replaces the live application with what's inside a chosen backup
                  file. Upload the file below to validate it first — nothing changes yet at that point.
                  From there you can either download a script to run yourself with the server stopped
                  (safest, fully manual), or let the application do it automatically (super admins only,
                  the app briefly goes offline while it works). Either way, a fresh safety backup of the
                  current state is taken automatically right before anything is touched.
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
                  Full backup: the live database plus every uploaded file, into the folder below on the
                  server machine. The filename includes the date and time, e.g.{" "}
                  <strong>UKTex_Full_backup_2026-07-10_14-30-00.zip</strong>.
                </div>

                {backupStatus && !backupStatus.pgDumpAvailable && (
                  <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
                    <strong>pg_dump was not found on the server.</strong> Install the PostgreSQL
                    client tools on the server machine (or add PostgreSQL's <code>bin</code> folder
                    to PATH), then reload this page.
                  </div>
                )}

                <div className="space-y-1.5">
                  <Label className="text-xs">Backup Directory (on the server machine)</Label>
                  <Input
                    value={backupDir}
                    onChange={e => setBackupDir(e.target.value)}
                    placeholder="D:/backups/uktextile"
                  />
                  <p className="text-[11px] text-gray-400">
                    The folder is created automatically if it doesn't exist. The directory is
                    remembered after the first successful backup.
                  </p>
                </div>

                <Button size="sm" onClick={handleRunBackup} disabled={runBackup.isPending}>
                  {runBackup.isPending ? "Backing up…" : "Run Backup Now"}
                </Button>

                {(backupStatus?.backups?.length ?? 0) > 0 && (
                  <RecentBackupsList backups={backupStatus!.backups} />
                )}
              </CardContent>
            </Card>

            <BackupScheduleCard schedule={backupStatus?.schedule} />
            <DriveConfigCard />
            <RestoreBackupCard />
          </TabsContent>
          {/* Salary Slip */}
          <TabsContent value="salary-slip" className="mt-4">
            <Card className="border-0 shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-bold flex items-center gap-2">
                  <FileText size={15} className="text-blue-500" /> Salary Slip Settings
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="grid sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Company Name (on slip header)</Label>
                    <Input
                      value={payroll.slipCompanyName}
                      onChange={e => setPayroll(p => ({ ...p, slipCompanyName: e.target.value }))}
                      placeholder="UK TEXTILES - H.O"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Company Address / City</Label>
                    <Input
                      value={payroll.slipCompanyAddress}
                      onChange={e => setPayroll(p => ({ ...p, slipCompanyAddress: e.target.value }))}
                      placeholder="TIRUPUR"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Minimum Rate of Wages (₹)</Label>
                    <Input
                      type="number"
                      value={payroll.minWageRate}
                      onChange={e => setPayroll(p => ({ ...p, minWageRate: Number(e.target.value) }))}
                      placeholder="20000"
                    />
                  </div>
                </div>

                {/* Signature Image Upload */}
                <div className="space-y-2">
                  <Label className="text-xs">Authorised Signatory Signature Image</Label>
                  <p className="text-xs text-gray-500">This signature will appear on all salary slips in the Proprietor section.</p>
                  <div className="flex items-start gap-4">
                    {payroll.signatureImage ? (
                      <div className="relative">
                        <img
                          src={payroll.signatureImage}
                          alt="Signature"
                          className="h-20 border border-gray-200 rounded-lg bg-white p-2 object-contain"
                        />
                        <button
                          onClick={() => setPayroll(p => ({ ...p, signatureImage: null }))}
                          className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full p-0.5"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ) : (
                      <label className="flex flex-col items-center justify-center w-40 h-20 border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-colors">
                        <Upload size={18} className="text-gray-400 mb-1" />
                        <span className="text-xs text-gray-400">Upload signature</span>
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={e => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            const reader = new FileReader();
                            reader.onload = ev => {
                              setPayroll(p => ({ ...p, signatureImage: ev.target?.result as string }));
                            };
                            reader.readAsDataURL(file);
                          }}
                        />
                      </label>
                    )}
                  </div>
                </div>

                {/* Company Logo — used on Resignation Acceptance Letter PDF */}
                <div className="space-y-2 pt-2 border-t border-gray-100">
                  <Label className="text-xs">Company Logo</Label>
                  <p className="text-xs text-gray-500">Used on the Resignation Acceptance Letter PDF header.</p>
                  <div className="flex items-start gap-4">
                    {payroll.companyLogo ? (
                      <div className="relative">
                        <img
                          src={payroll.companyLogo}
                          alt="Company Logo"
                          className="h-20 border border-gray-200 rounded-lg bg-white p-2 object-contain"
                        />
                        <button
                          onClick={() => setPayroll(p => ({ ...p, companyLogo: null }))}
                          className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full p-0.5"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ) : (
                      <label className="flex flex-col items-center justify-center w-40 h-20 border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-colors">
                        <Upload size={18} className="text-gray-400 mb-1" />
                        <span className="text-xs text-gray-400">Upload logo</span>
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={e => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            const reader = new FileReader();
                            reader.onload = ev => {
                              setPayroll(p => ({ ...p, companyLogo: ev.target?.result as string }));
                            };
                            reader.readAsDataURL(file);
                          }}
                        />
                      </label>
                    )}
                  </div>
                </div>

                {/* Authorised Signature for Resignation Letter */}
                <div className="space-y-2">
                  <Label className="text-xs">Authorised Signature (for Resignation Letter)</Label>
                  <p className="text-xs text-gray-500">This signature appears on the Resignation Acceptance Letter PDF issued to employees.</p>
                  <div className="flex items-start gap-4">
                    {payroll.authorizedSignature ? (
                      <div className="relative">
                        <img
                          src={payroll.authorizedSignature}
                          alt="Authorised Signature"
                          className="h-20 border border-gray-200 rounded-lg bg-white p-2 object-contain"
                        />
                        <button
                          onClick={() => setPayroll(p => ({ ...p, authorizedSignature: null }))}
                          className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full p-0.5"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ) : (
                      <label className="flex flex-col items-center justify-center w-40 h-20 border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-colors">
                        <Upload size={18} className="text-gray-400 mb-1" />
                        <span className="text-xs text-gray-400">Upload signature</span>
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={e => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            const reader = new FileReader();
                            reader.onload = ev => {
                              setPayroll(p => ({ ...p, authorizedSignature: ev.target?.result as string }));
                            };
                            reader.readAsDataURL(file);
                          }}
                        />
                      </label>
                    )}
                  </div>
                </div>

                <Button
                  size="sm"
                  onClick={() => saveSalarySlip()}
                  disabled={updatePayrollSettings.isPending}
                >
                  {updatePayrollSettings.isPending ? "Saving…" : "Save Salary Slip Settings"}
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

        </Tabs>
      </div>
    </HrLayout>
  );
}

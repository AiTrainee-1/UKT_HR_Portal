import { useEffect, useMemo, useRef, useState } from "react";
import { Cloud, KeyRound, Loader2, PlugZap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useDriveConfig, useTestDriveConnection, useUpdateDriveConfig } from "@/lib/api-client/custom-hooks";
import { PreviewCard, PreviewLine, SettingBlock, SettingsSection } from "../kit/SettingBlock";
import { ToggleField } from "../kit/Field";
import { SaveBar } from "../kit/SaveBar";
import { serverMessage } from "../smtp/preview";
import { DriveInstructions } from "./DriveInstructions";
import { driveProblem, folderIdFromLink, readServiceAccountKey } from "./preview";

type DriveForm = { isEnabled: boolean; folderId: string };
const sameDrive = (a: DriveForm, b: DriveForm) =>
  a.isEnabled === b.isEnabled && a.folderId.trim() === b.folderId.trim();

/**
 * Google Drive: the optional offsite copy of each SCHEDULED backup (Run Backup Now never uploads). The key is
 * write-only: the server only says whether one is saved, and an empty box on save keeps it.
 */
export function DriveSection({
  driveConfigured,
  scheduleEnabled,
  readOnly,
}: {
  driveConfigured: boolean | undefined;
  scheduleEnabled: boolean;
  readOnly: boolean;
}) {
  const { toast } = useToast();
  const { data: drive } = useDriveConfig();
  const update = useUpdateDriveConfig();
  const test = useTestDriveConnection();

  const saved = useMemo<DriveForm>(
    () => ({ isEnabled: drive?.isEnabled ?? false, folderId: drive?.folderId ?? "" }),
    [drive?.isEnabled, drive?.folderId],
  );
  const [form, setForm] = useState<DriveForm>(saved);
  const lastSaved = useRef(saved);
  useEffect(() => {
    const previous = lastSaved.current;
    lastSaved.current = saved;
    setForm((current) => (sameDrive(current, previous) ? saved : current));
  }, [saved]);

  const [key, setKey] = useState("");
  const [replacingKey, setReplacingKey] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);
  const hasSavedKey = Boolean(drive?.hasServiceAccountKey);
  const keyBoxShown = !hasSavedKey || replacingKey;
  const typedKey = keyBoxShown ? key.trim() : "";
  const keyCheck = typedKey ? readServiceAccountKey(typedKey) : null;
  const linkId = folderIdFromLink(form.folderId);

  const enableProblem = driveProblem(form.isEnabled, form.folderId, hasSavedKey || typedKey !== "");
  const folderProblem = linkId ? "That is a folder link, not the ID: use the ID inside it." : null;
  const keyProblem = keyCheck && !keyCheck.ok ? keyCheck.problem : null;
  const problem = folderProblem ?? keyProblem ?? enableProblem;
  const dirty = !sameDrive(form, saved) || typedKey !== "";

  const discard = () => {
    setForm(saved);
    setKey("");
    setReplacingKey(false);
  };

  const save = async () => {
    try {
      await update.mutateAsync({
        isEnabled: form.isEnabled,
        folderId: form.folderId.trim(),
        ...(typedKey ? { serviceAccountJson: typedKey } : {}),
      });
      lastSaved.current = { isEnabled: form.isEnabled, folderId: form.folderId.trim() };
      setKey("");
      setReplacingKey(false);
      toast({
        title: "Google Drive settings saved",
        description: form.isEnabled
          ? scheduleEnabled
            ? "From the next automatic backup, each one is uploaded to this folder. Backups made with Run Backup Now are not uploaded."
            : "Uploads happen only after automatic backups, and Run automatically is off: switch it on under Scheduled Backup."
          : "Uploads to Google Drive are off.",
      });
    } catch (e) {
      toast({ title: "Failed to save", description: serverMessage(e), variant: "destructive" });
    }
  };

  const runTest = async () => {
    try {
      const result = await test.mutateAsync({
        folderId: linkId ?? form.folderId.trim(),
        ...(typedKey ? { serviceAccountJson: typedKey } : {}),
      });
      if (result.warning) {
        toast({ title: "Connected, but check this first", description: result.warning, variant: "destructive" });
      } else {
        toast({
          title: "Connection successful",
          description: result.folderName ? `Folder: ${result.folderName}` : undefined,
        });
      }
    } catch (e) {
      toast({ title: "Connection failed", description: serverMessage(e), variant: "destructive" });
    }
  };

  return (
    <SettingsSection
      icon={Cloud}
      title="Google Drive (optional offsite copy)"
      purpose="A copy of each automatic backup, uploaded to a Google Shared Drive folder, so losing this server does not lose the backups."
      testId="backup-drive-section"
      footer={
        <>
          <SaveBar
            dirty={dirty}
            saving={update.isPending}
            onSave={save}
            onDiscard={discard}
            saveLabel="Save Google Drive Settings"
            disabled={readOnly || !dirty || Boolean(problem)}
            hint={problem && dirty ? "Fix the highlighted field first." : undefined}
          />
          <Button
            size="sm"
            variant="outline"
            onClick={runTest}
            disabled={readOnly || test.isPending || Boolean(keyProblem)}
            className="gap-1.5"
          >
            {test.isPending ? <Loader2 size={13} className="animate-spin" /> : <PlugZap size={13} />}
            {test.isPending ? "Testing…" : "Test Connection"}
          </Button>
          <button
            type="button"
            onClick={() => setShowInstructions((s) => !s)}
            className="text-xs font-semibold text-blue-700"
            aria-expanded={showInstructions}
          >
            {showInstructions ? "Hide" : "Show"} Complete Instructions
          </button>
          {showInstructions && (
            <div className="w-full">
              <DriveInstructions />
            </div>
          )}
        </>
      }
    >
      <SettingBlock
        id="drive-enabled"
        labelFor="drive-enabled-switch"
        title="Upload backups to Google Drive"
        purpose="Uploads a copy of every automatic (scheduled) backup to the Shared Drive folder below. Backups made with Run Backup Now are not uploaded."
        affects={[
          {
            where: "Scheduled Backup",
            what: 'after each successful automatic backup the zip is uploaded; the outcome shows as "Last upload"',
          },
          {
            where: "Restore",
            what: "never reads from Google Drive: to restore a Drive copy, download it from Drive and upload it under Restore Backup",
          },
        ]}
        defaultText="Off"
        note="Copies on Drive are never deleted by Keep the last. Each upload holds the whole database, this Drive key and the email App Password included."
      >
        <ToggleField
          id="drive-enabled-switch"
          checked={form.isEnabled}
          onChange={(isEnabled) => setForm((f) => ({ ...f, isEnabled }))}
          onLabel="Automatic backups are copied to Google Drive"
          offLabel="Not copied to Google Drive"
          disabled={readOnly}
        >
          {form.isEnabled !== saved.isEnabled
            ? "Not saved yet."
            : driveConfigured
              ? scheduleEnabled
                ? "Active: the next automatic backup is uploaded."
                : "Saved, but nothing is uploaded while Run automatically is off."
              : form.isEnabled
                ? "Switched on, but nothing is uploaded until a folder and a key are saved."
                : "Off: nothing is uploaded."}
        </ToggleField>
        {enableProblem && (
          <p role="alert" className="text-xs font-medium text-red-600">
            {enableProblem}
          </p>
        )}
        {drive?.lastUploadAt && (
          <p className="text-[11px] text-gray-500" data-testid="drive-last-upload">
            Last upload: {new Date(drive.lastUploadAt).toLocaleString("en-IN")} -{" "}
            <span
              className={
                drive.lastUploadStatus === "success" ? "font-semibold text-green-600" : "font-semibold text-red-600"
              }
            >
              {drive.lastUploadStatus === "success" ? "Succeeded" : "Failed"}
            </span>
            {drive.lastUploadSummary ? ` (${drive.lastUploadSummary})` : ""}
          </p>
        )}
      </SettingBlock>

      <SettingBlock
        id="drive-folder-id"
        labelFor="drive-folder-input"
        title="Shared Drive Folder ID"
        purpose="Which Google Drive folder receives the uploads. It must be inside a Shared Drive: a folder in someone's own My Drive connects, but the upload then fails because a service account has no storage of its own."
        affects={[{ where: "Uploads and Test Connection", what: "put the backup into, or check, this folder" }]}
        defaultText="None"
        preview={
          linkId ? (
            <PreviewCard title="From the link" scenario="The ID inside the folder link in the box.">
              <PreviewLine
                label="Folder ID"
                result={<span className="break-all font-mono">{linkId}</span>}
                tone="info"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => setForm((f) => ({ ...f, folderId: linkId }))}
                disabled={readOnly}
              >
                Use this ID
              </Button>
            </PreviewCard>
          ) : undefined
        }
      >
        <Input
          id="drive-folder-input"
          value={form.folderId}
          onChange={(e) => setForm((f) => ({ ...f, folderId: e.target.value }))}
          placeholder="1AbCDefGhIJklmNoPQRstuVWxyz"
          spellCheck={false}
          disabled={readOnly}
          aria-invalid={Boolean(folderProblem)}
        />
        {folderProblem && (
          <p role="alert" className="text-xs font-medium text-red-600">
            {folderProblem}
          </p>
        )}
      </SettingBlock>

      <SettingBlock
        id="drive-key"
        labelFor={keyBoxShown ? "drive-key-input" : undefined}
        title="Service Account Key (JSON)"
        purpose="The Google service account key file that lets the server write to the folder without anyone's Google password. Once saved it is never shown again."
        affects={[
          { where: "Uploads and Test Connection", what: "sign in to Google with it" },
          {
            where: "The Shared Drive",
            what: "must be shared with the key's client_email address as Content Manager, or Google refuses the upload",
          },
        ]}
        note="Treat the key like a password: anyone holding it can read and change every file the service account can reach."
        preview={
          keyCheck?.ok ? (
            <PreviewCard title="From the pasted key" scenario="What the key says, read in your browser before saving.">
              <PreviewLine label="Share the Shared Drive with" result={keyCheck.clientEmail} tone="good" />
              {keyCheck.projectId && <PreviewLine label="Google Cloud project" result={keyCheck.projectId} />}
              {keyCheck.warning && <PreviewLine label="Check" result={keyCheck.warning} tone="warn" />}
            </PreviewCard>
          ) : undefined
        }
      >
        {!keyBoxShown ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
              <KeyRound size={13} /> A key is saved (hidden).
            </span>
            <Button size="sm" variant="outline" onClick={() => setReplacingKey(true)} disabled={readOnly}>
              Replace key
            </Button>
          </div>
        ) : (
          <>
            <Textarea
              id="drive-key-input"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder='{"type": "service_account", ...}'
              rows={4}
              spellCheck={false}
              className="font-mono text-xs"
              disabled={readOnly}
              aria-invalid={Boolean(keyProblem)}
            />
            {keyProblem ? (
              <p role="alert" className="text-xs font-medium text-red-600">
                {keyProblem}
              </p>
            ) : (
              <p className="text-xs text-gray-500">
                Paste the whole downloaded file.{hasSavedKey && " Leave it empty to keep the saved key."}
              </p>
            )}
            {hasSavedKey && (
              <button
                type="button"
                className="text-xs font-semibold text-blue-700"
                onClick={() => {
                  setKey("");
                  setReplacingKey(false);
                }}
              >
                Keep the saved key
              </button>
            )}
          </>
        )}
      </SettingBlock>
    </SettingsSection>
  );
}

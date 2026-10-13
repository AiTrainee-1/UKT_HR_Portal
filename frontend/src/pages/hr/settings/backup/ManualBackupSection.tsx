import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { HardDriveDownload, Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  getBackupStatusQueryKey,
  useRunBackup,
  useUpdatePayrollSettings,
  type BackupStatus,
} from "@/lib/api-client/custom-hooks";
import { PreviewCard, PreviewLine, SettingBlock, SettingsSection } from "../kit/SettingBlock";
import { SaveBar } from "../kit/SaveBar";
import { serverMessage } from "../smtp/preview";
import { backupFileName, backupPath, formatSize } from "./preview";
import { RecentBackups } from "./RecentBackups";

/**
 * Manual Backup: the folder backups are written to, "Run Backup Now", and the list of backups that can be downloaded.
 * The folder is saved by "Save Backup Folder", and also remembered (as before) when a backup made here succeeds.
 */
export function ManualBackupSection({
  status,
  readOnly,
  branchLogin,
}: {
  status: BackupStatus | undefined;
  readOnly: boolean;
  branchLogin: boolean;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const runBackup = useRunBackup();
  const saveSettings = useUpdatePayrollSettings();

  const saved = status?.backupDirectory ?? "";
  const [folder, setFolder] = useState(saved);
  // Follow the server (a backup remembers its folder) unless the box is being edited.
  const lastSaved = useRef(saved);
  useEffect(() => {
    const previous = lastSaved.current;
    lastSaved.current = saved;
    setFolder((current) => (current === previous ? saved : current));
  }, [saved]);

  const dirty = folder.trim() !== saved.trim();
  const retention = status?.schedule?.retentionCount ?? 0;
  const pgDumpMissing = status ? !status.pgDumpAvailable : false;
  // A branch login's backup with a folder that is not saved yet fails after the file is made (the server cannot
  // remember a folder for a branch that way), so it saves the folder first.
  const mustSaveFirst = branchLogin && dirty;

  const saveFolder = async () => {
    try {
      await saveSettings.mutateAsync({ backupDirectory: folder.trim() });
      lastSaved.current = folder.trim();
      setFolder(folder.trim());
      await queryClient.invalidateQueries({ queryKey: getBackupStatusQueryKey() });
      toast({
        title: "Backup folder saved",
        description: !folder.trim()
          ? "No folder saved: scheduled backups go to the backups folder inside the application's own folder."
          : branchLogin
            ? `Backups made from your branch's logins go to ${folder.trim()}; scheduled backups keep the company's folder.`
            : `Backups are written to ${folder.trim()} from now on. Backups already made stay where they are.`,
      });
    } catch (e) {
      toast({ title: "Failed to save the backup folder", description: serverMessage(e), variant: "destructive" });
    }
  };

  const run = async () => {
    if (!folder.trim()) {
      toast({
        title: "Enter a backup directory first",
        description: "A backup made from this page needs a folder on the server to write to.",
        variant: "destructive",
      });
      return;
    }
    try {
      const result = await runBackup.mutateAsync(folder.trim());
      toast({
        title: "Backup completed",
        description: `${result.file} (${formatSize(result.sizeBytes)})${
          retention ? `. Only the newest ${retention} backup files are kept in the folder.` : ""
        }`,
      });
    } catch (e) {
      toast({ title: "Backup failed", description: serverMessage(e) ?? "Unknown error", variant: "destructive" });
    }
  };

  const example = backupPath(folder, backupFileName(new Date()));

  return (
    <SettingsSection
      icon={HardDriveDownload}
      title="Manual Backup"
      purpose="A full backup taken when you click: the live database plus every uploaded file, zipped into a folder on the server machine."
      testId="backup-manual-section"
    >
      {pgDumpMissing && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700" role="alert">
          <strong>pg_dump was not found on the server.</strong> No backup can be made, by hand or on schedule, until the
          PostgreSQL client tools are installed on the server machine (or PostgreSQL's <code>bin</code> folder is added
          to PATH). Reload this page afterwards.
        </div>
      )}

      <SettingBlock
        id="backup-directory"
        labelFor="backup-directory-input"
        title="Backup Directory (on the server machine)"
        purpose="The folder on the application server (not on your computer) where backup zip files are written. It is created if it does not exist."
        affects={[
          {
            where: "Run Backup Now",
            what: "writes its zip to the folder in the box (saved or not), and remembers it once the backup succeeds",
          },
          {
            where: "Scheduled backups and the safety backup taken before a restore",
            what: "write to the saved folder; with none saved they use the backups folder inside the application's own folder on the server",
          },
          {
            where: "Recent backups",
            what: "lists the zips found in this folder, plus every copy kept in the database",
          },
          { where: "Keep the last", what: "deletes old zips from this folder only" },
        ]}
        defaultText="None saved (scheduled backups use the application's own backups folder)"
        note={
          <>
            On a cloud server whose disk is wiped at every deploy, files here do not survive a redeploy; the copy kept
            in the database keeps each backup downloadable. Changing the folder does not move old backups: zips left in
            the old folder are no longer listed or cleaned up.
            {branchLogin &&
              " You are signed in to a branch: the folder you save is your branch's own, while scheduled backups and the restore safety backup always use the company's folder."}
          </>
        }
        preview={
          <PreviewCard title="Example" scenario="A backup made now with the folder in the box.">
            <PreviewLine
              label="Saved as"
              result={
                <span className="break-all font-mono text-[11px]">{folder.trim() ? example : "(type a folder)"}</span>
              }
            />
            <PreviewLine
              label="Scheduled backups go to"
              result={saved.trim() || "the application's own backups folder"}
              tone={saved.trim() ? "neutral" : "warn"}
            />
          </PreviewCard>
        }
      >
        <Input
          id="backup-directory-input"
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
          placeholder="D:/backups/uktextile"
          spellCheck={false}
          disabled={readOnly}
        />
        <SaveBar
          dirty={dirty}
          saving={saveSettings.isPending}
          onSave={saveFolder}
          onDiscard={() => setFolder(saved)}
          saveLabel="Save Backup Folder"
          disabled={readOnly || !dirty}
          className="px-0"
        />
      </SettingBlock>

      <SettingBlock
        id="backup-run-now"
        title="Take a backup now"
        purpose="Makes a full backup immediately: the database dump plus every uploaded file, zipped into the folder above."
        affects={[
          { where: "Backup folder", what: "gets a new UKTex_Full_backup_<date>_<time>.zip" },
          {
            where: "Database",
            what: "keeps a copy of the zip, which is what Download fetches; it survives a redeploy",
          },
          {
            where: "Older backups",
            what: `zips beyond "Keep the last" (${retention || "0 = keep all"}) are deleted from the folder afterwards, even while automatic backups are off`,
          },
          { where: "Google Drive", what: "nothing: only scheduled backups are uploaded" },
          { where: "Live data", what: "nothing changes" },
        ]}
        note="On a big database this takes minutes and keeps the server busy; the page waits until the zip is finished."
      >
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={run}
            disabled={readOnly || runBackup.isPending || pgDumpMissing || mustSaveFirst}
            className="gap-1.5"
          >
            {runBackup.isPending ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
            {runBackup.isPending ? "Backing up…" : "Run Backup Now"}
          </Button>
          {mustSaveFirst && <span className="text-xs text-amber-700">Save the folder first.</span>}
        </div>
      </SettingBlock>

      <SettingBlock
        id="backup-recent"
        title="Recent backups"
        purpose="The newest backups the server still has (up to 20), from the backup folder and from the copies kept in the database. Download saves one to your computer: your copy away from the server."
        affects={[
          {
            where: "Download",
            what: "fetches the file fresh from the server each time: the database copy first, else the file in the folder",
          },
        ]}
        note="A backup file holds all company data unencrypted, including salaries, login password hashes, the email App Password and the Google Drive key. Keep downloaded files private."
      >
        <RecentBackups backups={status?.backups ?? []} />
      </SettingBlock>
    </SettingsSection>
  );
}

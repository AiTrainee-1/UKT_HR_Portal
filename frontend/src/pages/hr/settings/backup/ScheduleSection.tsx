import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CalendarClock } from "lucide-react";
import { Input } from "@/components/ui/input";
import { TimePicker12h } from "@/components/ui/time-picker-12h";
import { useToast } from "@/hooks/use-toast";
import {
  getBackupStatusQueryKey,
  useUpdateBackupSchedule,
  type BackupScheduleInfo,
  type BackupStatus,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { PreviewCard, PreviewLine, SettingBlock, SettingsSection } from "../kit/SettingBlock";
import { ToggleField } from "../kit/Field";
import { SaveBar } from "../kit/SaveBar";
import { serverMessage } from "../smtp/preview";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  WEEKDAYS,
  WEEKDAY_LABEL,
  daysValue,
  istLabel,
  nextRuns,
  retentionCutsFiles,
  retentionExample,
  retentionProblem,
  sameSchedule,
  scheduleFormFrom,
  type ScheduleForm,
  type Weekday,
} from "./preview";

function LastRun({ schedule }: { schedule: BackupScheduleInfo | undefined }) {
  if (!schedule?.lastRunAt) {
    return <p className="text-[11px] text-gray-400">No automatic backup has run yet.</p>;
  }
  const ok = schedule.lastRunStatus === "success";
  return (
    <p className="text-[11px] text-gray-500" data-testid="backup-last-run">
      Last run: {new Date(schedule.lastRunAt).toLocaleString("en-IN")} -{" "}
      <span className={ok ? "font-semibold text-green-600" : "font-semibold text-red-600"}>
        {ok ? "Succeeded" : "Failed"}
      </span>
      {schedule.lastRunSummary ? ` (${schedule.lastRunSummary})` : ""}
    </p>
  );
}

/** Scheduled Backup: on/off, time, days and how many backup files the folder keeps. One "Save Schedule" for all four. */
export function ScheduleSection({
  schedule,
  readOnly,
}: {
  schedule: BackupScheduleInfo | undefined;
  readOnly: boolean;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const update = useUpdateBackupSchedule();
  const saved = useMemo(() => scheduleFormFrom(schedule), [schedule]);
  const [form, setForm] = useState<ScheduleForm>(saved);
  const [confirming, setConfirming] = useState(false);

  const lastSaved = useRef(saved);
  useEffect(() => {
    const previous = lastSaved.current;
    lastSaved.current = saved;
    setForm((current) => (sameSchedule(current, previous) ? saved : current));
  }, [saved]);

  const dirty = !sameSchedule(form, saved);
  const retentionError = retentionProblem(form.retention);
  const keep = retentionError ? 0 : Number(form.retention.trim());
  const runs = form.isEnabled ? nextRuns(new Date(), form.time, form.days) : [];
  const example = retentionExample(keep, new Date());

  const toggleDay = (day: Weekday) =>
    setForm((f) => {
      const current = f.days ?? [];
      const next = current.includes(day) ? current.filter((d) => d !== day) : [...current, day];
      return { ...f, days: next.length === 0 || next.length === 7 ? null : next };
    });

  const save = async () => {
    setConfirming(false);
    try {
      const result = await update.mutateAsync({
        isEnabled: form.isEnabled,
        time: form.time,
        daysOfWeek: daysValue(form.days),
        retentionCount: keep,
      });
      queryClient.setQueryData<BackupStatus>(getBackupStatusQueryKey(), (old) =>
        old ? { ...old, schedule: result } : old,
      );
      lastSaved.current = form;
      toast({
        title: "Backup schedule saved",
        description: form.isEnabled
          ? runs.length
            ? `Next automatic backup: ${istLabel(runs[0])} (India time).`
            : undefined
          : "Automatic backups are off: nothing is backed up unless someone clicks Run Backup Now.",
      });
    } catch (e) {
      toast({ title: "Failed to save schedule", description: serverMessage(e), variant: "destructive" });
    }
  };

  const chip = (selected: boolean) =>
    cn(
      "rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50",
      selected ? "border-blue-600 bg-blue-600 text-white" : "border-gray-200 text-gray-600 hover:border-blue-300",
    );
  const timesOff = readOnly || !form.isEnabled;

  return (
    <SettingsSection
      icon={CalendarClock}
      title="Scheduled Backup"
      purpose="Backups taken automatically at a set time, with no one needing to click anything. They are the only backups copied to Google Drive."
      testId="backup-schedule-section"
      footer={
        <SaveBar
          dirty={dirty}
          saving={update.isPending}
          onSave={() => (retentionCutsFiles(saved, form) ? setConfirming(true) : save())}
          onDiscard={() => setForm(saved)}
          saveLabel="Save Schedule"
          disabled={readOnly || !dirty || Boolean(retentionError)}
          hint={retentionError ? "Fix the highlighted field first." : undefined}
        />
      }
    >
      <SettingBlock
        id="backup-schedule-enabled"
        labelFor="backup-schedule-switch"
        title="Run automatically"
        purpose="Turns the automatic backup on or off."
        affects={[
          {
            where: "Automatic backup",
            what: 'runs at the time and on the days below, keeps the newest backups ("Keep the last") and uploads to Google Drive when that is on',
          },
          {
            where: "Last run",
            what: "the outcome of the latest automatic backup shows below; there is no other alert when one fails",
          },
        ]}
        defaultText="Off"
        note="The schedule runs inside the application server. A time that passes while the server is off or restarting is skipped, not made up later."
      >
        <ToggleField
          id="backup-schedule-switch"
          checked={form.isEnabled}
          onChange={(isEnabled) => setForm((f) => ({ ...f, isEnabled }))}
          onLabel="Backups run automatically"
          offLabel="Automatic backups are off"
          disabled={readOnly}
        >
          {form.isEnabled
            ? "A full backup is made on the schedule below."
            : "Nothing is backed up unless someone clicks Run Backup Now."}
        </ToggleField>
        <LastRun schedule={schedule} />
      </SettingBlock>

      <SettingBlock
        id="backup-schedule-time"
        title="Time of day"
        purpose="The time, in India time, the automatic backup starts. Pick a quiet hour: dumping the database and zipping every file keeps the server busy."
        affects={[{ where: "Automatic backup", what: "starts at this time on the chosen days" }]}
        defaultText="02:00 AM"
        note="Backup file names use the server's own clock, which on a cloud server may be UTC rather than India time."
      >
        <TimePicker12h value={form.time} onChange={(time) => setForm((f) => ({ ...f, time }))} disabled={timesOff} />
      </SettingBlock>

      <SettingBlock
        id="backup-schedule-days"
        title="Days"
        purpose="Which weekdays the automatic backup runs."
        affects={[{ where: "Automatic backup", what: "runs only on the days picked; Every day runs it daily" }]}
        defaultText="Every day"
        preview={
          <PreviewCard
            title="Next automatic backups"
            scenario="From now, with the time and days on screen (India time)."
          >
            {!form.isEnabled ? (
              <PreviewLine label="Run automatically is off" result="no automatic backups" tone="warn" />
            ) : (
              runs.map((at, i) => (
                <PreviewLine key={at.toISOString()} label={i === 0 ? "Next" : "Then"} result={istLabel(at)} />
              ))
            )}
          </PreviewCard>
        }
      >
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Days">
          <button
            type="button"
            disabled={timesOff}
            aria-pressed={form.days === null}
            onClick={() => setForm((f) => ({ ...f, days: null }))}
            className={chip(form.days === null)}
          >
            Every day
          </button>
          {WEEKDAYS.map((d) => {
            const on = form.days?.includes(d) ?? false;
            return (
              <button
                key={d}
                type="button"
                disabled={timesOff}
                aria-pressed={on}
                onClick={() => toggleDay(d)}
                className={chip(on)}
              >
                {WEEKDAY_LABEL[d]}
              </button>
            );
          })}
        </div>
      </SettingBlock>

      <SettingBlock
        id="backup-retention"
        labelFor="backup-retention-input"
        title="Keep the last"
        purpose="How many of the newest backup files the backup folder keeps. After every successful backup, made by hand or automatically, older zips in the folder are deleted. 0 keeps them all."
        affects={[
          {
            where: "Backup folder",
            what: "older UKTex_Full_backup zips beyond this number are deleted for good, safety backups taken before a restore included",
          },
          {
            where: "Copies in the database and on Google Drive",
            what: "never deleted by this; they keep growing, and with them the size of every later backup",
          },
        ]}
        defaultText="14"
        note="It also applies to Run Backup Now, even while Run automatically is off. A small number leaves no fallback if the newest backup turns out to be bad. Saving a smaller number asks first."
        preview={
          <PreviewCard
            title="Example"
            scenario="The folder holds one backup from each of the last five days, and today's backup has just been made."
          >
            <PreviewLine label="Kept" result={example.kept.join(", ")} tone="good" />
            <PreviewLine
              label="Deleted from the folder"
              result={example.deleted.length ? example.deleted.join(", ") : "nothing"}
              tone={example.deleted.length ? "bad" : "neutral"}
            />
          </PreviewCard>
        }
      >
        <div className="flex items-center gap-2">
          <Input
            id="backup-retention-input"
            inputMode="numeric"
            value={form.retention}
            onChange={(e) => setForm((f) => ({ ...f, retention: e.target.value }))}
            className="w-24"
            disabled={readOnly}
            aria-invalid={Boolean(retentionError)}
          />
          <span className="text-xs font-semibold text-gray-500">backup files</span>
        </div>
        {retentionError && (
          <p role="alert" className="text-xs font-medium text-red-600">
            {retentionError}
          </p>
        )}
      </SettingBlock>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Keep only the newest ${keep} backup files?`}
        confirmLabel={`Keep ${keep} and save`}
        onConfirm={save}
        busy={update.isPending}
      >
        After the next backup, made by hand or automatically, every older backup zip in the backup folder beyond the
        newest {keep} is deleted for good. The copies kept in the database and on Google Drive are not touched.
      </ConfirmDialog>
    </SettingsSection>
  );
}

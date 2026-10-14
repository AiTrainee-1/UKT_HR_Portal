import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { ApiError } from "@/lib/api-client/custom-fetch";
import { useCompensationSettings, useUpdateCompensationSettings } from "@/lib/api-client/custom-hooks";
import { SaveBar } from "./kit/SaveBar";
import { SaveDock } from "./kit/SaveDock";
import { TabContents } from "./attendance/TabContents";
import { useDraft } from "./attendance/useDraft";
import { saveErrorText } from "./payroll/form";
import {
  dateAfterSwitch,
  draftFrom,
  sameDraft,
  todayIst,
  toInput,
  validateDraft,
  type CompensationDraft,
} from "./compensation/form";
import { BirthdaySection, HolidayWorkSection, WindowsSection } from "./compensation/LeaveSections";
import { MasterStrip } from "./compensation/MasterStrip";
import { Type1Section } from "./compensation/Type1Section";
import { Type2Section } from "./compensation/Type2Section";

const CONTENTS = [
  { id: "compensation-type1", label: "Type 1: next-day allowance" },
  { id: "compensation-type2", label: "Type 2: shifts" },
  { id: "compensation-leave-a", label: "A. Announced late-in / early-out" },
  { id: "compensation-leave-b", label: "B. Sundays and holidays" },
  { id: "compensation-leave-c", label: "C. Birthday" },
];

/** What went wrong with a save, in words an HR manager can act on. */
function failureText(err: unknown): string {
  const fromServer = saveErrorText(err);
  if (fromServer) return fromServer;
  if (err instanceof ApiError && err.status === 403)
    return "Your login is not allowed to change the Compensation settings.";
  return "The settings could not be saved. Check the connection and try again.";
}

/** "14 Oct 2026, 10:00 am" in the factory's own time. */
function stamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });
}

/**
 * Settings -> Compensation (staff only): every compensation feature, its rules and its own switch in one place, just like
 * the Late-In and Early-Out switches. Everything is one form with one Save: the five features (OT Detection Type 1 and
 * Type 2, and Compensation Leave A, B and C), their dates, and the editable rule tables. The master switch is only shown
 * here; it has one home on the Payroll tab.
 */
export default function CompensationTab({ readOnly = false }: { readOnly?: boolean }) {
  const { toast } = useToast();
  const query = useCompensationSettings();
  const update = useUpdateCompensationSettings();
  const data = query.data;

  const saved = useMemo(() => (data ? draftFrom(data) : null), [data]);
  const { draft, setDraft, update: patchDraft, dirty, discard } = useDraft(saved, sameDraft);
  const validation = useMemo(
    () =>
      draft
        ? validateDraft(draft, { allowanceFrom: saved?.allowanceFrom ?? "", birthdayFrom: saved?.birthdayFrom ?? "" })
        : null,
    [draft, saved],
  );
  const today = useMemo(() => todayIst(), []);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // the server's warnings about the settings it has just saved (they stay until the next save)
  const [serverWarnings, setServerWarnings] = useState<string[]>([]);

  if (query.isLoading) {
    return (
      <div className="space-y-3" data-testid="settings-loading">
        <Skeleton className="h-20 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  if (query.isError || !data || !draft || !validation) {
    return (
      <div
        className="flex flex-wrap items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"
        data-testid="compensation-load-error"
      >
        The Compensation settings could not be loaded.
        <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  // Switching a dated feature on again starts it today (as the server does), and the form shows that date at once.
  const patch = (change: Partial<CompensationDraft>) => {
    const next = { ...change };
    if (saved && change.allowanceEnabled !== undefined && change.allowanceFrom === undefined) {
      next.allowanceFrom = dateAfterSwitch({
        on: change.allowanceEnabled,
        savedOn: saved.allowanceEnabled,
        savedFrom: saved.allowanceFrom,
        currentFrom: draft.allowanceFrom,
        today,
      });
    }
    if (saved && change.birthdayEnabled !== undefined && change.birthdayFrom === undefined) {
      next.birthdayFrom = dateAfterSwitch({
        on: change.birthdayEnabled,
        savedOn: saved.birthdayEnabled,
        savedFrom: saved.birthdayFrom,
        currentFrom: draft.birthdayFrom,
        today,
      });
    }
    patchDraft(next);
  };
  const sectionProps = { draft, patch, readOnly, masterOn: data.masterEnabled === true, validation, today };

  const save = async () => {
    if (readOnly || !validation.ok || !dirty) return;
    setSaving(true);
    setSaveError(null);
    try {
      const { settings, warnings } = await update.mutateAsync(toInput(draft));
      setDraft(draftFrom(settings));
      setServerWarnings(warnings);
      toast({
        title: "Compensation settings saved",
        description:
          warnings.length > 0
            ? `Saved, with ${warnings.length === 1 ? "a warning" : `${warnings.length} warnings`}: ${warnings.join(" ")}`
            : "The rules are used from now on, from the dates shown for each feature. Payslips already generated are never changed.",
      });
    } catch (err) {
      const message = failureText(err);
      setSaveError(message);
      toast({ title: "Failed to save the Compensation settings", description: message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const hint = readOnly
    ? "View only: you can try values to see the examples, but they cannot be saved."
    : validation.first
      ? `Fix this first: ${validation.first}`
      : undefined;

  return (
    <div className="space-y-4" data-testid="compensation-tab">
      <MasterStrip masterOn={data.masterEnabled === true} />
      <TabContents items={CONTENTS} />
      {data.updatedAt && (
        <p className="text-xs text-gray-500" data-testid="compensation-updated">
          Last saved {data.updatedBy ? `by ${data.updatedBy} ` : ""}on {stamp(data.updatedAt)}.
        </p>
      )}

      {serverWarnings.length > 0 && (
        <div
          className="space-y-1 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-900"
          data-testid="compensation-warnings"
        >
          <p className="font-semibold">Saved. The server points out:</p>
          <ul className="list-disc space-y-0.5 pl-5">
            {serverWarnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <Type1Section {...sectionProps} />
      <Type2Section {...sectionProps} />
      <WindowsSection {...sectionProps} />
      <HolidayWorkSection {...sectionProps} />
      <BirthdaySection {...sectionProps} />

      <SaveDock>
        {saveError && (
          <div
            role="alert"
            className="mb-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
            data-testid="compensation-save-error"
          >
            {saveError}
          </div>
        )}
        <SaveBar
          dirty={dirty}
          saving={saving}
          onSave={() => void save()}
          onDiscard={() => {
            setSaveError(null);
            discard();
          }}
          saveLabel="Save Compensation Settings"
          disabled={readOnly || !dirty || !validation.ok}
          hint={hint}
        />
      </SaveDock>
    </div>
  );
}

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { ApiError } from "@/lib/api-client/custom-fetch";
import {
  usePayrollSettings,
  useProductionShiftRules,
  useUpdateProductionShiftRules,
} from "@/lib/api-client/custom-hooks";
import { ConfirmSave } from "./attendance/ConfirmSave";
import { TabContents } from "./attendance/TabContents";
import { useDraft } from "./attendance/useDraft";
import { SaveBar } from "./kit/SaveBar";
import { SaveDock } from "./kit/SaveDock";
import { isIsoDate, prettyDate, todayIst } from "./compensation/form";
import { saveErrorText } from "./payroll/form";
import { BranchNotice } from "./payroll/ui";
import { AdvancedSection } from "./production-shifts/AdvancedSection";
import { BreaksSection } from "./production-shifts/BreaksSection";
import {
  draftChanges,
  draftFrom,
  legacyText,
  sameDraft,
  toInput,
  validateDraft,
  warningsFor,
} from "./production-shifts/form";
import { GroupsSection } from "./production-shifts/GroupsSection";
import { TryItSection } from "./production-shifts/TryItSection";
import { RulesStrip } from "./production-shifts/ui";
import { WhenSection } from "./production-shifts/WhenSection";

const CONTENTS = [
  { id: "production-shifts-when", label: "When it applies" },
  { id: "production-shifts-groups", label: "Shift groups" },
  { id: "production-shifts-breaks", label: "Breaks" },
  { id: "production-shifts-advanced", label: "Advanced" },
  { id: "production-shifts-try", label: "Try a day" },
];

const BRANCH_TEXT =
  "The production shift rules are company-wide: you can read them here and try a day, but only an administrator (a login with no branch) can change them.";

/** True when the server refused a save because the login belongs to a branch. */
function isBranchRefusal(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 403) return false;
  const data = err.data as { code?: unknown; error?: unknown } | null;
  return data?.code === "company_wide_settings" || data?.error === "company_wide_settings";
}

/** What went wrong with a save, in words an HR manager can act on. */
function failureText(err: unknown): string {
  if (isBranchRefusal(err)) return BRANCH_TEXT;
  const fromServer = saveErrorText(err);
  if (fromServer) return fromServer;
  if (err instanceof ApiError && err.status === 403) {
    return "Your login is not allowed to change the production shift rules.";
  }
  return "The production shift rules could not be saved. Check the connection and try again.";
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
 * Settings -> Production Shifts (production employees only): how a production day's punches become shifts earned. The
 * default timings are the factory's own (Day from 8:30, Night from 9:00 PM, Sunday, the breaks, a 5-minute grace) and all of
 * it is editable. One form with one Save: the switch and the date the rules start, the grace, the shift groups with their
 * ladders, the breaks and four advanced numbers. A save is all-or-nothing and asks first, because it changes how every
 * production day from the start date is judged (and so what production payroll pays once it is generated again).
 */
export default function ProductionShiftsTab({ readOnly = false }: { readOnly?: boolean }) {
  const { toast } = useToast();
  const query = useProductionShiftRules();
  const update = useUpdateProductionShiftRules();
  const payroll = usePayrollSettings();
  const data = query.data;

  const saved = useMemo(() => (data ? draftFrom(data) : null), [data]);
  const { draft, setDraft, update: patchDraft, dirty, discard } = useDraft(saved, sameDraft);
  const validation = useMemo(() => (draft ? validateDraft(draft) : null), [draft]);
  const advice = useMemo(() => (draft ? warningsFor(draft) : []), [draft]);
  const today = useMemo(() => todayIst(), []);

  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // the server's warnings about the rules it has just saved (until the next save); before a save, the ones it sent with them
  const [savedWarnings, setSavedWarnings] = useState<string[] | null>(null);
  // a save the server refused as a branch login's: the tab is read-only from then on, whatever it first thought
  const [refusedAsBranch, setRefusedAsBranch] = useState(false);
  const branchLogin = payroll.data?.companyWideRulesEditable === false || refusedAsBranch;
  const locked = readOnly || branchLogin;

  if (query.isLoading) {
    return (
      <div className="space-y-3" data-testid="production-shifts-loading">
        <Skeleton className="h-20 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  if (query.isError || !data || !draft || !validation || !saved) {
    return (
      <div
        className="flex flex-wrap items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"
        data-testid="production-shifts-load-error"
      >
        The production shift rules could not be loaded.
        <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const sectionProps = { draft, patch: patchDraft, readOnly: locked, validation, today };
  const canSave = !locked && dirty && validation.ok;
  const changes = draftChanges(draft, saved);
  const warnings = savedWarnings ?? data.warnings ?? [];
  const from = startWords(draft.effectiveFrom);

  const save = async () => {
    setConfirming(false);
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      const { rules, warnings: after } = await update.mutateAsync(toInput(draft));
      setDraft(draftFrom(rules));
      setSavedWarnings(after);
      toast({
        title: "Production shift rules saved",
        description:
          after.length > 0
            ? `Saved, with ${after.length === 1 ? "a warning" : `${after.length} warnings`}: ${after.join(" ")}`
            : "Days from the start date are worked out with these rules, the next time they are opened. Payslips already generated are never changed.",
      });
    } catch (err) {
      const message = failureText(err);
      if (isBranchRefusal(err)) setRefusedAsBranch(true);
      setSaveError(message);
      toast({ title: "Failed to save the production shift rules", description: message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const hint = readOnly
    ? "View only: you can try a day, but the rules cannot be changed."
    : branchLogin
      ? "Signed in for a branch: only an administrator can save these company-wide rules."
      : validation.first
        ? `Fix this first: ${validation.first}`
        : undefined;

  return (
    <div className="space-y-4" data-testid="production-shifts-tab">
      {branchLogin && <BranchNotice>{BRANCH_TEXT}</BranchNotice>}
      <RulesStrip enabled={data.enabled !== false} from={data.effectiveFrom} today={today} />
      <TabContents items={CONTENTS} />
      {data.updatedAt && (
        <p className="text-xs text-gray-500" data-testid="production-shifts-updated">
          Last saved {data.updatedBy ? `by ${data.updatedBy} ` : ""}on {stamp(data.updatedAt)}.
        </p>
      )}

      {warnings.length > 0 && (
        <div
          className="space-y-1 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-900"
          data-testid="production-shifts-warnings"
        >
          <p className="font-semibold">The server points out:</p>
          <ul className="list-disc space-y-0.5 pl-5">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      {advice.length > 0 && (
        <div
          className="space-y-1 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-900"
          data-testid="production-shifts-advice"
        >
          <p className="font-semibold">Worth a look (this does not stop a save):</p>
          <ul className="list-disc space-y-0.5 pl-5">
            {advice.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <WhenSection {...sectionProps} legacy={legacyText(data.legacy)} />
      <GroupsSection {...sectionProps} />
      <BreaksSection {...sectionProps} />
      <AdvancedSection {...sectionProps} />
      <TryItSection dirty={dirty} today={today} />

      <SaveDock>
        {saveError && (
          <div
            role="alert"
            className="mb-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
            data-testid="production-shifts-save-error"
          >
            {saveError}
          </div>
        )}
        <SaveBar
          dirty={dirty}
          saving={saving}
          onSave={() => setConfirming(true)}
          onDiscard={() => {
            setSaveError(null);
            discard();
          }}
          saveLabel="Save Production Shift Rules"
          disabled={!canSave}
          hint={hint}
        />
      </SaveDock>

      <ConfirmSave
        open={confirming}
        onOpenChange={setConfirming}
        title="Save these production shift rules?"
        changes={changes}
        testId="confirm-production-shifts"
        onConfirm={() => void save()}
        consequences={[
          draft.effectiveFrom && draft.effectiveFrom < today
            ? `${from} is in the past: every production day from then until today is judged again with these rules the next time it is opened, and the production payroll of those days changes when it is generated again. Payslips already generated are never rewritten.`
            : `Days from ${from} on are worked out with these rules. Every earlier day keeps the old calculation, so nothing already paid changes.`,
          "Only production employees are affected. Staff attendance and payroll are never touched.",
          ...(draft.enabled ? [] : ["The rules are switched off: every production day uses the old calculation."]),
        ]}
      />
    </div>
  );
}

/** The start date in words for a sentence ("14 Oct 2026"), or "the start date" while it is blank or not a date. */
function startWords(iso: string): string {
  return isIsoDate(iso) ? prettyDate(iso) : "the start date";
}

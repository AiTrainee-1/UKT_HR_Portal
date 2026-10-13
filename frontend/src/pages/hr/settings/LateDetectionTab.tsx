import { useMemo, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { DEFAULT_ARRIVAL } from "@/lib/arrival-rules";
import { usePayrollSettings, useUpdatePayrollSettings } from "@/lib/api-client/custom-hooks";
import { ConfirmSave } from "./attendance/ConfirmSave";
import { SaveFooter } from "./attendance/SaveFooter";
import { TabContents } from "./attendance/TabContents";
import { useDraft } from "./attendance/useDraft";
import {
  capChanges,
  capDraftFrom,
  capDraftProblem,
  capPayload,
  lateChanges,
  lateDraftFrom,
  latePayload,
  lateProblem,
  sameCap,
  sameLate,
} from "./late_detection/form";
import { PermissionSection } from "./late_detection/PermissionSection";
import { PolicySection } from "./late_detection/PolicySection";
import { PoolIntro } from "./late_detection/PoolIntro";

const CONTENTS = [
  { id: "late-pool-intro", label: "How the pool works" },
  { id: "late-policy-section", label: "Free allowance and slabs" },
  { id: "permission-policy-section", label: "Permission cap" },
];

/**
 * Settings -> Late Detection (staff only): what the month's Late / Early Out / excess-permission marks cost, and how
 * many approved permissions a month protect a day. Two independent forms, each with its own Save (and a confirm first:
 * both change pay for everyone).
 */
export default function LateDetectionTab({ readOnly = false }: { readOnly?: boolean }) {
  const { toast } = useToast();
  const { data } = usePayrollSettings();
  const update = useUpdatePayrollSettings();

  const savedLate = useMemo(() => (data ? lateDraftFrom(data) : null), [data]);
  const savedCap = useMemo(() => (data ? capDraftFrom(data) : null), [data]);
  const late = useDraft(savedLate, sameLate);
  const capForm = useDraft(savedCap, sameCap);
  const loaded = !!data && !!late.draft && !!capForm.draft;
  const lateDraft = late.draft ?? lateDraftFrom({});
  const capDraft = capForm.draft ?? capDraftFrom({});

  // A branch-assigned login sees the company-wide cap but the server refuses (403) a save that carries it; an older
  // backend that does not report the cap cannot have it changed here. The allowance and slabs are not company-wide.
  const companyWideEditable = data?.companyWideRulesEditable !== false;
  const capReported = data?.permissionMonthlyCap != null;
  const morningOn = data?.morningLateInEnabled;
  const eveningOn = data?.eveningEarlyOutEnabled;
  const savedArrival = {
    lateWindowMinutes: data?.arrivalLateWindowMinutes ?? DEFAULT_ARRIVAL.lateWindowMinutes,
    permissionWindowMinutes: data?.arrivalPermissionWindowMinutes ?? DEFAULT_ARRIVAL.permissionWindowMinutes,
    extraMinutes: data?.arrivalExtraMinutes ?? DEFAULT_ARRIVAL.extraMinutes,
    quarterDeduction: data?.arrivalQuarterDeduction ?? DEFAULT_ARRIVAL.quarterDeduction,
  };

  const lateError = lateProblem(lateDraft);
  const capError = companyWideEditable && capReported ? capDraftProblem(capDraft) : null;
  const capShown = capError ? (data?.permissionMonthlyCap ?? 3) : Number(capDraft.cap);

  const [confirming, setConfirming] = useState<"late" | "cap" | null>(null);
  const [saving, setSaving] = useState<"late" | "cap" | null>(null);

  const saveLate = async () => {
    setConfirming(null);
    if (!late.draft || lateError) return;
    setSaving("late");
    try {
      await update.mutateAsync(latePayload(late.draft) as never);
      toast({
        title: "Late Detection policy saved",
        description: companyWideEditable
          ? "Payroll generated from now on uses it. Payslips already generated keep their amounts until that month's payroll is generated again; the Report Log and the employee apps already show the new deduction."
          : "Saved for your branch only: payroll keeps using the company-wide values.",
      });
    } catch (err) {
      toast({
        title: "Failed to save Late Detection policy",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    } finally {
      setSaving(null);
    }
  };

  const saveCap = async () => {
    setConfirming(null);
    if (!capForm.draft || capError || !companyWideEditable || !capReported) return;
    setSaving("cap");
    try {
      await update.mutateAsync(capPayload(capForm.draft) as never);
      toast({
        title: "Permission policy saved",
        description:
          "Days are re-judged with the new cap the next time they are opened, past months included. Payslips already generated keep their amounts until that month's payroll is generated again.",
      });
    } catch (err) {
      toast({
        title: "Failed to save Permission policy",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    } finally {
      setSaving(null);
    }
  };

  const hint = (problem: string | null) =>
    readOnly
      ? "View only: you can try values to see the examples, but they cannot be saved."
      : !loaded
        ? "Loading the saved settings…"
        : problem
          ? `Fix this first: ${problem}`
          : undefined;

  return (
    <div className="space-y-4">
      <TabContents items={CONTENTS} />
      <PoolIntro morningOn={morningOn} eveningOn={eveningOn} />

      <div className="space-y-4">
        <PolicySection
          draft={lateDraft}
          update={late.update}
          loaded={loaded}
          branchLogin={!companyWideEditable}
          morningOn={morningOn}
          eveningOn={eveningOn}
          cap={capShown}
        />
        <SaveFooter
          dirty={late.dirty}
          saving={saving === "late"}
          onSave={() => setConfirming("late")}
          onDiscard={late.discard}
          saveLabel="Save Late Detection Policy"
          disabled={readOnly || !loaded || !late.dirty || !!lateError}
          hint={hint(lateError)}
        />
      </div>

      <div className="space-y-4">
        <PermissionSection
          draft={capDraft}
          update={capForm.update}
          loaded={loaded}
          companyWideEditable={companyWideEditable}
          capReported={capReported}
          arrival={savedArrival}
          secondHalfStart={data?.halfDaySecondHalfStartTime ?? null}
          morningOn={morningOn}
        />
        <SaveFooter
          dirty={capForm.dirty}
          saving={saving === "cap"}
          onSave={() => setConfirming("cap")}
          onDiscard={capForm.discard}
          saveLabel="Save Permission Policy"
          disabled={readOnly || !loaded || !capForm.dirty || !!capError || !companyWideEditable || !capReported}
          hint={
            !readOnly && loaded && !companyWideEditable
              ? "The monthly cap is a company-wide rule: only an administrator can change it."
              : hint(capError)
          }
        />
      </div>

      <ConfirmSave
        open={confirming === "late"}
        onOpenChange={(open) => setConfirming(open ? "late" : null)}
        title="Save the Late Detection policy?"
        changes={savedLate ? lateChanges(lateDraft, savedLate) : []}
        onConfirm={() => void saveLate()}
        consequences={[
          "Every payroll generated from now on deducts with these values, for every staff member.",
          "Payslips already generated keep their amounts until that month's payroll is generated again; the Report Log, the shift statistics and the employee apps show the new deduction for past months straight away.",
          ...(companyWideEditable
            ? []
            : [
                "You are signed in for a branch: this is saved for your branch only, and payroll keeps the company-wide values.",
              ]),
        ]}
      />
      <ConfirmSave
        open={confirming === "cap"}
        onOpenChange={(open) => setConfirming(open ? "cap" : null)}
        title="Save the Permission policy?"
        changes={savedCap ? capChanges(capDraft, savedCap) : []}
        onConfirm={() => void saveCap()}
        consequences={[
          "Days are re-judged with the new cap the next time they are opened, past months included: a lower cap turns earlier approvals into Excess and excused days into Late days, a higher cap does the reverse.",
          "Requests are never blocked by the cap; it only decides which approvals protect a day.",
          "Payslips already generated keep their amounts until that month's payroll is generated again.",
        ]}
      />
    </div>
  );
}

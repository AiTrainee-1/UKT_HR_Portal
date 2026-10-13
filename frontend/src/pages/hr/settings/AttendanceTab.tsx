import { useMemo, useState } from "react";
import { Building } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { minutesOf } from "@/lib/arrival-rules";
import { usePayrollSettings, useUpdatePayrollSettings } from "@/lib/api-client/custom-hooks";
import { ConfirmSave } from "./attendance/ConfirmSave";
import { DaySection } from "./attendance/DaySection";
import { EXAMPLE_GRACE, EXAMPLE_START, exampleShift } from "./attendance/example";
import {
  arrivalOf,
  carriedKeysFrom,
  firstError,
  num,
  sameStaff,
  staffAccess,
  staffChanges,
  staffDraftFrom,
  staffPayload,
  validateStaff,
} from "./attendance/form";
import { HowItWorks, type Sample } from "./attendance/HowItWorks";
import { LateMarksSection } from "./attendance/LateMarksSection";
import { LunchSection } from "./attendance/LunchSection";
import { MidnightSection } from "./attendance/MidnightSection";
import { ModeSection } from "./attendance/ModeSection";
import { ProductionSection } from "./attendance/ProductionSection";
import { SaveFooter } from "./attendance/SaveFooter";
import { TabContents } from "./attendance/TabContents";
import { useDraft } from "./attendance/useDraft";

const CONTENTS = [
  { id: "attendance-how-it-works", label: "How it works" },
  { id: "attendance-mode-section", label: "Mode" },
  { id: "attendance-day", label: "Full / Half / Absent" },
  { id: "attendance-late-marks", label: "Late and Early Out" },
  { id: "attendance-lunch", label: "Lunch return" },
  { id: "attendance-midnight", label: "After midnight" },
  { id: "attendance-production", label: "Production" },
];

/**
 * Settings -> Attendance: how a staff day's punches become Full Day / Half Day / Absent and which arrivals and departures
 * are marked. Everything for staff is one form saved by "Save Attendance Settings" (after a confirm: the rules re-judge
 * past days); production attendance is only explained here, it is edited with the production shift in Manage Shift.
 */
export default function AttendanceTab({ readOnly = false }: { readOnly?: boolean }) {
  const { toast } = useToast();
  const { data } = usePayrollSettings();
  const update = useUpdatePayrollSettings();

  const saved = useMemo(() => (data ? staffDraftFrom(data) : null), [data]);
  const carried = useMemo(() => (data ? carriedKeysFrom(data) : null), [data]);
  const access = staffAccess(data);
  const { draft: maybeDraft, update: patch, dirty, discard } = useDraft(saved, sameStaff);
  const loaded = !!saved && !!maybeDraft;
  const draft = maybeDraft ?? staffDraftFrom({});

  const [sample, setSample] = useState<Sample>({ start: EXAMPLE_START, grace: EXAMPLE_GRACE });
  const shift = exampleShift(sample.start, sample.grace);
  const arrival = arrivalOf(draft);
  const errors = validateStaff(draft, access);
  const problem = firstError(errors);
  const changes = saved ? staffChanges(draft, saved) : [];

  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setConfirming(false);
    if (!saved || !carried || !maybeDraft || problem) return;
    setSaving(true);
    try {
      await update.mutateAsync(staffPayload(maybeDraft, saved, carried, access) as never);
      toast({
        title: "Attendance settings saved",
        description: access.companyWideEditable
          ? "Attendance pages and reports work days out with these rules from now on, past months included, the next time they open them. Payslips already generated keep their amounts until that month's payroll is generated again."
          : "Saved for your branch only. Payroll, reports and WhatsApp alerts keep using the company-wide values, and the company-wide rules were not changed.",
      });
    } catch (err) {
      toast({
        title: "Failed to save attendance settings",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const hint = readOnly
    ? "View only: you can try values to see the examples, but they cannot be saved."
    : !loaded
      ? "Loading the saved settings…"
      : problem
        ? `Fix this first: ${problem}`
        : undefined;

  return (
    <div className="space-y-4">
      <TabContents items={CONTENTS} />

      {data && !access.companyWideEditable && (
        <div
          className="flex items-start gap-2 rounded-xl bg-amber-50 px-3.5 py-2.5 text-[13px] text-amber-900"
          data-testid="attendance-branch-note"
        >
          <Building size={15} className="mt-0.5 shrink-0" />
          <p>
            You are signed in for a branch. The company-wide rules (Second Half Start, the arrival timeline and the Late
            / Early Out switches) are shown but only an administrator can change them. Anything else you save here is
            stored for your branch only: payroll, reports and WhatsApp alerts keep using the company-wide values.
          </p>
        </div>
      )}

      <div className="space-y-4">
        <HowItWorks
          sample={sample}
          onSample={setSample}
          shift={shift}
          arrival={arrival}
          arrivalValid={!errors.arrival}
          nightLateWindow={num(draft.nightLateWindow)}
          lunchZone={num(draft.lunchPermissionZone)}
          freeAllowance={data?.lateFreeAllowance ?? null}
          permissionCap={data?.permissionMonthlyCap ?? null}
        />
        <ModeSection
          draft={draft}
          patch={patch}
          loaded={loaded}
          shift={shift}
          nightLateWindow={num(draft.nightLateWindow)}
          lunchZone={num(draft.lunchPermissionZone)}
        />
        <DaySection
          draft={draft}
          patch={patch}
          errors={errors}
          access={access}
          loaded={loaded}
          shift={shift}
          arrival={arrival}
          fixedFirstHalfEnd={data?.halfDayFirstHalfEndTime ?? null}
        />
        <LateMarksSection
          draft={draft}
          patch={patch}
          access={access}
          loaded={loaded}
          shift={shift}
          arrival={arrival}
          arrivalValid={!errors.arrival}
          secondHalfStart={minutesOf(draft.secondHalfStart)}
        />
        <LunchSection draft={draft} patch={patch} errors={errors} loaded={loaded} shift={shift} />
        <MidnightSection draft={draft} patch={patch} errors={errors} loaded={loaded} shift={shift} />

        <SaveFooter
          dirty={dirty}
          saving={saving}
          onSave={() => setConfirming(true)}
          onDiscard={discard}
          saveLabel="Save Attendance Settings"
          disabled={readOnly || !loaded || !dirty || !!problem}
          hint={hint}
        />
      </div>

      <ProductionSection />

      <ConfirmSave
        open={confirming}
        onOpenChange={setConfirming}
        title="Save these attendance rules?"
        changes={changes}
        onConfirm={() => void save()}
        consequences={[
          "Past days are re-judged: Staff Attendance, the Report Log, reports and the employee apps work every day out again with these rules the next time they open it, past months included. Days HR corrected by hand are not changed.",
          "Payslips already generated keep their amounts until payroll is generated again for that month; until then a re-judged month can disagree with its payslip.",
          ...(changes.some((c) => c.money)
            ? ["Changes marked 'pay' change what people earn in every payroll generated from now on."]
            : []),
          ...(access.companyWideEditable
            ? []
            : [
                "You are signed in for a branch: this is saved for your branch only, and payroll keeps the company-wide values.",
              ]),
        ]}
      />
    </div>
  );
}

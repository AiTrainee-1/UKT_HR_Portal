import { KeyRound } from "lucide-react";
import { clock, minutesOf, type ArrivalSettings } from "@/lib/arrival-rules";
import { PreviewCard, PreviewLine, SettingBlock, SettingsSection } from "../kit/SettingBlock";
import { DEFAULT_EXAMPLE, describeShift } from "../attendance/example";
import { PERMISSION_MINUTES, judgeStaffDay } from "../attendance/preview";
import { UnitInput } from "../attendance/UnitInput";
import { LATE_SECTIONS, lateText } from "../LateDetectionTab.meta";
import type { CapDraft } from "./form";
import { capProblem, withinCap } from "./preview";

const DAYS = ["2nd", "9th", "15th", "22nd"];

const block = (id: string) => ({ id, ...lateText(id) });

/** The monthly permission cap: how many approved permissions a month actually protect a day. */
export function PermissionSection({
  draft,
  update,
  loaded,
  companyWideEditable,
  capReported,
  arrival,
  secondHalfStart,
  morningOn,
  permissionsPriced,
}: {
  draft: CapDraft;
  update: (patch: Partial<CapDraft>) => void;
  loaded: boolean;
  companyWideEditable: boolean;
  capReported: boolean;
  /** The saved arrival timeline (Attendance tab), for the example day. */
  arrival: ArrivalSettings;
  secondHalfStart: string | null;
  morningOn: boolean | undefined;
  /** "Price permissions separately" is on (as typed): the permissions beyond the cap are not marks of the late pool. */
  permissionsPriced: boolean;
}) {
  const error = companyWideEditable && capReported ? capProblem(draft.cap) : null;
  const cap = Number(draft.cap);
  const shift = DEFAULT_EXAMPLE;
  const arriveAt = shift.start + shift.grace + 30;
  const second = minutesOf(secondHalfStart) ?? minutesOf("14:30")!;
  const day = (permission: boolean) =>
    judgeStaffDay({
      punches: [arriveAt, shift.end + 5],
      shift,
      arrival,
      secondHalfStart: second,
      morningLateIn: morningOn !== false,
      eveningEarlyOut: false,
      morningPermission: permission,
    });
  const covered = day(true);
  const plain = day(false);
  const ranks = error ? [] : withinCap(DAYS.length, cap);
  const excess = ranks.filter((r) => !r).length;

  return (
    <SettingsSection
      id="permission-policy-section"
      icon={KeyRound}
      title={LATE_SECTIONS.permission}
      purpose={`Staff only. There are three kinds of permission, each a fixed ${PERMISSION_MINUTES} minutes: Morning Late-In, Evening Early-Out and Middle One-Hour. Employees can ask for as many as they like and HR can approve any of them; this cap decides how many of the approved ones protect a day.`}
      usedBy={[
        { label: "Staff Attendance", to: "/hr/attendance/staff" },
        { label: "Leave and Permissions", to: "/hr/leave" },
        { label: "Employee apps" },
      ]}
      testId="permission-policy-section"
    >
      <SettingBlock
        {...block("permission-cap")}
        labelFor="permission-monthly-cap"
        affects={[
          {
            where: "Staff Attendance",
            what: `an in-cap Morning Late-In moves that day's start ${PERMISSION_MINUTES} minutes later (an arrival is excused up to the end of the Permission window); an in-cap Evening Early-Out moves the end ${PERMISSION_MINUTES} minutes earlier`,
            to: "/hr/attendance/staff",
          },
          {
            where: "Leave and Permissions, HOD approvals",
            what: "each approved permission is shown as 'Allowed' (within the cap) or 'Overdue / Excess'",
            to: "/hr/leave",
          },
          { where: "WhatsApp late alert", what: "only an in-cap Morning Late-In permission holds it back" },
          {
            where: "Late pool and Staff Payroll",
            what: "every approved permission beyond the cap is one mark, or is priced on its own when permission pricing (below) is on",
            to: "/hr/payroll",
          },
          { where: "Employee apps", what: "show the monthly limit to the employee" },
        ]}
        defaultText="3 a month"
        note={
          <>
            Company-wide. Every approved permission counts toward the cap, whatever its kind: a Middle One-Hour
            permission never moves the shift start or end, but it uses one of the month's protected places and, beyond
            the cap, it adds a mark like any other. Lowering the cap re-judges the month: earlier approvals can become
            Excess and excused days become Late. Who approves permissions is set in User Management.
          </>
        }
        preview={
          <PreviewCard
            title="Example"
            scenario={`Four approved Morning Late-In permissions this month, on the 2nd, 9th, 15th and 22nd, and each day the first punch is ${clock(arriveAt)}: ${describeShift(shift)}.`}
          >
            {error ? (
              <p className="text-[12px] text-gray-500">Enter a valid cap to see the example.</p>
            ) : (
              <>
                {DAYS.map((d, i) =>
                  ranks[i] ? (
                    <PreviewLine
                      key={d}
                      label={`${d}: within the cap`}
                      result={`excused (up to ${covered.limits ? clock(covered.limits.permissionUntil) : "-"}): Full Day, no mark`}
                      tone="good"
                    />
                  ) : (
                    <PreviewLine
                      key={d}
                      label={`${d}: beyond the cap (Excess), judged against ${clock(shift.start)} + ${shift.grace} min`}
                      result={
                        plain.late
                          ? "Late: 1 mark (the permission and the Late day count once)"
                          : plain.zone === "quarter"
                            ? `quarter shift (${plain.shifts.toFixed(2)}) and 1 mark for the permission`
                            : "1 mark for the permission"
                      }
                      tone="bad"
                    />
                  ),
                )}
                {permissionsPriced ? (
                  <PreviewLine
                    label="These four permissions are priced separately (not in the late pool)"
                    result={`${excess} extra permission${excess === 1 ? "" : "s"}`}
                    tone={excess > 0 ? "warn" : "good"}
                  />
                ) : (
                  <PreviewLine
                    label="These four permissions add to the month's late pool"
                    result={`${excess} mark${excess === 1 ? "" : "s"}`}
                    tone={excess > 0 ? "warn" : "good"}
                  />
                )}
              </>
            )}
          </PreviewCard>
        }
      >
        <UnitInput
          id="permission-monthly-cap"
          value={draft.cap}
          onChange={(v) => update({ cap: v })}
          unit="a month"
          step={1}
          min={0}
          max={31}
          disabled={!loaded || !companyWideEditable || !capReported}
          error={error ?? undefined}
        />
        {!companyWideEditable && (
          <p data-testid="company-wide-note-cap" className="text-[11px] font-medium text-slate-500">
            Company-wide rule - set by an administrator
          </p>
        )}
        {companyWideEditable && loaded && !capReported && (
          <p data-testid="cap-not-reported" className="text-[11px] font-medium text-slate-500">
            Not reported by the server, so it cannot be changed here
          </p>
        )}
      </SettingBlock>
    </SettingsSection>
  );
}

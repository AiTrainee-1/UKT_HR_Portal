import { useMemo, useState } from "react";
import { CalendarCheck, CalendarClock, CalendarPlus, History, Lock, RefreshCw, UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { ApiError } from "@/lib/api-client/custom-fetch";
import {
  useCasualLeavePolicy,
  useUpdateCasualLeavePolicy,
  type CasualLeavePolicyErrors,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { Field, ToggleField } from "./kit/Field";
import { PreviewCard, PreviewLine, SettingBlock, SettingsSection, type Affect } from "./kit/SettingBlock";
import { CASUAL_LEAVE_SETTINGS } from "./CasualLeaveTab.meta";
import { errorText } from "./identity/errors";
import { metaOf } from "./identity/meta";
import { SaveFooter } from "./identity/SaveFooter";
import { useDraft } from "./identity/useDraft";
import {
  LIMITS,
  allocationText,
  dayText,
  daysWord,
  eligibleFrom,
  exampleYear,
  fmt,
  formFromPolicy,
  halfDays,
  monthLong,
  serviceText,
  summary,
  toInput,
  validate,
  type ClPolicyField,
  type ClPolicyForm,
  type ClPolicyProblems,
} from "./casual-leave/policy";

const meta = (id: string) => metaOf(CASUAL_LEAVE_SETTINGS, id);

const PAGE = "/hr/casual-leave";
const AFFECTS_BALANCE: Affect[] = [
  { where: "Casual Leave page", what: "each staff member's balance, and who is eligible or not and why", to: PAGE },
  { where: "Employee apps", what: "the balance and what may be asked for on Apply Casual Leave" },
  { where: "Attendance Edit", what: "a Casual Leave HR proposes is checked against the same balance" },
  { where: "Carry Forward", what: "absent or leave days HR turns into Casual Leave come out of the same balance" },
];

/** Two or three choices as cards (the look of Settings -> Attendance's mode). */
function Choice<T extends string>({
  label,
  value,
  options,
  onPick,
  disabled,
  testId,
}: {
  label: string;
  value: T;
  options: { value: T; title: string; text: string; locked?: string }[];
  onPick: (next: T) => void;
  disabled?: boolean;
  testId: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="grid gap-2 sm:grid-cols-2" data-testid={testId}>
      {options.map((o) => {
        const active = value === o.value;
        const blocked = Boolean(o.locked) && !active;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled || blocked}
            onClick={() => onPick(o.value)}
            data-testid={`${testId}-${o.value}`}
            className={cn(
              "rounded-2xl border-2 p-3 text-left transition-all disabled:cursor-not-allowed disabled:opacity-60",
              active ? "settings-clay !border-blue-400" : "settings-glass !border-transparent hover:!border-blue-200",
            )}
          >
            <span className="flex items-center justify-between gap-2">
              <span className="text-sm font-bold text-gray-900">{o.title}</span>
              {active && (
                <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-bold text-blue-700">
                  Selected
                </span>
              )}
            </span>
            <span className="mt-1 block text-xs leading-relaxed text-gray-500">{blocked ? o.locked : o.text}</span>
          </button>
        );
      })}
    </div>
  );
}

function FieldError({ id, text }: { id: string; text?: string }) {
  if (!text) return null;
  return (
    <p id={id} role="alert" className="text-xs font-medium text-red-600">
      {text}
    </p>
  );
}

const EXAMPLE_WANTS: Record<number, number> = { 6: 3, 10: 1 };

/** The year drawn month by month from the values on screen: what each month adds, what is taken, what is left. */
function YearRibbon({ form }: { form: ClPolicyForm }) {
  const [start, setStart] = useState(1);
  const year = useMemo(() => exampleYear(form, start, EXAMPLE_WANTS), [form, start]);
  const carries = form.allocation === "yearly" || form.carryForward;
  return (
    <div className="space-y-3" data-testid="cl-year-example">
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-slate-600">
        <span>Service complete from</span>
        <select
          value={start}
          onChange={(e) => setStart(Number(e.target.value))}
          className="h-8 rounded-md border border-slate-200 bg-white px-2 text-[13px] text-slate-800"
          aria-label="Month the example employee's service is complete"
          data-testid="cl-year-example-start"
        >
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
            <option key={m} value={m}>
              {monthLong(m)}
            </option>
          ))}
        </select>
        <span className="basis-full text-slate-500">
          The example employee asks for 3 days in June and 1 day in October.
        </span>
      </div>
      <ol
        className="grid grid-cols-3 gap-1.5 sm:grid-cols-6 xl:grid-cols-12"
        aria-label="The example year, month by month"
      >
        {year.months.map((m) => (
          <li
            key={m.month}
            className={cn(
              "flex min-w-0 flex-col rounded-lg border px-2 py-1.5 text-[11px] leading-tight",
              !m.counts
                ? "border-dashed border-slate-200 bg-transparent text-slate-400"
                : m.refused > 0
                  ? "border-red-200 bg-red-50/70"
                  : m.taken > 0
                    ? "border-blue-200 bg-blue-50/70"
                    : "border-slate-200 bg-white/70",
            )}
            data-testid={`cl-month-${m.month}`}
          >
            <span className="font-semibold text-slate-700">{m.label}</span>
            {!m.counts ? (
              <span className="mt-auto pt-3">not yet</span>
            ) : (
              <>
                <span className={cn("tabular-nums", m.given ? "text-emerald-700" : "text-slate-400")}>
                  {m.given ? `+${fmt(m.given)}` : "+0"}
                </span>
                {m.wanted > 0 && (
                  <span className="tabular-nums text-blue-800">
                    takes {fmt(m.taken)}
                    {m.refused > 0 && <span className="block text-red-700">{fmt(m.refused)} refused</span>}
                  </span>
                )}
                <span className="mt-auto pt-1 font-bold tabular-nums text-slate-900">left {fmt(m.left)}</span>
                {m.lapsed > 0 && <span className="text-amber-700">ends with the month</span>}
              </>
            )}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-slate-600" data-testid="cl-year-example-totals">
        <span>
          Given in the year: <b className="tabular-nums text-slate-900">{daysWord(year.given)}</b>
        </span>
        <span>
          Taken: <b className="tabular-nums text-slate-900">{daysWord(year.taken)}</b>
        </span>
        <span>
          31 December:{" "}
          <b className="tabular-nums text-slate-900">
            {!carries
              ? "nothing left over (each month's days end with the month)"
              : year.movesToNextYear > 0
                ? `${daysWord(year.leftAtYearEnd)} left, ${daysWord(year.movesToNextYear)} move into the next year${
                    year.lapsesAtYearEnd > 0 ? `, ${daysWord(year.lapsesAtYearEnd)} lapse` : ""
                  }`
                : `${daysWord(year.leftAtYearEnd)} left, ${year.leftAtYearEnd > 0 ? "they lapse" : "nothing to lapse"}`}
          </b>
        </span>
      </div>
    </div>
  );
}

export default function CasualLeaveTab({ readOnly = false }: { readOnly?: boolean }) {
  const { toast } = useToast();
  const policy = useCasualLeavePolicy();
  const update = useUpdateCasualLeavePolicy();
  const data = policy.data;

  const saved = useMemo(() => formFromPolicy(data), [data]);
  const { form, set, discard, dirty } = useDraft(saved);
  const [serverProblems, setServerProblems] = useState<ClPolicyProblems>({});

  const editable = data?.canEdit !== false;
  const disabled = readOnly || !editable || !data;
  const problems = useMemo(() => ({ ...serverProblems, ...validate(form) }), [form, serverProblems]);
  const hasProblems = Object.keys(problems).length > 0;
  const monthly = form.allocation === "monthly";

  const change = <K extends ClPolicyField>(key: K, value: ClPolicyForm[K]) => {
    set(key, value);
    if (serverProblems[key])
      setServerProblems((p) => {
        const next = { ...p };
        delete next[key];
        return next;
      });
  };

  const save = async () => {
    if (hasProblems) {
      toast({
        title: "Check the Casual Leave policy",
        description: Object.values(problems)[0],
        variant: "destructive",
      });
      return;
    }
    try {
      await update.mutateAsync(toInput(form));
      discard();
      setServerProblems({});
      toast({
        title: "Casual Leave policy saved",
        description:
          "Every balance follows it from now on, on this portal and in the employee apps. Approved Casual Leave stays as it is.",
      });
    } catch (e) {
      const body = e instanceof ApiError ? (e.data as CasualLeavePolicyErrors | null) : null;
      if (body?.errors) setServerProblems(body.errors as ClPolicyProblems);
      toast({ title: "Couldn't save the Casual Leave policy", description: errorText(e), variant: "destructive" });
    }
  };

  if (policy.isError && !data) {
    return (
      <div className="settings-glass rounded-xl p-6 text-sm text-slate-600" data-testid="cl-policy-error">
        <p className="font-semibold text-slate-900">The Casual Leave policy could not be loaded.</p>
        <p className="mt-1">{errorText(policy.error) ?? "Check the connection and try again."}</p>
        <Button size="sm" variant="outline" className="mt-3 gap-1.5" onClick={() => void policy.refetch()}>
          <RefreshCw size={13} /> Try again
        </Button>
      </div>
    );
  }

  const n = Number(form.eligibilityValue);
  const serviceOk = !problems.eligibilityValue;
  const perMonth = halfDays(form.monthlyAllocation, 0.5, LIMITS.monthlyMax);
  const perYear = halfDays(form.yearlyAllocation, 0.5, LIMITS.yearlyMax);
  const cap = halfDays(form.yearEndCarryMax, 0.5, LIMITS.yearlyMax);
  const carryLocked = monthly && !form.carryForward;

  return (
    <div className="space-y-4">
      <SettingsSection
        icon={CalendarCheck}
        title="Casual Leave policy"
        purpose="Who may take Casual Leave, how many days they get, what happens to the days they do not use, and whether half days are allowed. One company-wide rule for every staff member; production employees never take Casual Leave."
        testId="cl-policy-summary"
      >
        {!editable && (
          <div
            className="mb-3 flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800"
            data-testid="company-wide-notice"
          >
            <Lock size={14} className="mt-0.5 shrink-0" />
            <span>The policy is company-wide, so only a login for all units can change it.</span>
          </div>
        )}
        <p
          className="settings-clay-inset rounded-xl px-4 py-3 text-[14px] leading-relaxed text-slate-800"
          aria-live="polite"
          data-testid="cl-policy-sentence"
        >
          {summary(form)}
        </p>
        <p className="mt-2 text-[12px] leading-snug text-slate-500">
          Balances are worked out from the policy every time they are shown, so a change applies to everyone at once.
          Approved Casual Leave stays approved and paid; someone who has already used more than a new rule gives simply
          has nothing left until later months add days.
          {data?.updatedBy && data.updatedAt && (
            <span className="mt-1 block" data-testid="cl-policy-updated">
              Last changed by {data.updatedBy} on {dayText(data.updatedAt.slice(0, 10))}.
            </span>
          )}
        </p>
      </SettingsSection>

      <SettingsSection icon={UserCheck} title="Who may take Casual Leave">
        <SettingBlock
          {...meta("cl-service")}
          labelFor="cl-service-value"
          affects={AFFECTS_BALANCE.slice(0, 2)}
          defaultText="6 months"
          note="Judged on the day the employee asks. Their balance starts on the day the service is complete (the month's days count from that month)."
          preview={
            <PreviewCard title="When someone may start" scenario="Worked out from the value on screen, before saving.">
              {serviceOk ? (
                ["2026-04-15", "2026-08-31"].map((joined) => (
                  <PreviewLine
                    key={joined}
                    label={`Joined ${dayText(joined)}`}
                    result={`from ${dayText(eligibleFrom(joined, form.eligibilityBasis, n))}`}
                    tone="good"
                  />
                ))
              ) : (
                <PreviewLine label="Enter a valid number" result="to see the dates" tone="neutral" />
              )}
            </PreviewCard>
          }
        >
          <div className="flex flex-wrap items-start gap-2">
            <Input
              id="cl-service-value"
              inputMode="numeric"
              className="w-28 tabular-nums"
              value={form.eligibilityValue}
              disabled={disabled}
              aria-invalid={problems.eligibilityValue ? true : undefined}
              aria-describedby={problems.eligibilityValue ? "cl-service-error" : undefined}
              onChange={(e) => change("eligibilityValue", e.target.value)}
              data-testid="cl-service-value"
            />
            <div
              role="radiogroup"
              aria-label="Service counted in"
              className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5"
            >
              {(["months", "days"] as const).map((b) => (
                <button
                  key={b}
                  type="button"
                  role="radio"
                  aria-checked={form.eligibilityBasis === b}
                  disabled={disabled}
                  onClick={() => change("eligibilityBasis", b)}
                  className={cn(
                    "h-9 rounded-md px-3 text-sm font-semibold capitalize transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                    form.eligibilityBasis === b ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50",
                  )}
                  data-testid={`cl-service-basis-${b}`}
                >
                  {b}
                </button>
              ))}
            </div>
          </div>
          <FieldError id="cl-service-error" text={problems.eligibilityValue} />
          <p className="text-xs text-slate-500">
            0 means from the day they join. Up to {form.eligibilityBasis === "days" ? LIMITS.daysMax : LIMITS.monthsMax}{" "}
            {form.eligibilityBasis}.
          </p>
        </SettingBlock>
      </SettingsSection>

      <SettingsSection icon={CalendarPlus} title="Days given">
        <SettingBlock
          {...meta("cl-allocation")}
          affects={AFFECTS_BALANCE}
          defaultText="Earned every month"
          note="Switching changes every balance at once (see the year below before saving)."
        >
          <Choice
            label="How the days are given"
            value={form.allocation}
            disabled={disabled}
            onPick={(v) => change("allocation", v)}
            testId="cl-allocation"
            options={[
              {
                value: "monthly",
                title: "Earned every month",
                text: "Each month adds its days, from the month the employee's service is complete. A month's days cannot be used before that month.",
              },
              {
                value: "yearly",
                title: "The whole year at once",
                text: "All the year's days are there from 1 January (or from the day the service is complete), to use any time in the year.",
              },
            ]}
          />
        </SettingBlock>

        <SettingBlock
          {...meta("cl-days")}
          title={monthly ? "Days a month" : "Days a year"}
          labelFor="cl-days-value"
          defaultText={monthly ? "1 day a month" : "12 days a year"}
          preview={
            <PreviewCard title="A full year" scenario="Someone eligible all year, before anything is used.">
              <PreviewLine
                label="Days the year gives"
                result={
                  monthly
                    ? perMonth !== null
                      ? daysWord(perMonth * 12)
                      : "-"
                    : perYear !== null
                      ? daysWord(perYear)
                      : "-"
                }
                tone="good"
              />
              {monthly && perMonth !== null && (
                <PreviewLine
                  label="On hand in June, nothing used"
                  result={form.carryForward ? daysWord(perMonth * 6) : daysWord(perMonth)}
                />
              )}
            </PreviewCard>
          }
        >
          <Field
            label={monthly ? "Days each month adds" : "Days for the year"}
            htmlFor="cl-days-value"
            unit="days"
            error={monthly ? problems.monthlyAllocation : problems.yearlyAllocation}
            hint={
              form.halfDayAllowed
                ? "Whole or half days (1, 1.5, 2 ...)."
                : "Whole days (half days are switched off below)."
            }
          >
            <Input
              id="cl-days-value"
              inputMode="decimal"
              className="w-28 tabular-nums"
              value={monthly ? form.monthlyAllocation : form.yearlyAllocation}
              disabled={disabled}
              aria-invalid={(monthly ? problems.monthlyAllocation : problems.yearlyAllocation) ? true : undefined}
              onChange={(e) => change(monthly ? "monthlyAllocation" : "yearlyAllocation", e.target.value)}
              data-testid="cl-days-value"
            />
          </Field>
        </SettingBlock>

        <SettingBlock
          {...meta("cl-carry")}
          labelFor="cl-carry"
          defaultText="On"
          affects={[
            { where: "Balance", what: "on: unused days add up month after month; off: each month's days end with it" },
          ]}
        >
          {monthly ? (
            <ToggleField
              id="cl-carry"
              checked={form.carryForward}
              disabled={disabled}
              onChange={(v) => change("carryForward", v)}
              onLabel="Unused days carry forward"
              offLabel="Each month's days are for that month only"
            >
              {form.carryForward
                ? "No monthly limit: someone who used nothing from January to May may take all of it in June."
                : "Unused days end with the month; nothing builds up."}
            </ToggleField>
          ) : (
            <p className="text-sm text-slate-600" data-testid="cl-carry-yearly">
              With the whole year at once, unused days always stay for later in the year.
            </p>
          )}
        </SettingBlock>

        <SettingBlock {...meta("cl-half-days")} labelFor="cl-half-days" defaultText="On">
          <ToggleField
            id="cl-half-days"
            checked={form.halfDayAllowed}
            disabled={disabled}
            onChange={(v) => change("halfDayAllowed", v)}
            onLabel="Half days allowed (0.5 day each)"
            offLabel="Full days only"
          >
            {form.halfDayAllowed
              ? "Employees may ask for the first or the second half of their shift."
              : "The apps offer Full day only; a half-day request is refused. Requests already made stay as they are."}
          </ToggleField>
        </SettingBlock>
      </SettingsSection>

      <SettingsSection icon={CalendarClock} title="31 December">
        <SettingBlock
          {...meta("cl-year-end")}
          defaultText="Lapse"
          note={
            carryLocked
              ? "With carry forward off nothing is left over at the end of a month, so nothing can move into the next year."
              : undefined
          }
        >
          <Choice
            label="Unused days at the end of the year"
            value={form.yearEnd}
            disabled={disabled}
            onPick={(v) => change("yearEnd", v)}
            testId="cl-year-end"
            options={[
              { value: "lapse", title: "Lapse", text: "Unused days end on 31 December; 1 January starts afresh." },
              {
                value: "carry",
                title: "Move into the next year",
                text: "Unused days are added to the next year's balance.",
                locked: carryLocked ? "Needs Carry forward on (Days given above)." : undefined,
              },
            ]}
          />
          <FieldError id="cl-year-end-error" text={problems.yearEnd} />
          {form.yearEnd === "carry" && (
            <Field
              label="Most days that move"
              htmlFor="cl-year-end-max"
              unit="days"
              error={problems.yearEndCarryMax}
              hint={cap !== null ? `Up to ${daysWord(cap)} move; the rest lapse.` : "Empty: every unused day moves."}
            >
              <Input
                id="cl-year-end-max"
                inputMode="decimal"
                className="w-28 tabular-nums"
                placeholder="No limit"
                value={form.yearEndCarryMax}
                disabled={disabled}
                aria-invalid={problems.yearEndCarryMax ? true : undefined}
                onChange={(e) => change("yearEndCarryMax", e.target.value)}
                data-testid="cl-year-end-max"
              />
            </Field>
          )}
        </SettingBlock>
      </SettingsSection>

      <SettingsSection
        icon={CalendarCheck}
        title="How a year works out"
        purpose={`${serviceText(form)}, ${allocationText(form)}: one example employee, worked out from the values on screen before saving.`}
        testId="cl-year-section"
      >
        <YearRibbon form={form} />
      </SettingsSection>

      <SettingsSection icon={History} title="When the policy starts">
        <SettingBlock
          {...meta("cl-start")}
          labelFor="cl-start"
          defaultText="02 Nov 2026"
          note="Moving this day changes every balance at once. Casual Leave HR gives on the Carry Forward tab counts whatever its date."
        >
          <Input
            id="cl-start"
            type="date"
            className="w-44"
            value={form.balanceSince}
            disabled={disabled}
            aria-invalid={problems.balanceSince ? true : undefined}
            onChange={(e) => change("balanceSince", e.target.value)}
            data-testid="cl-start"
          />
          <FieldError id="cl-start-error" text={problems.balanceSince} />
          {!problems.balanceSince && (
            <p className="text-xs text-slate-500">
              Casual Leave dated before {dayText(form.balanceSince)} is not counted; it kept the older rule of one a
              month.
            </p>
          )}
        </SettingBlock>
      </SettingsSection>

      <SaveFooter
        dirty={dirty}
        saving={update.isPending}
        onSave={() => void save()}
        onDiscard={() => {
          discard();
          setServerProblems({});
        }}
        saveLabel="Save Casual Leave Policy"
        disabled={disabled || !dirty || hasProblems}
        hint={
          !data
            ? "Loading the saved policy…"
            : !editable
              ? "Company-wide: only a login for all units can change it."
              : dirty
                ? hasProblems
                  ? "Unsaved changes - fix the highlighted field first."
                  : "Unsaved changes - every balance keeps the saved policy until you save."
                : undefined
        }
      />
    </div>
  );
}

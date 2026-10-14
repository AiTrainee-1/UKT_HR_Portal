import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PreviewCard, PreviewLine } from "../kit/SettingBlock";
import { EXAMPLE_PAY_LINE } from "../attendance/example";
import { parseNumber } from "../payroll/form";
import { extraMinutesOf, THRESHOLD, ALLOWANCE_MINUTES, type CompensationDraft } from "./form";
import {
  allowanceFor,
  allowanceLimit,
  dayWords,
  EXAMPLE_SHIFT,
  judgeFirstPunch,
  payForShifts,
  shiftFor,
  shiftsText,
  ruleName,
  type AllowanceValue,
  type FirstPunch,
  type ShiftValue,
} from "./preview";
import { formatClock, formatDuration, formatShort, formatUntil, parseUntil } from "./time";

const SHIFT_TEXT = `A ${formatClock(EXAMPLE_SHIFT.start)} to ${formatClock(EXAMPLE_SHIFT.end)} shift with ${EXAMPLE_SHIFT.grace} minutes' grace`;

/** The Type 1 rows that can be read as numbers (a row being typed is skipped), with their names. */
function allowanceValues(draft: CompensationDraft): (AllowanceValue & { label: string })[] {
  return draft.allowanceRules.flatMap((r) => {
    const extra = extraMinutesOf(r);
    const allowance = parseNumber(r.allowanceMinutes, ALLOWANCE_MINUTES).value;
    if (extra === null || extra < 1 || allowance === null) return [];
    return [{ enabled: r.enabled, minExtraMinutes: extra, allowanceMinutes: allowance, label: r.label }];
  });
}

/** The Type 2 rows that can be read (a limit being typed is skipped). */
function shiftValues(draft: CompensationDraft): ShiftValue[] {
  return draft.shiftRules.flatMap<ShiftValue>((r) => {
    const shifts = Number(r.shifts);
    if (!Number.isFinite(shifts)) return [];
    if (r.noLimit) return [{ enabled: r.enabled, untilMinutes: null, shifts }];
    const until = parseUntil(r.until);
    return until.error === undefined ? [{ enabled: r.enabled, untilMinutes: until.minutes, shifts }] : [];
  });
}

const PUNCH_RESULT: Record<FirstPunch, { text: string; tone: "good" | "info" | "warn" }> = {
  "on-time": { text: "On time: the allowance is not used, nothing is marked", tone: "good" },
  compensation: { text: "Not Late: marked Compensation", tone: "info" },
  "late-rules": { text: "After the allowance: the normal Late rules judge it", tone: "warn" },
};

/**
 * Type 1 worked out with the rows on screen: how long somebody worked past the shift end (try your own number), the
 * allowance that earns, and what that does to the next morning's first punch.
 */
export function Type1Example({ draft }: { draft: CompensationDraft }) {
  const [extraText, setExtraText] = useState("120");
  const extra = parseNumber(extraText, { min: 1, max: 1440, decimals: 0 });
  const rules = allowanceValues(draft);
  const threshold = parseNumber(draft.shiftMinExtra, THRESHOLD).value ?? 150;
  const beyond = extra.value !== null && extra.value > threshold;
  const found = extra.value === null ? null : allowanceFor(extra.value, rules, threshold);
  const allowance = found?.minutes ?? 0;
  const rule = found && found.rule !== null ? rules[found.rule] : null;
  const { start, grace } = EXAMPLE_SHIFT;
  const punches = [
    start + grace,
    start + grace + Math.max(1, Math.floor(allowance / 2)),
    allowanceLimit(allowance),
    allowanceLimit(allowance) + 1,
  ].filter((p, i, all) => all.indexOf(p) === i);

  return (
    <PreviewCard
      title="Worked example"
      scenario={`${SHIFT_TEXT}. Try how long the employee works after the shift ends (not saved).`}
      testId="type1-example"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor="type1-try-extra" className="text-[12px] font-semibold text-gray-700">
          Extra work after {formatClock(EXAMPLE_SHIFT.end)}
        </Label>
        <Input
          id="type1-try-extra"
          type="text"
          inputMode="numeric"
          value={extraText}
          onChange={(e) => setExtraText(e.target.value)}
          className="h-8 w-20 bg-white text-xs tabular-nums"
          aria-invalid={extra.error ? true : undefined}
        />
        <span className="text-xs font-semibold text-gray-500">minutes</span>
      </div>
      {extra.error || extra.value === null ? (
        <p className="text-[12px] text-red-600" role="alert">
          {extra.error}
        </p>
      ) : (
        <>
          <PreviewLine
            testId="type1-allowance-line"
            label={`Works until ${formatUntil(EXAMPLE_SHIFT.end + extra.value)} (${formatDuration(extra.value)} extra)`}
            result={
              rule
                ? `Allowance ${allowance} minutes (row "${ruleName(rule)}")`
                : beyond
                  ? `No allowance: more than ${formatShort(threshold)} of extra work is Type 2's`
                  : "No allowance: less than the smallest row that is on"
            }
            tone={rule ? "info" : "neutral"}
          />
          {punches.map((punch) => {
            const verdict = PUNCH_RESULT[judgeFirstPunch(punch, allowance)];
            return (
              <PreviewLine
                key={punch}
                testId="type1-punch-line"
                label={`Next morning, first punch ${formatClock(punch)}`}
                result={verdict.text}
                tone={verdict.tone}
              />
            );
          })}
          {allowance > 0 && (
            <p className="text-[11px] leading-snug text-gray-500" data-testid="type1-limit-note">
              The first punch is not Late up to {formatClock(allowanceLimit(allowance))}: the shift start (
              {formatClock(start)}) + the allowance ({allowance} minutes) + the shift's grace ({grace} minutes). The
              employee decides whether to use it; nothing is paid.
            </p>
          )}
        </>
      )}
    </PreviewCard>
  );
}

const SAMPLE_PUNCHES = [20 * 60, 20 * 60 + 30, 22 * 60 + 30, 24 * 60 + 40, 27 * 60 + 15];

/**
 * Type 2 worked out with the rows on screen: the last punch-outs of five made-up days, the shift each earns, and what that
 * is worth as Relaxation and as Payment (only the ones that are switched on).
 */
export function Type2Example({ draft }: { draft: CompensationDraft }) {
  const [tryText, setTryText] = useState("11:40 PM");
  const threshold = parseNumber(draft.shiftMinExtra, THRESHOLD).value ?? 150;
  const rules = shiftValues(draft);
  const end = EXAMPLE_SHIFT.end;

  const meaning = (shifts: number): string => {
    const parts: string[] = [];
    if (draft.relaxationEnabled) parts.push(`${dayWords(shifts)} off as Relaxation`);
    if (draft.payEnabled) parts.push(`${payForShifts(shifts)} as Payment`);
    return parts.length ? ` = ${parts.join(" or ")}` : " (neither Relaxation nor Payment is on)";
  };
  const line = (punch: number, key: string, testId: string) => {
    const r = shiftFor(punch, threshold, rules, end);
    const label = `Last punch-out ${formatUntil(punch)} (${formatShort(r.extra)} after the ${formatClock(end)} end)`;
    if (!r.qualifies) {
      return (
        <PreviewLine
          key={key}
          testId={testId}
          label={label}
          result={`Not Type 2: not more than ${formatShort(threshold)} past the end`}
          tone="neutral"
        />
      );
    }
    if (r.shifts === null) {
      return (
        <PreviewLine
          key={key}
          testId={testId}
          label={label}
          result="No rule matches: nothing is suggested"
          tone="warn"
        />
      );
    }
    return (
      <PreviewLine
        key={key}
        testId={testId}
        label={label}
        result={`${shiftsText(r.shifts)}${meaning(r.shifts)}`}
        tone="good"
      />
    );
  };

  const tried = parseUntil(tryText);
  return (
    <PreviewCard
      title="Worked example"
      scenario={`${SHIFT_TEXT}; ${EXAMPLE_PAY_LINE}. Type 2 starts when the last punch-out is more than ${formatShort(threshold)} after ${formatClock(end)}.`}
      testId="type2-example"
    >
      {SAMPLE_PUNCHES.map((p) => line(p, String(p), "type2-line"))}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Label htmlFor="type2-try-punch" className="text-[12px] font-semibold text-gray-700">
          Try a last punch-out (not saved)
        </Label>
        <Input
          id="type2-try-punch"
          type="text"
          autoComplete="off"
          value={tryText}
          onChange={(e) => setTryText(e.target.value)}
          className="h-8 w-40 bg-white text-xs"
          aria-invalid={tried.error ? true : undefined}
        />
      </div>
      {tried.error !== undefined ? (
        <p className="text-[12px] text-red-600" role="alert">
          {tried.error}
        </p>
      ) : (
        line(tried.minutes, "try", "type2-try-line")
      )}
    </PreviewCard>
  );
}

import { useEffect, useState } from "react";
import { Calculator } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "@/lib/api-client/custom-fetch";
import { useProductionShiftPreview } from "@/lib/api-client/custom-hooks";
import { rupees } from "../attendance/example";
import { isIsoDate } from "../compensation/form";
import { PreviewCard, PreviewLine, SettingBlock, SettingsSection } from "../kit/SettingBlock";
import { PRODUCTION_SHIFT_SECTIONS, productionShiftText } from "../ProductionShiftsTab.meta";
import { nextSunday, parsePunches, weekdayOf } from "./time";

const block = (id: string) => ({ id, ...productionShiftText(id) });

/** The made-up rate the example pays (the Payroll tabs use the same ₹600 a shift). */
const PER_SHIFT = 600;
/** Wait this long after the last key before asking the server, so typing does not ask it for every letter. */
const TYPING_PAUSE_MS = 300;

/** The days a person can try with one click: the owner's own examples. `sunday` also picks the coming Sunday. */
const SAMPLES: { id: string; label: string; punches: string; sunday?: boolean }[] = [
  { id: "regular", label: "Regular day", punches: "08:30 12:45 13:30 20:00" },
  { id: "late-out", label: "Works until 10:30 PM", punches: "08:30 12:45 13:30 22:30" },
  { id: "day-night", label: "Day and full night", punches: "08:30 12:45 13:30 20:00 21:00 05:30" },
  { id: "night", label: "Night only", punches: "21:00 05:30" },
  { id: "sunday", label: "Sunday", punches: "08:30 17:00", sunday: true },
];

const STATUS: Record<string, string> = { present: "Present", half_shift: "Half shift", absent: "Absent" };

/** Why a try failed, in the server's own words when it gave one. */
function failureText(err: unknown): string {
  if (err instanceof ApiError) {
    const data = err.data as { error?: unknown } | null;
    if (data && typeof data.error === "string" && data.error.trim()) return data.error;
  }
  return "The day could not be worked out. Check the connection and try again.";
}

/**
 * "Try a day": type the punches of a made-up day and see what the saved rules make of it, through the server's own
 * calculation (a POST that reads and never writes), so what is shown is exactly what attendance and payroll would do.
 * It is never the unsaved form: a change must be saved before it can be tried, and the box says so while there is one.
 */
export function TryItSection({ dirty, today }: { dirty: boolean; today: string }) {
  const [text, setText] = useState(SAMPLES[0].punches);
  const [date, setDate] = useState(today);
  const [asked, setAsked] = useState({ text, date });
  useEffect(() => {
    const timer = setTimeout(() => setAsked({ text, date }), TYPING_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [text, date]);

  const read = parsePunches(text);
  const askedRead = parsePunches(asked.text);
  const request =
    askedRead.error === null && isIsoDate(asked.date)
      ? { punches: askedRead.punches.map((p) => p.hhmm), date: asked.date }
      : null;
  const preview = useProductionShiftPreview(request);
  const result = request ? preview.data : undefined;
  const weekday = weekdayOf(date);
  const waiting = request !== null && preview.isFetching && !preview.isError;

  return (
    <SettingsSection
      id="production-shifts-try"
      icon={Calculator}
      title={PRODUCTION_SHIFT_SECTIONS.tryIt}
      purpose="Check the rules on a day before you rely on them: type what a worker punched and see the shifts, the group and the rule used."
      testId="production-shifts-try"
    >
      <SettingBlock
        {...block("try-it")}
        affects={[
          {
            where: "Production Attendance",
            what: "the real days are worked out the same way, by the same calculation",
            to: "/hr/attendance/production",
          },
        ]}
        preview={
          <PreviewCard
            title="What it makes of this day"
            scenario={`With the saved rules, for a worker paid ${rupees(PER_SHIFT)} per shift (a made-up rate).`}
            testId="try-result"
          >
            {read.error !== null || !isIsoDate(date) ? (
              <p className="text-[12px] text-gray-500" data-testid="try-waiting">
                Enter the punches and a date to see the result.
              </p>
            ) : preview.isError && request ? (
              <p role="alert" className="text-[12px] font-medium text-red-600" data-testid="try-error">
                {failureText(preview.error)}
              </p>
            ) : !result ? (
              <p className="text-[12px] text-gray-500" data-testid="try-loading">
                Working it out...
              </p>
            ) : (
              <div className={waiting ? "space-y-1.5 opacity-60" : "space-y-1.5"} data-testid="try-answer">
                <PreviewLine testId="try-group" label="Group used" result={result.group || "-"} tone="neutral" />
                <PreviewLine
                  testId="try-shifts"
                  label="Shifts earned"
                  result={`${Number(result.shifts).toFixed(2)} shift${Number(result.shifts) === 1 ? "" : "s"} = ${rupees(Number(result.shifts) * PER_SHIFT)}`}
                  tone={Number(result.shifts) > 0 ? "good" : "warn"}
                />
                <PreviewLine
                  testId="try-status"
                  label="The day is marked"
                  result={STATUS[result.status] ?? result.status}
                  tone={result.status === "present" ? "good" : "warn"}
                />
                <PreviewLine
                  testId="try-late"
                  label="Late"
                  result={result.isLate ? "Yes: the first punch was after the grace" : "No"}
                  tone={result.isLate ? "warn" : "neutral"}
                />
                <PreviewLine
                  testId="try-early"
                  label="Left early"
                  result={result.earlyLeave ? "Yes: before the standard departure" : "No"}
                  tone={result.earlyLeave ? "warn" : "neutral"}
                />
                {result.note && (
                  <p className="text-[12px] leading-snug text-gray-700" data-testid="try-note">
                    {result.note}
                  </p>
                )}
              </div>
            )}
          </PreviewCard>
        }
      >
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="production-try-punches" className="text-xs font-semibold text-gray-700">
              Punch times, in the order they happened
            </Label>
            <Input
              id="production-try-punches"
              type="text"
              autoComplete="off"
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-invalid={read.error ? true : undefined}
              className="h-9 bg-white"
            />
            {read.error ? (
              <p role="alert" className="text-xs font-medium text-red-600" data-testid="try-parse-error">
                {read.error}
              </p>
            ) : (
              <p className="text-xs leading-snug text-gray-500" data-testid="try-read-as">
                Read as: {read.punches.map((p) => p.text).join(", ")}. A time not later than the one before it is the
                next morning.
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="production-try-date" className="text-xs font-semibold text-gray-700">
              Date
            </Label>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="production-try-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="h-9 w-44 bg-white"
              />
              {weekday && (
                <span className="text-xs font-semibold text-gray-600" data-testid="try-weekday">
                  {weekday}
                </span>
              )}
            </div>
            <p className="text-xs text-gray-500">
              The day matters: Sunday has a group of its own, and a day before the rules start is worked out the old
              way.
            </p>
          </div>
          <div className="space-y-1.5">
            <p className="text-xs font-semibold text-gray-700">Or try one of these</p>
            <div className="flex flex-wrap gap-1.5">
              {SAMPLES.map((s) => (
                <Button
                  key={s.id}
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  data-view-safe
                  data-testid={`try-sample-${s.id}`}
                  onClick={() => {
                    setText(s.punches);
                    if (s.sunday) setDate(nextSunday(today));
                    else if (weekdayOf(date) === "Sunday") setDate(today);
                  }}
                >
                  {s.label}
                </Button>
              ))}
            </div>
          </div>
          {dirty && (
            <p
              className="rounded-lg bg-amber-50 px-2.5 py-2 text-xs leading-snug text-amber-900 ring-1 ring-amber-200"
              data-testid="try-unsaved"
            >
              You have changes on this tab that are not saved. This day is worked out with the saved rules: save first
              to try the new ones.
            </p>
          )}
        </div>
      </SettingBlock>
    </SettingsSection>
  );
}

import { useState, type ReactNode } from "react";
import { AlertTriangle, CalendarDays, Download, Info, Loader2, ReceiptText, Wand2 } from "lucide-react";
import { Avatar, EmptyNote } from "@/components/payroll/kit/parts";
import { dateShort, dateTime, inr } from "@/components/payroll/kit/format";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useSalarySlipPreview,
  useSavedSalarySlip,
  type SavedSlipSummary,
  type SlipCenterEmployee,
  type SlipOptions,
  type SlipResult,
} from "@/lib/api-client/custom-hooks/salary-slip-center";
import { cn } from "@/lib/utils";
import { calendarTitle, calendarWeeks, dayOfMonth, errorText, optionsText, sameOptions } from "./logic";
import { OptionSwitches } from "./OptionsBar";
import { ACCENT, CategoryChip, RowBadges, calendarMeta } from "./parts";

type Mode = "saved" | "live";

/**
 * One employee's slip in a side sheet: the saved slip when one exists (else a live preview, worked out now and not saved),
 * with the days, earnings, deductions, NET in words, notes and a day-by-day calendar. Generate & save (edit) and Download.
 */
export function PreviewSheet({
  employee,
  month,
  year,
  options,
  onOptions,
  canEdit,
  busy,
  onGenerate,
  onDownload,
  onClose,
}: {
  employee: SlipCenterEmployee | null;
  month: number;
  year: number;
  options: SlipOptions;
  onOptions: (options: SlipOptions) => void;
  canEdit: boolean;
  busy: boolean;
  onGenerate: (row: SlipCenterEmployee) => void;
  onDownload: (row: SlipCenterEmployee) => void;
  onClose: () => void;
}) {
  return (
    <Sheet open={employee !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl" data-testid="ssc-preview">
        {employee && (
          // keyed: another employee starts on their own saved / live choice
          <PreviewBody
            key={employee.id}
            employee={employee}
            month={month}
            year={year}
            options={options}
            onOptions={onOptions}
            canEdit={canEdit}
            busy={busy}
            onGenerate={onGenerate}
            onDownload={onDownload}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function PreviewBody({
  employee,
  month,
  year,
  options,
  onOptions,
  canEdit,
  busy,
  onGenerate,
  onDownload,
}: {
  employee: SlipCenterEmployee;
  month: number;
  year: number;
  options: SlipOptions;
  onOptions: (options: SlipOptions) => void;
  canEdit: boolean;
  busy: boolean;
  onGenerate: (row: SlipCenterEmployee) => void;
  onDownload: (row: SlipCenterEmployee) => void;
}) {
  const hasSaved = employee.slip !== null;
  const [chosen, setChosen] = useState<Mode>("saved");
  const mode: Mode = hasSaved ? chosen : "live";
  const saved = useSavedSalarySlip({ month, year, employeeId: employee.id }, mode === "saved");
  // a saved slip the server no longer has (deleted meanwhile) reads as "not generated": the live preview shows instead
  const savedMissing = mode === "saved" && saved.isSuccess && saved.data === null;
  const showSaved = mode === "saved" && !savedMissing;
  const live = useSalarySlipPreview({ month, year, employeeId: employee.id, options }, !showSaved);
  const query = showSaved ? saved : live;
  const result: SlipResult | undefined = showSaved ? (saved.data?.result ?? undefined) : live.data;
  const loading = showSaved ? saved.isLoading : live.isLoading;
  const summary: SavedSlipSummary | null = showSaved ? (saved.data?.slip ?? employee.slip) : null;

  return (
    <>
      <div className="flex-1 overflow-y-auto px-5 pb-6 pt-5 sm:px-6">
        <SheetHeader className="space-y-3 pb-4 text-left">
          <div className="flex items-start gap-3 pr-8">
            <Avatar name={employee.name} size={44} />
            <div className="min-w-0 flex-1">
              <SheetTitle className="flex flex-wrap items-center gap-1.5 text-base">
                <span className="truncate">{employee.name}</span>
                <RowBadges row={employee} />
              </SheetTitle>
              <SheetDescription className="text-xs">
                <span className="font-mono">{employee.code}</span>
                {employee.designation && <> · {employee.designation}</>}
                {employee.department && <> · {employee.department}</>}
                {employee.unit && <> · {employee.unit}</>}
              </SheetDescription>
              <div className="mt-1.5">
                <CategoryChip category={employee.category} />
              </div>
            </div>
          </div>

          {hasSaved && (
            <div
              className="inline-flex w-fit rounded-xl bg-gray-100 p-0.5 text-xs font-semibold"
              role="tablist"
              aria-label="Which slip to show"
            >
              {(["saved", "live"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={mode === m}
                  onClick={() => setChosen(m)}
                  className={cn(
                    "rounded-lg px-3 py-1.5 transition-colors",
                    mode === m ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-800",
                  )}
                  data-testid={`ssc-preview-mode-${m}`}
                >
                  {m === "saved" ? "Saved slip" : "Live preview"}
                </button>
              ))}
            </div>
          )}

          <ModeNote mode={showSaved ? "saved" : "live"} summary={summary} current={options} />
          {!showSaved && (
            <div className="rounded-xl border border-dashed border-gray-200 px-3 py-2">
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Deductions taken</p>
              <OptionSwitches options={options} onChange={onOptions} idPrefix="ssc-preview-opt" />
            </div>
          )}
        </SheetHeader>

        {loading ? (
          <div className="space-y-3" data-testid="ssc-preview-loading">
            <Skeleton className="h-16 w-full rounded-xl" />
            <Skeleton className="h-24 w-full rounded-xl" />
            <Skeleton className="h-40 w-full rounded-xl" />
            <Skeleton className="h-20 w-full rounded-xl" />
          </div>
        ) : query.isError ? (
          <EmptyNote
            icon={AlertTriangle}
            title="This slip cannot be worked out"
            hint={errorText(query.error)}
            testId="ssc-preview-error"
          />
        ) : result ? (
          <SlipView result={result} />
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t bg-white px-5 py-3 sm:px-6">
        {!hasSaved && !canEdit && (
          <p className="mr-auto text-xs text-gray-500">
            Not generated yet: someone with edit rights has to generate it.
          </p>
        )}
        {canEdit && (
          <Button
            className="gap-1.5 border-0 text-white"
            style={{ background: ACCENT }}
            onClick={() => onGenerate(employee)}
            disabled={busy || query.isError}
            title={`Works the slip out with the deductions switched on (${optionsText(options)}) and saves it`}
            data-testid="ssc-preview-generate"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
            {hasSaved ? "Generate again & save" : "Generate & save"}
          </Button>
        )}
        <Button
          variant="outline"
          className="gap-1.5"
          onClick={() => onDownload(employee)}
          disabled={busy || (!hasSaved && !canEdit)}
          data-testid="ssc-preview-download"
        >
          <Download size={14} /> Download slip
        </Button>
      </div>
    </>
  );
}

/** Which slip this is: the saved one (when, by whom, with which deductions) or a live preview that is not saved. */
function ModeNote({ mode, summary, current }: { mode: Mode; summary: SavedSlipSummary | null; current: SlipOptions }) {
  if (mode === "saved" && summary) {
    return (
      <div className="flex items-start gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
        <ReceiptText size={14} className="mt-0.5 shrink-0" />
        <div>
          <p className="font-semibold">
            Saved slip {summary.slipNumber} · generated {dateTime(summary.generatedAt)}
            {summary.generatedBy ? ` by ${summary.generatedBy}` : ""}
          </p>
          <p className="opacity-80">
            Deductions taken: {optionsText(summary.options)}
            {!sameOptions(summary.options, current) && " (different from the switches on the page now)"}. This is the
            slip the downloads use.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2 rounded-xl bg-sky-50 px-3 py-2 text-xs text-sky-900">
      <Info size={14} className="mt-0.5 shrink-0" />
      <p>
        <span className="font-semibold">Live preview, not saved.</span> Worked out now from the employee&apos;s current
        details and attendance. Generate & save it to use it in the downloads.
      </p>
    </div>
  );
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h4>
        {aside}
      </div>
      {children}
    </section>
  );
}

const money = (n: number) => inr(n, 2);

function formatValue(v: number | string | null): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(2)));
  return v;
}

/** The slip itself. */
export function SlipView({ result }: { result: SlipResult }) {
  const { period, rate, employee } = result;
  const staff = result.kind !== "production";
  return (
    <div className="space-y-5" data-testid="ssc-slip-view">
      <div className="rounded-xl border bg-gray-50/60 px-3 py-2.5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm font-bold text-gray-900">{period.label}</p>
          <p className="text-xs text-gray-500">
            {dateShort(period.from)} - {dateShort(period.to)}
          </p>
        </div>
        {result.slipNumber && <p className="font-mono text-[11px] text-gray-400">{result.slipNumber}</p>}
        {period.inProgress && (
          <p className="mt-1.5 flex items-start gap-1.5 text-xs text-amber-800" data-testid="ssc-counted-to">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            Counted up to {dateShort(period.countedTo)}: the month is not over yet.
          </p>
        )}
        <p className="mt-1.5 text-xs text-gray-600">
          {staff ? (
            <>
              {inr(rate.monthlySalary)} a month
              {rate.dailyRate !== null && <> · {money(rate.dailyRate)} a day</>}
              {rate.companyDays !== null && <> · {rate.companyDays} company days</>}
            </>
          ) : (
            <>{money(rate.salaryPerShift ?? 0)} a shift</>
          )}
        </p>
      </div>

      {result.days.length > 0 && (
        <Section title="Days">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {result.days.map((d) => (
              <div key={d.key} className="rounded-xl border bg-white px-3 py-2">
                <p className="text-[11px] text-gray-500">{d.label}</p>
                <p className="text-base font-black tabular-nums text-gray-900">{formatValue(d.value)}</p>
              </div>
            ))}
          </div>
        </Section>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Section title="Earnings">
          <AmountTable
            lines={result.earnings}
            totalLabel="Gross"
            total={result.grossTotal}
            empty="No earnings"
            tone="emerald"
          />
        </Section>
        <Section title="Deductions">
          <AmountTable
            lines={result.deductions}
            totalLabel="Total deductions"
            total={result.deductionsTotal}
            empty="No deductions"
            tone="red"
          />
        </Section>
      </div>

      <div className="rounded-2xl bg-indigo-50 px-4 py-3" data-testid="ssc-net">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm font-semibold text-indigo-900">Net pay</p>
          <p className="text-2xl font-black tabular-nums text-indigo-950">{inr(result.net)}</p>
        </div>
        {result.netInWords && (
          <p className="mt-0.5 text-xs font-medium uppercase tracking-wide text-indigo-800">
            <span className="normal-case opacity-70">In words: </span>
            {result.netInWords}
          </p>
        )}
      </div>

      {result.notes.length > 0 && (
        <Section title="Notes">
          <ul className="list-disc space-y-1 pl-5 text-xs text-gray-700">
            {result.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </Section>
      )}

      {result.calendar.length > 0 && <SlipCalendar result={result} />}

      <Section title="Employee and bank">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 rounded-xl border bg-white px-3 py-2.5 text-xs sm:grid-cols-2">
          <Fact label="Joined" value={dateShort(employee.joinDate)} />
          <Fact
            label="Status"
            value={employee.status ? employee.status[0].toUpperCase() + employee.status.slice(1) : "—"}
          />
          <Fact label="Bank" value={employee.bankName} />
          <Fact label="Account" value={employee.bankAccountMasked} mono />
          <Fact label="IFSC" value={employee.ifsc} mono />
          <Fact label="UAN" value={employee.uanNumber} mono />
          <Fact label="PF number" value={employee.pfNumber} mono />
          <Fact label="ESI number" value={employee.esiNumber} mono />
        </dl>
      </Section>
    </div>
  );
}

function Fact({ label, value, mono }: { label: string; value: string | null | undefined; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-gray-400">{label}</dt>
      <dd className={cn("text-right font-medium text-gray-700", mono && "font-mono")}>{value || "—"}</dd>
    </div>
  );
}

function AmountTable({
  lines,
  totalLabel,
  total,
  empty,
  tone,
}: {
  lines: SlipResult["earnings"];
  totalLabel: string;
  total: number;
  empty: string;
  tone: "emerald" | "red";
}) {
  return (
    <div className="overflow-hidden rounded-xl border bg-white text-sm">
      {lines.length === 0 ? (
        <p className="px-3 py-2 text-xs text-gray-400">{empty}</p>
      ) : (
        <ul className="divide-y">
          {lines.map((l) => (
            <li key={l.key} className="flex items-start justify-between gap-3 px-3 py-1.5">
              <span className="min-w-0 text-gray-700">
                {l.label}
                {l.note && <span className="block text-[11px] text-gray-400">{l.note}</span>}
              </span>
              <span className="shrink-0 font-semibold tabular-nums text-gray-900">{money(l.amount)}</span>
            </li>
          ))}
        </ul>
      )}
      <div
        className={cn(
          "flex justify-between gap-3 border-t px-3 py-2 font-bold",
          tone === "emerald" ? "bg-emerald-50 text-emerald-900" : "bg-red-50 text-red-900",
        )}
      >
        <span>{totalLabel}</span>
        <span className="tabular-nums">{money(total)}</span>
      </div>
    </div>
  );
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** The month day by day, Monday-first, each day in its status colour (hover for the punches); a legend underneath. */
function SlipCalendar({ result }: { result: SlipResult }) {
  const weeks = calendarWeeks(result.calendar);
  const seen = [...new Set(result.calendar.map((d) => d.status))];
  return (
    <Section
      title="Day by day"
      aside={
        <span className="inline-flex items-center gap-1 text-[11px] text-gray-400">
          <CalendarDays size={12} /> hover a day for its punches
        </span>
      }
    >
      <div className="rounded-xl border bg-white p-2" data-testid="ssc-calendar">
        <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-semibold uppercase text-gray-400">
          {WEEKDAYS.map((d) => (
            <span key={d}>{d}</span>
          ))}
        </div>
        <div className="mt-1 space-y-1">
          {weeks.map((week, i) => (
            <div key={i} className="grid grid-cols-7 gap-1">
              {week.map((day, j) => {
                if (!day) return <span key={j} />;
                const meta = calendarMeta(day.status);
                return (
                  <div
                    key={day.date}
                    className={cn(
                      "relative flex h-10 flex-col items-center justify-center rounded-lg text-xs font-bold",
                      meta.cell,
                    )}
                    title={calendarTitle(day, meta.label)}
                    data-status={day.status}
                  >
                    {dayOfMonth(day.date)}
                    {day.shifts !== null && day.shifts > 0 && day.shifts !== 1 && (
                      <span className="text-[9px] font-semibold opacity-70">{day.shifts}</span>
                    )}
                    {day.late && (
                      <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-orange-500" aria-hidden />
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 px-1 text-[11px] text-gray-500">
          {seen.map((s) => {
            const meta = calendarMeta(s);
            return (
              <span key={s} className="inline-flex items-center gap-1">
                <span className={cn("h-2 w-2 rounded-full border border-gray-200", meta.dot)} />
                {meta.label}
              </span>
            );
          })}
          {result.calendar.some((d) => d.late) && (
            <span className="inline-flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-orange-500" /> Late
            </span>
          )}
        </div>
      </div>
    </Section>
  );
}

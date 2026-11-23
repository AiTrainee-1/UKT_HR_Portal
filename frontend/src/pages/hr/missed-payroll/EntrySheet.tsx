import { useState } from "react";
import { AlertTriangle, CalendarDays, ChevronDown, Loader2, Wand2 } from "lucide-react";
import { Avatar, EmptyNote } from "@/components/payroll/kit/parts";
import { dateShort, inr } from "@/components/payroll/kit/format";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import type { MoneyLine } from "@/lib/api-client/custom-hooks/payroll-insights";
import {
  useMissedPayrollEntry,
  type MissedCategory,
  type MissedEntryDay,
  type MissedEntryDetail,
  type MissedKind,
  type MissedRow,
} from "@/lib/api-client/custom-hooks/missed-payroll";
import { cn } from "@/lib/utils";
import { ACCENT } from "../salary-slip-center/parts";
import { errorText } from "./logic";
import { CategoryChip, RowBadges, StatusChip, entryTrail } from "./parts";

/** The statement values worth showing, in the statement's own order and words (payroll_statement_views.py columns). */
const STATEMENT_FIELDS: Record<MissedKind, { key: string; label: string; money?: boolean }[]> = {
  staff: [
    { key: "present", label: "Present" },
    { key: "cl", label: "CL" },
    { key: "lop", label: "LOP" },
    { key: "hd", label: "HD" },
    { key: "totalDays", label: "Total days" },
    { key: "basic", label: "Basic salary", money: true },
    { key: "total", label: "Total", money: true },
    { key: "petrol", label: "Petrol", money: true },
    { key: "othersAllow", label: "Others allow", money: true },
    { key: "eSalary", label: "E salary", money: true },
    { key: "advance", label: "Advance", money: true },
    { key: "esi", label: "ESI", money: true },
    { key: "pf", label: "PF", money: true },
    { key: "tds", label: "TDS", money: true },
    { key: "others", label: "Others", money: true },
    { key: "totalDeduction", label: "Total deduction", money: true },
    { key: "net", label: "NET", money: true },
  ],
  production: [
    { key: "rate", label: "Rate / shift", money: true },
    { key: "days", label: "Days paid" },
    { key: "worked", label: "Days worked" },
    { key: "absent", label: "Absent" },
    { key: "late", label: "Late" },
    { key: "shifts", label: "Shifts" },
    { key: "eSalary", label: "E salary", money: true },
    { key: "advance", label: "Advance", money: true },
    { key: "esi", label: "ESI / EF", money: true },
    { key: "pf", label: "PF", money: true },
    { key: "tds", label: "TDS", money: true },
    { key: "others", label: "Others", money: true },
    { key: "totalDeduction", label: "Total deduction", money: true },
    { key: "net", label: "NET", money: true },
  ],
};

const asNumber = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** One entry's figures in a side sheet: the money lines, the statement row they become on Done, the days and who did what. */
export function EntrySheet({
  row,
  kind,
  period,
  categoryLabels,
  canGenerate,
  busy,
  onGenerate,
  onAttendance,
  onClose,
}: {
  /** The employee (with an entry); null = closed. */
  row: MissedRow | null;
  kind: MissedKind;
  period: string;
  categoryLabels: Record<MissedCategory, string>;
  /** May generate (edit rights); the row itself says whether it can be generated again. */
  canGenerate: boolean;
  busy: boolean;
  onGenerate: (row: MissedRow) => void;
  onAttendance: (row: MissedRow) => void;
  onClose: () => void;
}) {
  return (
    <Sheet open={row !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl" data-testid="mp-figures">
        {row && (
          <EntryBody
            key={row.id}
            row={row}
            kind={kind}
            period={period}
            categoryLabels={categoryLabels}
            canGenerate={canGenerate}
            busy={busy}
            onGenerate={onGenerate}
            onAttendance={onAttendance}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function EntryBody({
  row,
  kind,
  period,
  categoryLabels,
  canGenerate,
  busy,
  onGenerate,
  onAttendance,
}: {
  row: MissedRow;
  kind: MissedKind;
  period: string;
  categoryLabels: Record<MissedCategory, string>;
  canGenerate: boolean;
  busy: boolean;
  onGenerate: (row: MissedRow) => void;
  onAttendance: (row: MissedRow) => void;
}) {
  const query = useMissedPayrollEntry(row.entry?.id ?? null);
  const detail = query.data;
  const again = canGenerate && row.canGenerate && row.entry?.status === "generated";
  return (
    <>
      <div className="flex-1 overflow-y-auto px-5 pb-6 pt-5 sm:px-6">
        <SheetHeader className="space-y-3 pb-4 text-left">
          <div className="flex items-start gap-3 pr-8">
            <Avatar name={row.name} size={44} />
            <div className="min-w-0 flex-1">
              <SheetTitle className="flex flex-wrap items-center gap-1.5 text-base">
                <span className="truncate">{row.name}</span>
                <RowBadges row={row} />
              </SheetTitle>
              <SheetDescription className="text-xs">
                <span className="font-mono">{row.code}</span>
                {row.designation && <> · {row.designation}</>}
                {row.department && <> · {row.department}</>}
                {row.unit && <> · {row.unit}</>}
              </SheetDescription>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <CategoryChip
                  category={row.entry?.category ?? row.category}
                  label={categoryLabels[row.entry?.category ?? row.category] ?? row.categoryLabel}
                />
                {row.entry && <StatusChip status={row.entry.status} />}
                <span className="text-xs text-gray-500">Missed payroll, {period}</span>
              </div>
            </div>
          </div>
          {row.entry && (
            <p className="whitespace-pre-line text-[11px] leading-relaxed text-gray-500" data-testid="mp-figures-trail">
              {entryTrail(row)}
            </p>
          )}
        </SheetHeader>

        {query.isLoading ? (
          <div className="space-y-3" data-testid="mp-figures-loading">
            <Skeleton className="h-16 w-full rounded-xl" />
            <Skeleton className="h-40 w-full rounded-xl" />
            <Skeleton className="h-24 w-full rounded-xl" />
          </div>
        ) : query.isError || !detail ? (
          <EmptyNote
            icon={AlertTriangle}
            title="These figures could not be loaded"
            hint={query.isError ? errorText(query.error) : "Generate this employee first."}
            testId="mp-figures-error"
          />
        ) : (
          <Figures detail={detail} kind={kind} />
        )}
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t bg-white px-5 py-3 sm:px-6">
        <Button
          variant="outline"
          className="gap-1.5"
          onClick={() => onAttendance(row)}
          data-testid="mp-figures-attendance"
        >
          <CalendarDays size={14} /> Attendance
        </Button>
        {again && (
          <Button
            className="gap-1.5 border-0 text-white"
            style={{ background: ACCENT }}
            onClick={() => onGenerate(row)}
            disabled={busy}
            title="Works the pay out again from the attendance and salary as they stand now"
            data-testid="mp-figures-generate"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
            Generate again
          </Button>
        )}
      </div>
    </>
  );
}

function Figures({ detail, kind }: { detail: MissedEntryDetail; kind: MissedKind }) {
  const entry = detail.entry;
  const fields = STATEMENT_FIELDS[kind].filter((f) => detail.statement[f.key] !== undefined);
  const remarks = detail.statement.remarks;
  return (
    <div className="space-y-4" data-testid="mp-figures-body">
      <div className="grid grid-cols-3 gap-2">
        {[
          { label: "Gross", value: entry.gross, tone: "bg-slate-50 text-slate-900" },
          { label: "Deductions", value: entry.deductions, tone: "bg-red-50 text-red-900" },
          { label: "Net", value: entry.net, tone: "bg-emerald-50 text-emerald-900" },
        ].map((t) => (
          <div key={t.label} className={cn("rounded-xl px-3 py-2.5", t.tone)}>
            <p className="text-[11px] font-medium opacity-70">{t.label}</p>
            <p className="text-lg font-black tabular-nums" data-testid={`mp-figures-total-${t.label.toLowerCase()}`}>
              {inr(t.value, 2)}
            </p>
          </div>
        ))}
      </div>

      {(detail.periodStart || entry.payRanges.length > 0) && (
        <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-700">
          {entry.payRanges.length > 0 ? (
            <>
              Pays {entry.payRanges.map(([a, b]) => `${dateShort(a)} - ${dateShort(b)}`).join(", ")} ({entry.payDays}{" "}
              day{entry.payDays === 1 ? "" : "s"}).
            </>
          ) : (
            <>
              Period {dateShort(detail.periodStart)} - {dateShort(detail.periodEnd)}.
            </>
          )}
        </p>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <MoneyList title="Earnings" lines={detail.earnings} testId="mp-figures-earnings" />
        <MoneyList title="Deductions" lines={detail.deductions} testId="mp-figures-deductions" />
      </div>

      {fields.length > 0 && (
        <section className="rounded-xl border p-3" aria-label="Salary statement row" data-testid="mp-figures-statement">
          <h3 className="text-xs font-bold uppercase tracking-wide text-gray-500">On the salary statement</h3>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-3">
            {fields.map((f) => {
              const raw = detail.statement[f.key];
              const n = asNumber(raw);
              return (
                <div key={f.key} className="flex items-baseline justify-between gap-2 border-b border-dashed pb-1">
                  <dt className="text-gray-500">{f.label}</dt>
                  <dd className={cn("tabular-nums text-gray-900", f.key === "net" && "font-bold")}>
                    {n === null ? String(raw ?? "—") : f.money ? inr(n, 2) : n}
                  </dd>
                </div>
              );
            })}
          </dl>
          {typeof remarks === "string" && remarks && (
            <p className="mt-2 text-xs text-gray-600">
              <span className="font-semibold">Remarks:</span> {remarks}
            </p>
          )}
        </section>
      )}

      {detail.days.length > 0 && <DaysList days={detail.days} />}

      {typeof detail.notes === "string" && detail.notes.trim() && (
        <p className="whitespace-pre-line rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900">{detail.notes}</p>
      )}
    </div>
  );
}

function MoneyList({ title, lines, testId }: { title: string; lines: MoneyLine[]; testId: string }) {
  return (
    <section className="rounded-xl border p-3" aria-label={title} data-testid={testId}>
      <h3 className="text-xs font-bold uppercase tracking-wide text-gray-500">{title}</h3>
      {lines.length === 0 ? (
        <p className="mt-2 text-xs text-gray-500">None.</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {lines.map((line, i) => (
            <li
              key={`${line.key}-${i}`}
              className={cn(
                "text-xs",
                line.kind === "subtotal" && "border-t pt-1.5 font-bold text-gray-900",
                line.kind === "info" && "text-gray-500",
              )}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span>{line.label}</span>
                <span className="shrink-0 tabular-nums">{inr(line.amount, 2)}</span>
              </div>
              {line.note && line.kind !== "subtotal" && (
                <p className="text-[11px] leading-snug text-gray-400">{line.note}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const dayIn = (d: MissedEntryDay) => (d.firstIn ?? d.firstPunch ?? null) as string | null;
const dayOut = (d: MissedEntryDay) => (d.lastOut ?? d.lastPunch ?? null) as string | null;
const dayShifts = (d: MissedEntryDay) => asNumber(d.shiftsCompleted ?? d.shiftsEarned);

function DaysList({ days }: { days: MissedEntryDay[] }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded-xl border" data-testid="mp-figures-days">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-3 py-2.5 text-left text-xs font-bold uppercase tracking-wide text-gray-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        The days counted ({days.length})
        <ChevronDown size={14} className={cn("transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="max-h-80 overflow-auto border-t">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-gray-50 text-left text-[11px] uppercase text-gray-500">
              <tr>
                <th scope="col" className="px-3 py-1.5">
                  Day
                </th>
                <th scope="col" className="px-3 py-1.5">
                  Status
                </th>
                <th scope="col" className="px-3 py-1.5">
                  In - out
                </th>
                <th scope="col" className="px-3 py-1.5 text-right">
                  Shifts
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {days.map((d) => (
                <tr key={d.date}>
                  <td className="whitespace-nowrap px-3 py-1.5">
                    {d.day ? `${d.day} ` : ""}
                    {dateShort(d.date)}
                  </td>
                  <td className="px-3 py-1.5 capitalize">
                    {String(d.status ?? "").replace(/_/g, " ") || "—"}
                    {d.isLate ? <span className="ml-1 text-amber-700">· late</span> : null}
                    {d.leaveType ? <span className="ml-1 text-sky-700">· {String(d.leaveType)}</span> : null}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 tabular-nums">
                    {dayIn(d) || dayOut(d) ? `${dayIn(d) ?? "?"} - ${dayOut(d) ?? "?"}` : "—"}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{dayShifts(d) ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

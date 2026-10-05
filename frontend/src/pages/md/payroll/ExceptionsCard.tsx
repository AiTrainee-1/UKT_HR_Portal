import { CheckCircle2 } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import SectionCard from "@/components/md/kit/SectionCard";
import { NoteBanner } from "@/components/md/kit/states";
import { Button } from "@/components/ui/button";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { inr, num } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import { CardError, Pill, cardNotes, failed } from "./parts";
import type { PayrollQueries } from "./queries";
import type { ExceptionSeverity } from "./types";

const SEVERITY: Record<ExceptionSeverity, string> = {
  critical: "bg-red-100 text-red-800",
  warning: "bg-amber-100 text-amber-800",
  info: "bg-blue-100 text-blue-800",
};

const HEAD = "text-[11px] font-bold uppercase tracking-wider text-[#006496]/60";

/**
 * The rows an MD should look at: zero or negative pay, duplicate slips, pay for zero days, no slip, pay far above the
 * department's median, big swings on last month. The counts are always the whole month; the list is capped and grows
 * by ten with "Show more". Every finding says why it was flagged, and the thresholds are in "How is this calculated?".
 */
export default function ExceptionsCard({
  query,
  label,
  kind,
  onKind,
  onMore,
}: {
  query: PayrollQueries["exceptions"];
  label: string;
  /** "" = every kind. */
  kind: string;
  onKind: (kind: string) => void;
  onMore: () => void;
}) {
  const data = query.data;
  const kinds = (data?.kinds ?? []).filter((k) => k.count > 0);
  const rows = data?.rows ?? [];
  const matching = data?.matching ?? rows.length;
  return (
    <SectionCard
      testId="md-payroll-exceptions"
      title="Payroll exceptions"
      subtitle={
        data?.hasData
          ? `${num(data.total)} finding${data.total === 1 ? "" : "s"} for ${num(data.people ?? 0)} people in ${label}`
          : `Checks on the slips of ${label}`
      }
      loading={query.isPending}
      provenance={data?.provenance}
      provenanceIds={["exceptions", "provisional"]}
      actions={<AskAiButton question={`Explain the payroll exceptions in ${label} and who is involved.`} />}
    >
      {failed(query) ? (
        <CardError query={query} />
      ) : !data ? null : data.total === 0 ? (
        <p
          className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground"
          data-testid="md-payroll-exceptions-none"
        >
          <CheckCircle2 size={16} className="text-green-600" />
          {data.hasData ? "No exceptions found in this month's payroll." : "There is no payroll to check yet."}
        </p>
      ) : (
        <div className="space-y-3">
          {/* seven kinds do not fit a phone: the tabs scroll sideways instead of pushing the page wider */}
          <div className="overflow-x-auto pb-1" data-testid="md-payroll-exceptions-kinds">
            <PillTabs
              size="sm"
              value={kind || "all"}
              onChange={(v) => onKind(v === "all" ? "" : v)}
              items={[
                { value: "all", label: "All", count: data.total },
                ...kinds.map((k) => ({ value: k.id, label: k.label, count: k.count })),
              ]}
            />
          </div>
          <Table data-testid="md-payroll-exceptions-table">
            <TableHeader>
              <TableRow>
                <TableHead className={HEAD}>Employee</TableHead>
                <TableHead className={HEAD}>Department</TableHead>
                <TableHead className={HEAD}>Finding</TableHead>
                <TableHead className={cn(HEAD, "min-w-[16rem]")}>Why</TableHead>
                <TableHead className={cn(HEAD, "text-right")}>Gross pay</TableHead>
                <TableHead className={cn(HEAD, "text-right")}>Net pay</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow key={`${r.employeeId}-${r.kind}-${i}`} data-testid={`md-payroll-exception-${r.kind}`}>
                  <TableCell className="py-2.5 text-sm">
                    <span className="font-semibold text-[#1a3a4a]">{r.name}</span>
                    <span className="ml-1.5 text-[11px] text-[#006496]/55">{r.code ?? ""}</span>
                  </TableCell>
                  <TableCell className="py-2.5 text-sm">
                    {r.department}
                    <span className="ml-1 text-[11px] text-[#006496]/55">{r.type}</span>
                  </TableCell>
                  <TableCell className="py-2.5">
                    <Pill className={SEVERITY[r.severity]}>{r.kindLabel}</Pill>
                  </TableCell>
                  <TableCell className="py-2.5 text-xs text-gray-600">{r.detail}</TableCell>
                  <TableCell className="py-2.5 text-right text-sm tabular-nums">
                    {r.grossPay != null ? inr(r.grossPay) : "—"}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "py-2.5 text-right text-sm tabular-nums",
                      r.netPay != null && r.netPay < 0 && "font-bold text-red-600",
                    )}
                  >
                    {r.netPay != null ? inr(r.netPay) : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="flex items-center justify-between border-t px-1 pt-2 text-xs text-muted-foreground">
            <span data-testid="md-payroll-exceptions-count">
              Showing {rows.length} of {matching}
            </span>
            {matching > rows.length && (
              <Button variant="ghost" size="sm" onClick={onMore} data-testid="md-payroll-exceptions-more">
                Show more
              </Button>
            )}
          </div>
          {cardNotes(data.notes).map((n) => (
            <NoteBanner key={n}>{n}</NoteBanner>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

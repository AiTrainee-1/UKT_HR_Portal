import { CheckCircle2, CircleAlert, Info, TriangleAlert } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import SectionCard from "@/components/md/kit/SectionCard";
import { NoteBanner } from "@/components/md/kit/states";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { inr, num } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import { CardError, Pill, SegTabs, cardNotes, failed } from "./parts";
import type { PayrollQueries } from "./queries";
import type { ExceptionSeverity } from "./types";

// crimson = a real problem, ochre = look at it, periwinkle = for information; the icon says the same, so colour is not alone
const SEVERITY: Record<ExceptionSeverity, { chip: string; icon: typeof Info }> = {
  critical: { chip: "md-chip-danger", icon: CircleAlert },
  warning: { chip: "md-chip-warning", icon: TriangleAlert },
  info: { chip: "md-money-pill-info", icon: Info },
};

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
          className="flex items-center justify-center gap-2 py-6 text-sm font-medium text-md-ink-soft"
          data-testid="md-payroll-exceptions-none"
        >
          <CheckCircle2 size={16} className="text-md-success" aria-hidden />
          {data.hasData ? "No exceptions found in this month's payroll." : "There is no payroll to check yet."}
        </p>
      ) : (
        <div className="space-y-4">
          {/* seven kinds do not fit a phone: the switch scrolls sideways instead of pushing the page wider */}
          <div data-testid="md-payroll-exceptions-kinds">
            <SegTabs
              label="Kind of exception"
              value={kind || "all"}
              onChange={(v) => onKind(v === "all" ? "" : v)}
              items={[
                { value: "all", label: "All", count: data.total },
                ...kinds.map((k) => ({ value: k.id, label: k.label, count: k.count })),
              ]}
            />
          </div>
          <div className="md-panel overflow-hidden">
            <Table className="md-money-table" data-testid="md-payroll-exceptions-table">
              <TableHeader>
                <TableRow>
                  <TableHead>Employee</TableHead>
                  <TableHead>Department</TableHead>
                  <TableHead>Finding</TableHead>
                  <TableHead className="min-w-[16rem]">Why</TableHead>
                  <TableHead className="text-right">Gross pay</TableHead>
                  <TableHead className="text-right">Net pay</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r, i) => {
                  const severity = SEVERITY[r.severity];
                  const SeverityIcon = severity.icon;
                  return (
                    <TableRow key={`${r.employeeId}-${r.kind}-${i}`} data-testid={`md-payroll-exception-${r.kind}`}>
                      <TableCell className="text-sm">
                        <span className="font-bold text-md-ink">{r.name}</span>
                        <span className="ml-1.5 text-[11.5px] font-medium text-md-ink-soft">{r.code ?? ""}</span>
                      </TableCell>
                      <TableCell className="text-sm text-md-ink">
                        {r.department}
                        <span className="ml-1 text-[11.5px] font-medium text-md-ink-soft">{r.type}</span>
                      </TableCell>
                      <TableCell>
                        <Pill className={severity.chip}>
                          <SeverityIcon size={12} aria-hidden />
                          {r.kindLabel}
                        </Pill>
                      </TableCell>
                      <TableCell className="text-[12.5px] leading-snug text-md-ink-soft">{r.detail}</TableCell>
                      <TableCell className="text-right text-sm text-md-ink">
                        {r.grossPay != null ? inr(r.grossPay) : "—"}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-right text-sm text-md-ink",
                          r.netPay != null && r.netPay < 0 && "font-black text-md-danger",
                        )}
                      >
                        {r.netPay != null ? inr(r.netPay) : "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <div className="flex items-center justify-between gap-3 px-1 text-xs font-medium text-md-ink-soft">
            <span data-testid="md-payroll-exceptions-count">
              Showing {rows.length} of {matching}
            </span>
            {matching > rows.length && (
              <Button
                variant="outline"
                size="sm"
                className="rounded-full"
                onClick={onMore}
                data-testid="md-payroll-exceptions-more"
              >
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

import type { ReactNode } from "react";
import { Link } from "wouter";
import { AlertTriangle, CheckCircle2, ExternalLink, History, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useFactoryHistory, type FactoryEmployee } from "@/lib/api-client/custom-hooks";
import { Chip } from "../account-management/parts";
import { CATEGORY_LABEL, actionLabel, categoryOf, frequencyText, longDay, payText, shiftText, whenText } from "./logic";
import { CategoryChip, GREEN_CHIP, GREY_CHIP, LabelChip, LoadError } from "./parts";

function Fact({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="min-w-0 rounded-xl bg-gray-50 px-3 py-2" data-testid={testId}>
      <p className="text-[11px] font-medium text-gray-500">{label}</p>
      <div className="truncate text-sm font-semibold text-gray-900">{children}</div>
    </div>
  );
}

/** One factory employee: who they are, their label, shift, pay and payroll readiness, and everything changed about them. */
export function ProfileSheet({
  row,
  canEdit,
  canPayroll,
  onEdit,
  onClose,
}: {
  row: FactoryEmployee | null;
  /** May open the edit sheet (personal details or payroll). */
  canEdit: boolean;
  /** May change the payroll (the salary quick fix). */
  canPayroll: boolean;
  onEdit: (row: FactoryEmployee, focus?: "salary") => void;
  onClose: () => void;
}) {
  const history = useFactoryHistory(row?.id ?? null);
  const items = history.data?.items ?? [];
  return (
    <Sheet open={row !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg" data-testid="fe-profile-sheet">
        {row && (
          <>
            <SheetHeader className="text-left">
              <SheetTitle className="pr-6">{row.name}</SheetTitle>
              <SheetDescription>
                <span className="font-mono">{row.code}</span>
                {row.phone && <> · {row.phone}</>}
              </SheetDescription>
              <div className="flex flex-wrap items-center gap-1.5">
                <LabelChip name={row.label} color={row.labelColor} />
                <CategoryChip category={categoryOf(row)} />
                <Chip className={row.status === "active" ? GREEN_CHIP : GREY_CHIP}>
                  {row.status === "active" ? "Active" : "Inactive"}
                </Chip>
              </div>
            </SheetHeader>

            <div className="mt-5 space-y-5">
              {row.payrollIssue ? (
                <div
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900"
                  data-testid="fe-profile-issue"
                >
                  <span className="flex items-center gap-2">
                    <AlertTriangle size={15} /> {row.payrollIssue}: payroll skips them until this is fixed.
                  </span>
                  {canPayroll && row.payrollIssue.toLowerCase().includes("salary") && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 bg-white text-xs"
                      onClick={() => onEdit(row, "salary")}
                    >
                      Edit salary
                    </Button>
                  )}
                </div>
              ) : (
                <p className="flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900">
                  <CheckCircle2 size={15} /> Ready for {CATEGORY_LABEL[categoryOf(row)]}.
                </p>
              )}

              <section className="grid grid-cols-2 gap-2">
                <Fact label="Pay" testId="fe-profile-pay">
                  {payText(row)}
                </Fact>
                <Fact label="Shift" testId="fe-profile-shift">
                  {shiftText(row.shift)}
                  {row.shift?.effectiveFrom && (
                    <span className="block text-[11px] font-normal text-gray-500">
                      since {longDay(row.shift.effectiveFrom)}
                    </span>
                  )}
                </Fact>
                <Fact label="Payroll" testId="fe-profile-payroll">
                  {CATEGORY_LABEL[categoryOf(row)]}
                  <span className="block text-[11px] font-normal text-gray-500">
                    {frequencyText(categoryOf(row), row.productionPayCycle)}
                  </span>
                </Fact>
                <Fact label="Label">{row.label || "No label"}</Fact>
                <Fact label="Unit">{row.unit || "None"}</Fact>
                <Fact label="Joined">{row.joinDate ? longDay(row.joinDate) : "Not recorded"}</Fact>
              </section>

              <div className="flex flex-wrap gap-2">
                {canEdit && (
                  <Button size="sm" className="gap-1.5" onClick={() => onEdit(row)} data-testid="fe-profile-edit">
                    <Pencil size={13} /> Edit details
                  </Button>
                )}
                <Button size="sm" variant="outline" className="gap-1.5" asChild>
                  <Link href={`/hr/employees/${row.id}`} data-testid="fe-profile-full">
                    <ExternalLink size={13} /> Full profile
                  </Link>
                </Button>
              </div>

              <section className="space-y-2" data-testid="fe-history">
                <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-gray-500">
                  <History size={13} /> History
                </h3>
                {history.isLoading ? (
                  <div className="space-y-2">
                    <Skeleton className="h-12 rounded-xl" />
                    <Skeleton className="h-12 rounded-xl" />
                  </div>
                ) : history.isError ? (
                  <LoadError what="the history" onRetry={() => void history.refetch()} />
                ) : items.length === 0 ? (
                  <p
                    className="rounded-xl bg-gray-50 px-3 py-4 text-center text-sm text-muted-foreground"
                    data-testid="fe-history-empty"
                  >
                    No changes recorded yet.
                  </p>
                ) : (
                  <ol className="relative space-y-3 border-l border-gray-200 pl-4">
                    {items.map((item, i) => (
                      <li key={`${item.at}-${i}`} className="relative" data-testid="fe-history-item">
                        <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-teal-500" />
                        <p className="text-sm text-gray-900">{item.description || actionLabel(item.action)}</p>
                        <p className="text-[11px] text-gray-500">
                          {actionLabel(item.action)} · {whenText(item.at)}
                          {item.by && <> · by {item.by}</>}
                        </p>
                      </li>
                    ))}
                  </ol>
                )}
                {items.length >= 200 && (
                  <p className="text-xs text-muted-foreground">The latest 200 changes are shown.</p>
                )}
              </section>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

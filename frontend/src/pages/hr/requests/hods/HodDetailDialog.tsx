import { useEffect, type MouseEvent } from "react";
import { BellRing, ExternalLink, Mail, Phone, Smartphone } from "lucide-react";
import { Avatar, Chip } from "@/components/payroll/kit/parts";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { HodCategory, HodPendingItem, HodRow } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { DASH, groupItems, shortDay, waitingText, waitingTone } from "./logic";

/** How the head can be reached by the reminder: phone (WhatsApp), email, the app (push). */
function ReachLine({ row }: { row: HodRow }) {
  const parts = [
    { icon: Phone, on: !!row.phone, label: row.phone ? "WhatsApp number on file" : "No phone number" },
    { icon: Mail, on: !!row.email, label: row.email ? "Email on file" : "No email address" },
    {
      icon: Smartphone,
      on: row.devices > 0,
      label:
        row.devices > 0
          ? `App on ${row.devices} phone${row.devices === 1 ? "" : "s"}`
          : "No phone registered for notifications",
    },
  ];
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="How the reminder can reach this HoD" data-testid="hod-reach">
      {parts.map(({ icon: Icon, on, label }) => (
        <li key={label}>
          <Chip
            tone={on ? "success" : "neutral"}
            icon={Icon}
            className={cn(!on && "line-through decoration-slate-400/60")}
          >
            {label}
          </Chip>
        </li>
      ))}
    </ul>
  );
}

function ItemRow({ item, onOpen }: { item: HodPendingItem; onOpen: (item: HodPendingItem, e: MouseEvent) => void }) {
  return (
    <li
      className="flex flex-col gap-2 rounded-xl border border-slate-100 bg-white px-3 py-2.5 sm:flex-row sm:items-center"
      data-testid={`hod-item-${item.category}-${item.id}`}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-bold text-gray-900">
          {item.employeeName}
          <span className="ml-1.5 text-xs font-medium text-gray-400">
            {item.employeeCode}
            {item.department ? ` · ${item.department}` : ""}
          </span>
        </p>
        <p className="text-xs text-gray-600">
          {item.summary || item.categoryLabel}
          {item.forText ? <span className="text-gray-400"> · for {item.forText}</span> : null}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-[11px] text-gray-400" title="Raised on">
          {shortDay(item.raisedAt) || DASH}
        </span>
        <Chip tone={waitingTone(item.waitingDays)}>waiting {waitingText(item.waitingDays)}</Chip>
        {item.openPath && (
          <a
            href={item.openPath}
            onClick={(e) => onOpen(item, e)}
            className="inline-flex items-center gap-1 rounded-lg border border-blue-200 px-2 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            aria-label={`Open ${item.employeeName}'s ${item.categoryLabel} request in Requests`}
            data-testid={`hod-item-open-${item.category}-${item.id}`}
          >
            <ExternalLink size={12} aria-hidden /> Open
          </a>
        )}
      </div>
    </li>
  );
}

/**
 * The drill-down of one head: who they are and how the reminder reaches them, then exactly which requests are waiting for
 * their approval, by category, oldest first, each with a link that opens it in the Requests section.
 */
export default function HodDetailDialog({
  row,
  categories,
  focusCategory,
  onClose,
  onOpenRequest,
}: {
  row: HodRow | null;
  categories: HodCategory[];
  /** The category the user clicked on the board: scrolled into view when the dialog opens. */
  focusCategory?: string | null;
  onClose: () => void;
  onOpenRequest: (item: HodPendingItem, e: MouseEvent) => void;
}) {
  const groups = row ? groupItems(row.items, categories) : [];
  const notAllowed = row ? categories.filter((c) => row.byCategory[c.key] === null) : [];

  useEffect(() => {
    if (!row || !focusCategory) return;
    const t = window.setTimeout(() => {
      document.getElementById(`hod-group-${focusCategory}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
    }, 60);
    return () => window.clearTimeout(t);
  }, [row, focusCategory]);

  return (
    <Dialog open={!!row} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto" data-testid="hod-detail">
        {row && (
          <>
            <DialogHeader>
              <div className="flex items-start gap-3">
                <Avatar name={row.name} size={42} />
                <div className="min-w-0 text-left">
                  <DialogTitle className="text-lg">{row.name}</DialogTitle>
                  <DialogDescription>
                    {[row.designation, row.departments.join(", "), row.branch].filter(Boolean).join(" · ") ||
                      "Department Head"}
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>

            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={cn(
                    "rounded-full px-2.5 py-1 text-xs font-black",
                    row.pending > 0 ? "bg-amber-500 text-white" : "bg-slate-100 text-slate-600",
                  )}
                  data-testid="hod-detail-total"
                >
                  {row.pending} pending
                </span>
                {row.pending > 0 && row.oldestDays !== null && (
                  <Chip tone={waitingTone(row.oldestDays)}>oldest waiting {waitingText(row.oldestDays)}</Chip>
                )}
              </div>
              <ReachLine row={row} />

              {groups.length === 0 ? (
                <div
                  className="flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-gray-200 px-6 py-10 text-center"
                  data-testid="hod-detail-empty"
                >
                  <BellRing size={26} className="text-gray-300" />
                  <p className="text-sm font-semibold text-gray-700">Nothing is waiting for {row.name}</p>
                  <p className="text-xs text-muted-foreground">No reminder goes to a HoD with nothing pending.</p>
                </div>
              ) : (
                groups.map((group) => (
                  <section
                    key={group.key}
                    id={`hod-group-${group.key}`}
                    className="scroll-mt-4 space-y-1.5"
                    aria-label={group.label}
                  >
                    <h4 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-gray-500">
                      {group.label}
                      <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800">
                        {group.items.length}
                      </span>
                    </h4>
                    <ul className="space-y-1.5">
                      {group.items.map((item) => (
                        <ItemRow key={`${item.category}-${item.id}`} item={item} onOpen={onOpenRequest} />
                      ))}
                    </ul>
                  </section>
                ))
              )}

              {notAllowed.length > 0 && (
                <p className="text-[11px] text-gray-400" data-testid="hod-detail-not-allowed">
                  Does not approve: {notAllowed.map((c) => c.label).join(", ")}.
                </p>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

import { ArrowRight, Award, Flag, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatDate } from "../career/dates";
import { Chip } from "../career/parts";
import { KIND_LABEL, promotionKind, type PromotionRecord, type TimelineEntry } from "./logic";

const place = (designation?: string | null, department?: string | null) =>
  [designation, department].filter(Boolean).join(" · ") || "-";

/** "Supervisor · Stitching -> Manager · Stitching" with the parts that changed in bold. */
export function MoveLine({ p }: { p: PromotionRecord }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
      <span className="text-gray-500">{place(p.previousDesignation, p.previousDepartment)}</span>
      <ArrowRight size={13} className="shrink-0 text-emerald-500" aria-label="became" />
      <span className="font-semibold text-gray-900">{place(p.newDesignation, p.newDepartment)}</span>
    </div>
  );
}

/** One employee's career, newest first, ending with the day they joined. */
export default function Timeline({
  entries,
  onDelete,
}: {
  entries: TimelineEntry[];
  /** Omit to show the timeline without delete buttons (read-only dialogs). */
  onDelete?: (record: PromotionRecord) => void;
}) {
  return (
    <ol className="relative space-y-4 border-l-2 border-emerald-100 pl-5" data-testid="promotion-timeline">
      {entries.map((entry, i) =>
        entry.kind === "promotion" ? (
          <li key={entry.record.id} className="relative" data-testid={`timeline-promotion-${entry.record.id}`}>
            <span className="absolute -left-[1.85rem] top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-white ring-4 ring-white">
              <Award size={11} />
            </span>
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1 space-y-1">
                <p className="flex flex-wrap items-center gap-2 text-xs font-semibold text-gray-500">
                  {formatDate(entry.record.effectiveDate)}
                  <Chip className="border-emerald-200 bg-emerald-50 text-emerald-700">
                    {KIND_LABEL[promotionKind(entry.record)]}
                  </Chip>
                </p>
                <MoveLine p={entry.record} />
                {entry.record.notes && <p className="text-xs text-gray-500">{entry.record.notes}</p>}
                {entry.record.promotedBy && (
                  <p className="text-[11px] text-gray-400">Recorded by {entry.record.promotedBy}</p>
                )}
              </div>
              {onDelete && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0 text-gray-400 hover:text-red-600"
                  onClick={() => onDelete(entry.record)}
                  aria-label={`Delete the ${formatDate(entry.record.effectiveDate)} promotion record`}
                  title="Delete record"
                  data-testid={`timeline-delete-${entry.record.id}`}
                >
                  <Trash2 size={14} />
                </Button>
              )}
            </div>
          </li>
        ) : (
          <li key={`joined-${i}`} className="relative" data-testid="timeline-joined">
            <span className="absolute -left-[1.85rem] top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-gray-300 text-white ring-4 ring-white">
              <Flag size={10} />
            </span>
            <p className="text-xs font-semibold text-gray-500">
              {entry.date ? formatDate(entry.date) : "Joining date not recorded"}
            </p>
            <p className="text-sm text-gray-700">
              Joined as <span className="font-semibold">{place(entry.designation, entry.department)}</span>
            </p>
          </li>
        ),
      )}
    </ol>
  );
}

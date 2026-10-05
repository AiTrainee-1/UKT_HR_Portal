import { cn } from "@/lib/utils";
import { afterKindText, countText, whenText } from "./logic";
import { CATEGORY_ICON, Chip, ROUTINE_ICON, SEVERITY_STYLE, SeverityChip } from "./parts";
import type { FeedItem } from "./types";

/** One line of the activity feed: what happened, how serious, who did it and when (factory time). Sensitive lines carry
 *  their plain-English title and severity; routine ones show the audit trail's own wording. */
export default function FeedRow({ item }: { item: FeedItem }) {
  const Icon = item.category ? CATEGORY_ICON[item.category] : ROUTINE_ICON;
  const after = afterKindText(item.afterHours);
  const times = countText(item.count);
  return (
    <li
      className="flex items-start gap-3 py-3"
      data-testid={`md-activity-row-${item.id}`}
      data-severity={item.severity ?? "routine"}
    >
      <div
        className={cn(
          "mt-0.5 shrink-0 rounded-xl p-2",
          item.severity ? SEVERITY_STYLE[item.severity].tile : "bg-slate-100 text-slate-500",
        )}
      >
        <Icon size={16} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="text-[13px] font-bold text-[#1a3a4a] [overflow-wrap:anywhere]">
            {item.title ?? item.description ?? item.area}
          </p>
          {item.severity && <SeverityChip severity={item.severity} />}
          {times && <Chip className="border-slate-200 bg-slate-50 text-slate-700">{times}</Chip>}
          {after && <Chip className="border-indigo-200 bg-indigo-50 text-indigo-800">{after}</Chip>}
        </div>
        {item.title && item.description && (
          <p className="mt-0.5 text-xs text-[#006496]/70 [overflow-wrap:anywhere]">{item.description}</p>
        )}
        <p className="mt-0.5 text-[11px] text-[#006496]/55">
          <b className="font-semibold text-[#1a3a4a]/80">{item.userName}</b>
          {item.role ? ` · ${item.role}` : ""} · {whenText(item.at)} · {item.area}
        </p>
      </div>
    </li>
  );
}

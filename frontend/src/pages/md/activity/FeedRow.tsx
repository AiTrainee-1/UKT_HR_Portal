import { afterKindText, countText, whenText } from "./logic";
import { CATEGORY_ICON, Chip, ROUTINE_ICON, SeverityChip } from "./parts";
import type { FeedItem } from "./types";

/** One line of the activity feed: what happened, how serious, who did it and when (factory time). Sensitive lines carry
 *  their plain-English title and severity (a tinted icon, a thin bar on the left and the word in a chip); routine ones
 *  show the audit trail's own wording. */
export default function FeedRow({ item }: { item: FeedItem }) {
  const Icon = item.category ? CATEGORY_ICON[item.category] : ROUTINE_ICON;
  const after = afterKindText(item.afterHours);
  const times = countText(item.count);
  return (
    <li
      className="md-people-feed-row"
      data-testid={`md-activity-row-${item.id}`}
      data-severity={item.severity ?? "routine"}
    >
      <span className="md-people-tile" data-tone={item.severity ?? "routine"} aria-hidden="true">
        <Icon size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="text-[13px] font-bold leading-snug text-md-ink [overflow-wrap:anywhere]">
            {item.title ?? item.description ?? item.area}
          </p>
          {item.severity && <SeverityChip severity={item.severity} />}
          {times && <Chip>{times}</Chip>}
          {after && <Chip tone="info">{after}</Chip>}
        </div>
        {item.title && item.description && (
          <p className="mt-0.5 text-xs leading-snug text-md-ink-soft [overflow-wrap:anywhere]">{item.description}</p>
        )}
        <p className="mt-1 text-[11px] leading-snug text-md-ink-soft">
          <b className="font-semibold text-md-ink">{item.userName}</b>
          {item.role ? ` · ${item.role}` : ""} · {whenText(item.at)} · {item.area}
        </p>
      </div>
    </li>
  );
}

import { ErrorBanner, SkeletonBlock } from "@/components/md/kit/states";
import { describeMdError, useMdQuery } from "@/lib/api-client/custom-hooks/md";
import { DetailsSheet, Fact } from "../approvals/parts";
import { afterKindText, countText, whenText } from "./logic";
import { SeverityChip } from "./parts";
import type { ActivityEntry, FeedItem } from "./types";

const ACTION_WORDS: Record<string, string> = {
  create: "Added",
  update: "Changed",
  delete: "Deleted",
  export: "Exported",
  approve: "Approved",
  reject: "Rejected",
  upload: "Uploaded",
  restore: "Restored",
  backup: "Backed up",
  bulk: "Bulk upload",
};

/** One line of the activity in full: when (factory time), who and what kind of account, the area and the action, why it
 *  counts as sensitive, its whole wording, the record and the address it came from. Its old and new values are never
 *  shown (they can hold salaries). */
export default function EntrySheet({ item, onClose }: { item: FeedItem | null; onClose: () => void }) {
  const id = item?.entryId ?? null;
  const q = useMdQuery<ActivityEntry>(`activity/entries/${id ?? 0}`, undefined, { enabled: id != null });
  const e = q.data?.entry;
  const times = item ? countText(item.count) : null;
  return (
    <DetailsSheet
      open={!!item}
      onClose={onClose}
      title={item ? (item.title ?? item.area) : "Activity"}
      subtitle={item ? `${item.userName} · ${whenText(item.at)}` : undefined}
      testId="md-activity-entry-sheet"
    >
      {!item ? null : id == null ? (
        <p className="text-sm text-md-ink-soft">{item.description ?? "No more details were recorded."}</p>
      ) : q.isError ? (
        <ErrorBanner message={describeMdError(q.error)} onRetry={() => q.refetch()} />
      ) : !e ? (
        <SkeletonBlock rows={4} />
      ) : (
        <div className="space-y-4" data-testid="md-activity-entry">
          {e.severity && (
            <div className="flex flex-wrap items-center gap-2">
              <SeverityChip severity={e.severity} />
              <span className="text-xs font-semibold text-md-ink-soft">{e.categoryLabel}</span>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 rounded-2xl border border-white/80 bg-white/55 p-3.5">
            <Fact label="Who">
              {e.userName}
              <span className="block text-xs font-medium text-md-ink-soft">
                {[e.kind, e.role].filter(Boolean).join(" · ")}
              </span>
            </Fact>
            <Fact label="When">
              {whenText(e.at)}
              {afterKindText(e.afterHours) && (
                <span className="block text-xs font-medium text-md-ink-soft">{afterKindText(e.afterHours)}</span>
              )}
            </Fact>
            <Fact label="Area">{e.area}</Fact>
            <Fact label="Action">
              {ACTION_WORDS[item.action ?? e.action] ?? e.action}
              {times && <span className="block text-xs font-medium text-md-ink-soft">{times}</span>}
            </Fact>
            <Fact label="What was recorded" wide>
              <span className="whitespace-pre-line font-medium" data-testid="md-activity-entry-text">
                {e.burst && item.description ? item.description : (e.description ?? "No wording was recorded.")}
              </span>
            </Fact>
            {e.recordId != null && <Fact label="Record number">{e.recordId}</Fact>}
            {e.ipAddress && <Fact label="From address">{e.ipAddress}</Fact>}
          </div>
          <p className="text-[11px] leading-snug text-md-ink-soft">
            The values before and after a change are never shown here: they can hold salaries.
          </p>
        </div>
      )}
    </DetailsSheet>
  );
}

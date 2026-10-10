import { Users } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import DataTable, { type Column } from "@/components/md/kit/DataTable";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock, ErrorBanner } from "@/components/md/kit/states";
import { describeMdError, useMdQuery, type MdQueryParams } from "@/lib/api-client/custom-hooks/md";
import { num, pct } from "@/lib/md/format";
import { ask, changeText, plural, whenText } from "./logic";
import { Chip, PersonCell } from "./parts";
import type { ActivityUsers, UserRow } from "./types";

const COLUMNS: Column<UserRow>[] = [
  {
    key: "person",
    header: "Person",
    cell: (u) => <PersonCell name={u.userName} role={u.role} />,
    sortValue: (u) => u.userName.toLowerCase(),
  },
  {
    key: "actions",
    header: "Actions",
    align: "right",
    cell: (u) => (
      <div className="tabular-nums">
        <p className="font-bold text-md-ink">{num(u.actions)}</p>
        <p className="text-[11px] text-md-ink-soft">{changeText(u.change)}</p>
      </div>
    ),
    sortValue: (u) => u.actions,
  },
  {
    key: "share",
    header: "Share",
    align: "right",
    cell: (u) => (
      <div className="flex items-center justify-end gap-2.5 tabular-nums">
        {/* a hair of a bar beside the figure on wide screens: the share of all actions */}
        <span className="md-people-meter hidden w-14 @6xl:block" aria-hidden="true">
          <span
            className="md-people-meter-fill block bg-md-wine"
            style={{ width: `${Math.max(3, Math.min(100, u.sharePct ?? 0))}%` }}
          />
        </span>
        <span className="text-md-ink">{pct(u.sharePct)}</span>
      </div>
    ),
    sortValue: (u) => u.sharePct,
  },
  {
    key: "sensitive",
    header: "Sensitive",
    align: "right",
    cell: (u) =>
      u.sensitive > 0 ? <Chip tone="warning">{num(u.sensitive)}</Chip> : <span className="text-md-ink-soft">—</span>,
    sortValue: (u) => u.sensitive,
  },
  {
    key: "after",
    header: "After hours",
    align: "right",
    cell: (u) =>
      u.afterHours > 0 ? <Chip tone="info">{num(u.afterHours)}</Chip> : <span className="text-md-ink-soft">—</span>,
    sortValue: (u) => u.afterHours,
  },
  {
    key: "last",
    header: "Last active",
    cell: (u) => <span className="whitespace-nowrap text-xs text-md-ink">{whenText(u.lastActive)}</span>,
    sortValue: (u) => u.lastActive,
  },
];

/** Who is doing the work: a short ranked table. Clicking a person narrows the sensitive-actions list to them. */
export default function UsersCard({
  params,
  label,
  onSelectUser,
  className,
}: {
  params: MdQueryParams;
  label: string;
  onSelectUser: (name: string) => void;
  className?: string;
}) {
  const q = useMdQuery<ActivityUsers>("activity/users", { ...params, limit: 25 });
  const u = q.data;
  return (
    <SectionCard
      title="Who is doing the work"
      subtitle="Actions by person. Select a person to see their sensitive actions below"
      provenance={u?.provenance}
      loading={q.isPending}
      actions={<AskAiButton question={ask.users(label)} />}
      className={className}
      testId="md-activity-users"
    >
      {q.isError ? (
        <ErrorBanner message={describeMdError(q.error)} onRetry={() => q.refetch()} />
      ) : u && u.users.length === 0 ? (
        <EmptyBlock icon={Users} title="Nobody did anything" testId="md-activity-users-empty">
          No actions were recorded in this period.
        </EmptyBlock>
      ) : u ? (
        <>
          <DataTable
            columns={COLUMNS}
            rows={u.users}
            rowKey={(r) => r.userName}
            initialSort={{ key: "actions", dir: "desc" }}
            pageSize={5}
            onRowClick={(r) => onSelectUser(r.userName)}
            testId="md-activity-users-table"
            dense
          />
          {u.others && (
            <p className="mt-2 text-xs text-md-ink-soft">
              And {num(u.others.people)} more {plural(u.others.people, "person", "people")} with {num(u.others.actions)}{" "}
              {plural(u.others.actions, "action")}.
            </p>
          )}
        </>
      ) : null}
    </SectionCard>
  );
}

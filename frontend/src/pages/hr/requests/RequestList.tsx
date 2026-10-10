import type { KeyboardEvent } from "react";
import { Bell, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import type { HubItem, HubKind } from "./logic";
import {
  DecidedCell,
  EmployeeCell,
  RequestActions,
  RequestCell,
  StatusCell,
  SubmittedCell,
  type ActionHandlers,
} from "./parts";

const HEAD = "text-[11px] font-bold uppercase tracking-wider text-[#006496]/60";

/** What the list says when it has nothing to show: "nothing yet" and "nothing matches" are different sentences. */
export function EmptyState({
  filtered,
  tabLabel,
  onClear,
}: {
  filtered: boolean;
  tabLabel: string | null;
  onClear: () => void;
}) {
  return filtered ? (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center" data-testid="requests-no-match">
      <div className="rounded-2xl bg-gray-100 p-4 text-gray-500">
        <Search size={26} />
      </div>
      <div>
        <p className="font-bold text-gray-900">No request matches</p>
        <p className="mt-0.5 text-sm text-muted-foreground">Try fewer words, a wider period, or clear the filters.</p>
      </div>
      <Button variant="outline" onClick={onClear}>
        Clear filters
      </Button>
    </div>
  ) : (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center" data-testid="requests-empty">
      <div className="rounded-2xl bg-blue-50 p-4 text-blue-600">
        <Bell size={26} />
      </div>
      <div>
        <p className="font-bold text-gray-900">{tabLabel ? `No ${tabLabel} requests yet` : "No requests yet"}</p>
        <p className="mt-0.5 max-w-sm text-sm text-muted-foreground">
          Requests employees raise in the app, and the ones HR raises for approval, appear here the moment they are
          sent.
        </p>
      </div>
    </div>
  );
}

export function ListSkeleton() {
  return (
    <div className="space-y-3 p-4" data-testid="requests-loading" aria-busy>
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-9 w-9 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
          </div>
          <Skeleton className="hidden h-6 w-20 md:block" />
        </div>
      ))}
    </div>
  );
}

export function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center" data-testid="requests-error">
      <p className="font-bold text-gray-900">The requests could not be loaded</p>
      <p className="text-sm text-muted-foreground">Check the connection and try again.</p>
      <Button variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

/** The requests of the tab: a table on wide screens, a card each on phones. */
export default function RequestList({
  items,
  kinds,
  now,
  busyKey,
  handlers,
  onOpen,
}: {
  items: HubItem[];
  kinds: Record<string, HubKind>;
  now: Date;
  busyKey: string | null;
  handlers: ActionHandlers;
  onOpen: (item: HubItem) => void;
}) {
  // one layout at a time: a request's test id must be on the page once
  const phone = useIsMobile();
  const open = (item: HubItem) => () => onOpen(item);
  const onKey = (item: HubItem) => (e: KeyboardEvent) => {
    if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
      e.preventDefault();
      onOpen(item);
    }
  };
  return phone ? (
    <div className="divide-y" data-testid="requests-cards">
      {items.map((item) => (
        <Card
          key={item.key}
          tabIndex={0}
          onClick={open(item)}
          onKeyDown={onKey(item)}
          className="cursor-pointer rounded-none border-0 shadow-none"
          data-testid={`request-${item.kind}-${item.id}`}
          data-status={item.status}
        >
          <CardContent className="space-y-3 p-4">
            <div className="flex items-start justify-between gap-2">
              <EmployeeCell item={item} />
              <SubmittedCell item={item} />
            </div>
            <RequestCell item={item} />
            <StatusCell item={item} now={now} />
            {item.decided && (item.decided.by || item.decided.at) && (
              <div className="flex items-center gap-2 text-xs text-gray-500">
                <span className="font-semibold">Decided by</span>
                <DecidedCell item={item} />
              </div>
            )}
            <RequestActions item={item} kind={kinds[item.kind]} busy={busyKey === item.key} handlers={handlers} full />
          </CardContent>
        </Card>
      ))}
    </div>
  ) : (
    <Table data-testid="requests-table">
      <TableHeader>
        <TableRow>
          <TableHead className={HEAD}>Employee</TableHead>
          <TableHead className={HEAD}>Request</TableHead>
          <TableHead className={HEAD}>Submitted</TableHead>
          <TableHead className={HEAD}>Status</TableHead>
          <TableHead className={HEAD}>Decided by</TableHead>
          <TableHead className={cn(HEAD, "text-right")}>Action</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => (
          <TableRow
            key={item.key}
            tabIndex={0}
            onClick={open(item)}
            onKeyDown={onKey(item)}
            className="cursor-pointer align-top"
            data-testid={`request-${item.kind}-${item.id}`}
            data-status={item.status}
          >
            <TableCell className="w-[16%] min-w-[11rem]">
              <EmployeeCell item={item} />
            </TableCell>
            <TableCell className="w-[28%] min-w-[14rem] whitespace-normal">
              <RequestCell item={item} />
            </TableCell>
            <TableCell>
              <SubmittedCell item={item} />
            </TableCell>
            <TableCell className="whitespace-normal">
              <StatusCell item={item} now={now} />
            </TableCell>
            <TableCell>
              <DecidedCell item={item} />
            </TableCell>
            <TableCell className="text-right">
              <div className="flex justify-end">
                <RequestActions item={item} kind={kinds[item.kind]} busy={busyKey === item.key} handlers={handlers} />
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

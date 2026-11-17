import { useEffect, useRef, useState, type ReactNode } from "react";
import { Eye, Loader2, RotateCw, Search, X } from "lucide-react";
import { useUrlParams } from "@/components/payroll/kit/url-state";
import DataPagination from "@/components/ui/DataPagination";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  useMobileMessageControls,
  useMobileMessageLog,
  usePushMobileMessageAgain,
  type MobileMessageRow,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import {
  PAGE_SIZES,
  PUSH_STATUSES,
  STATUS_HELP,
  asDate,
  asPage,
  asRead,
  asSize,
  asStatus,
  canPushAgain,
  errorText,
  formatWhen,
  messageKinds,
  statusLabel,
} from "./logic";
import { LoadError, Notice, PushStatusChip, useLockedWhy } from "./ui";

// The filters of the list live in the address (?status=failed&kind=late_alert&q=asha&from=2026-11-01&page=2), so a shortcut
// from the Overview ("See the failures") opens the list already narrowed, and a reload keeps what was chosen.
type MessageUrl = {
  status: string;
  kind: string;
  read: string;
  q: string;
  from: string;
  to: string;
  page: string;
  size: string;
};
const URL_DEFAULTS: MessageUrl = { status: "", kind: "", read: "", q: "", from: "", to: "", page: "1", size: "20" };

const SELECT = "h-8 rounded-md border border-input bg-card px-2 text-xs text-foreground";

/** A push that went out again (or is going out right now). */
const PUSHED: readonly string[] = ["sent", "delivered", "sending"];

/**
 * "Push again", with what it does in its title. Locked for a role that may only look: the tab's own lock, or `locked` when
 * it is used on another tab (the Overview's failed pushes, locked by the Messages tab's right).
 */
export function PushAgainButton({
  row,
  onPushed,
  locked,
}: {
  row: MobileMessageRow;
  onPushed?: (r: MobileMessageRow) => void;
  locked?: string | null;
}) {
  const { toast } = useToast();
  const tabLock = useLockedWhy();
  const lockedWhy = locked === undefined ? tabLock : locked;
  const again = usePushMobileMessageAgain();
  const busy = again.isPending;
  return (
    <Button
      size="sm"
      variant="outline"
      className="h-7 gap-1 px-2 text-[11px]"
      disabled={busy || lockedWhy !== null}
      title={lockedWhy ?? "Push this notification to the employee's phones again"}
      data-testid={`pn-again-${row.id}`}
      onClick={() =>
        again.mutate(row.id, {
          onSuccess: (r) => {
            toast({
              title: PUSHED.includes(r.pushStatus) ? "Pushed again" : "Not pushed",
              description: `${r.employeeName}: ${r.pushStatusLabel || statusLabel(r.pushStatus)}.`,
            });
            onPushed?.(r);
          },
          onError: (e) =>
            toast({
              title: "Could not push it again",
              description: errorText(e, "Try again."),
              variant: "destructive",
            }),
        })
      }
    >
      {busy ? <Loader2 size={12} className="animate-spin" /> : <RotateCw size={12} />} Push again
    </Button>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-3 py-1.5 text-sm">
      <span className="pt-0.5 text-xs font-semibold text-muted-foreground">{label}</span>
      <div className="min-w-0 break-words">{children}</div>
    </div>
  );
}

/** Everything about one notification: who, what, the exact text, and what happened to its push. */
function MessageDetail({ row, onClose }: { row: MobileMessageRow; onClose: () => void }) {
  const [current, setCurrent] = useState(row);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg" data-testid="pn-message-detail" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {current.kind} <PushStatusChip status={current.pushStatus} label={current.pushStatusLabel} />
          </DialogTitle>
        </DialogHeader>
        <div className="divide-y">
          <Row label="Employee">
            {current.employeeName} <span className="text-muted-foreground">({current.employeeCode})</span>
          </Row>
          <Row label="Push result">
            <span className="text-muted-foreground">{STATUS_HELP[current.pushStatus] ?? current.pushStatusLabel}</span>
          </Row>
          {current.pushError && (
            <Row label="Reason">
              <span className="text-red-700">{current.pushError}</span>
            </Row>
          )}
          <Row label="Saved">{formatWhen(current.createdAt)}</Row>
          <Row label="Pushed">{current.pushedAt ? formatWhen(current.pushedAt) : "Not pushed"}</Row>
          <Row label="In the app">{current.isRead ? "Opened by the employee" : "Not opened yet"}</Row>
        </div>
        <div>
          <p className="mb-1 text-xs font-semibold text-muted-foreground">What the phone shows</p>
          <div className="max-h-64 overflow-auto rounded-lg border border-sky-100 bg-sky-50 p-3 text-xs text-gray-800">
            {current.title && <p className="mb-1 font-semibold">{current.title}</p>}
            <p className="whitespace-pre-wrap">{current.message}</p>
          </div>
        </div>
        {canPushAgain(current) && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              Pushing again sends it to the phones the employee has now. It is not saved a second time.
            </p>
            <PushAgainButton row={current} onPushed={setCurrent} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Messages: every notification saved for an employee and what happened to its push, newest first. Filters for the result,
 * the kind, read or not, a name / code / words, and a date range. A failed, not-pushed or switched-off one can be pushed again.
 */
export default function MessagesTab() {
  const [url, setUrl] = useUrlParams(URL_DEFAULTS);
  const status = asStatus(url.status);
  const read = asRead(url.read);
  const page = asPage(url.page);
  const pageSize = asSize(url.size);
  const dateFrom = asDate(url.from);
  const dateTo = asDate(url.to);
  const [open, setOpen] = useState<MobileMessageRow | null>(null);

  // the search box is typed into freely; the address (and so the list) follows 350 ms after the last key
  const [text, setText] = useState(url.q);
  const latest = useRef(setUrl);
  latest.current = setUrl;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const onSearch = (value: string) => {
    setText(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => latest.current({ q: value.trim(), page: "1" }), 350);
  };

  const kinds = messageKinds(useMobileMessageControls().data?.controls ?? []);
  const { data, isLoading, isError, isFetching, refetch } = useMobileMessageLog({
    status,
    kind: url.kind,
    read,
    search: url.q,
    dateFrom,
    dateTo,
    page,
    pageSize,
  });

  const rows = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const filtered = Boolean(status || url.kind || read || url.q || dateFrom || dateTo);

  const clear = () => {
    setText("");
    clearTimeout(timer.current);
    setUrl({ status: "", kind: "", read: "", q: "", from: "", to: "", page: "1" });
  };

  return (
    <div className="space-y-3" data-testid="pn-messages">
      <div className="flex flex-wrap items-center gap-2" data-testid="pn-message-filters">
        <div className="relative">
          <Search
            size={13}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={text}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Employee, code or words in the message"
            aria-label="Search the messages"
            data-testid="pn-search"
            className="h-8 w-64 pl-8 text-xs"
          />
        </div>
        <select
          aria-label="Push result"
          value={status}
          onChange={(e) => setUrl({ status: e.target.value, page: "1" })}
          className={SELECT}
          data-testid="pn-status-filter"
        >
          <option value="">Any push result</option>
          {PUSH_STATUSES.map((s) => (
            <option key={s} value={s}>
              {statusLabel(s)}
            </option>
          ))}
        </select>
        <select
          aria-label="Kind of message"
          value={url.kind}
          onChange={(e) => setUrl({ kind: e.target.value, page: "1" })}
          className={cn(SELECT, "max-w-[16rem]")}
          data-testid="pn-kind-filter"
        >
          <option value="">Every kind</option>
          <option value="manual">Message from HR</option>
          <option value="older">Older notices</option>
          {kinds.map((k) => (
            <option key={k.key} value={k.key}>
              {k.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Opened or not"
          value={read}
          onChange={(e) => setUrl({ read: e.target.value, page: "1" })}
          className={SELECT}
          data-testid="pn-read-filter"
        >
          <option value="">Opened or not</option>
          <option value="unread">Not opened yet</option>
          <option value="read">Opened</option>
        </select>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Input
            type="date"
            value={dateFrom}
            onChange={(e) => setUrl({ from: e.target.value, page: "1" })}
            aria-label="From date"
            className="h-8 w-36 text-xs"
          />
          to
          <Input
            type="date"
            value={dateTo}
            onChange={(e) => setUrl({ to: e.target.value, page: "1" })}
            aria-label="To date"
            className="h-8 w-36 text-xs"
          />
        </div>
        {filtered && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1 text-xs"
            onClick={clear}
            data-view-safe
            data-testid="pn-clear-filters"
          >
            <X size={12} /> Clear filters
          </Button>
        )}
      </div>

      {isError && !data ? (
        <LoadError what="The messages" onRetry={() => void refetch()} testId="pn-messages-error" />
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card" data-testid="pn-message-table">
          <table className="w-full min-w-[52rem] text-xs">
            <thead className="bg-muted text-muted-foreground">
              <tr className="text-left">
                <th scope="col" className="px-3 py-2 font-semibold">
                  Saved
                </th>
                <th scope="col" className="px-3 py-2 font-semibold">
                  Employee
                </th>
                <th scope="col" className="px-3 py-2 font-semibold">
                  Kind
                </th>
                <th scope="col" className="px-3 py-2 font-semibold">
                  Message
                </th>
                <th scope="col" className="px-3 py-2 font-semibold">
                  Push result
                </th>
                <th scope="col" className="px-3 py-2 font-semibold">
                  In the app
                </th>
                <th scope="col" className="px-3 py-2 font-semibold">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i} className="border-t">
                    <td colSpan={7} className="px-3 py-2">
                      <Skeleton className="h-5 w-full" />
                    </td>
                  </tr>
                ))
              ) : rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-3 py-10 text-center text-muted-foreground"
                    data-testid="pn-messages-empty"
                  >
                    {filtered ? "No message matches these filters." : "No notification has been saved yet."}
                  </td>
                </tr>
              ) : (
                rows.map((m) => (
                  <tr
                    key={m.id}
                    className="border-t align-top"
                    data-testid={`pn-row-${m.id}`}
                    data-status={m.pushStatus || "none"}
                  >
                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{formatWhen(m.createdAt)}</td>
                    <td className="px-3 py-2">
                      <p className="font-semibold">{m.employeeName}</p>
                      <p className="text-[10px] text-muted-foreground">({m.employeeCode})</p>
                    </td>
                    <td className="px-3 py-2">{m.kind}</td>
                    <td className="max-w-[22rem] px-3 py-2">
                      {m.title && <p className="font-semibold">{m.title}</p>}
                      <p className="line-clamp-2 whitespace-pre-line text-muted-foreground">{m.message}</p>
                      {m.pushError && <p className="mt-0.5 text-[11px] text-red-700">Reason: {m.pushError}</p>}
                    </td>
                    <td className="px-3 py-2">
                      <PushStatusChip status={m.pushStatus} label={m.pushStatusLabel} />
                    </td>
                    <td
                      className={cn(
                        "whitespace-nowrap px-3 py-2",
                        m.isRead ? "text-muted-foreground" : "font-semibold text-sky-700",
                      )}
                    >
                      {m.isRead ? "Opened" : "Not opened"}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap justify-end gap-1.5">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 gap-1 px-2 text-[11px]"
                          onClick={() => setOpen(m)}
                          data-view-safe
                          data-testid={`pn-details-${m.id}`}
                        >
                          <Eye size={12} /> Details
                        </Button>
                        {canPushAgain(m) && <PushAgainButton row={m} />}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      <DataPagination
        page={page}
        totalPages={totalPages}
        onPageChange={(p) => setUrl({ page: String(p) })}
        pageSize={pageSize}
        pageSizes={PAGE_SIZES}
        onPageSizeChange={(s) => setUrl({ size: String(s), page: "1" })}
        totalItems={data?.total}
      />
      {isFetching && !isLoading && <p className="text-[10px] text-muted-foreground">Refreshing…</p>}
      <Notice tone="neutral">
        <b>Push again</b> is offered for a notification that failed, found no phone, or was switched off. It is sent
        only while its switches are on and the employee has a phone registered now.
      </Notice>

      {open && <MessageDetail row={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

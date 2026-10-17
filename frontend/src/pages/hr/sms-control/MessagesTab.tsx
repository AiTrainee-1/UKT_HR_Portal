import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { useUrlParams } from "@/components/payroll/kit/url-state";
import DataPagination from "@/components/ui/DataPagination";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { useSmsMessages, type SmsMessageStatus, type SmsPurpose } from "@/lib/api-client/custom-hooks";
import { PURPOSES, PURPOSE_LABEL, STATUS_LABEL, STATUS_HELP, formatWhen, purposeLabel } from "./logic";
import { Notice, StatusPill } from "./ui";

// The filters of the list live in the address (?status=failed&purpose=login&q=asha&from=2026-10-01&page=2), so a link from the
// Overview ("See the failures") opens the list already narrowed, and a reload keeps what was chosen.
type MessageUrl = { status: string; purpose: string; q: string; from: string; to: string; page: string; size: string };
const URL_DEFAULTS: MessageUrl = { status: "", purpose: "", q: "", from: "", to: "", page: "1", size: "25" };

const STATUSES: readonly SmsMessageStatus[] = ["sent", "failed", "blocked"];
const SIZES = [10, 25, 50, 100];

const asStatus = (v: string): SmsMessageStatus | "" => STATUSES.find((s) => s === v) ?? "";
const asPurpose = (v: string): SmsPurpose | "" => PURPOSES.find((p) => p === v) ?? "";
const asPage = (v: string): number => Math.max(1, Number.parseInt(v, 10) || 1);
const asSize = (v: string): number => {
  const n = Number.parseInt(v, 10);
  return SIZES.includes(n) ? n : 25;
};

/**
 * Messages: every SMS the system tried to send (and every one it held back), newest first. Filters for the outcome, the
 * purpose, a name / code / number, and a date range. The log never holds a code or a full phone number: only the last four
 * digits of the number are shown.
 */
export default function MessagesTab() {
  const [url, setUrl] = useUrlParams(URL_DEFAULTS);
  const status = asStatus(url.status);
  const purpose = asPurpose(url.purpose);
  const page = asPage(url.page);
  const pageSize = asSize(url.size);

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

  const { data, isLoading, isError, isFetching, refetch } = useSmsMessages({
    status,
    purpose,
    search: url.q,
    dateFrom: url.from,
    dateTo: url.to,
    page,
    pageSize,
  });

  const rows = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const counts = data?.statusCounts;
  const filtered = Boolean(status || purpose || url.q || url.from || url.to);

  const clear = () => {
    setText("");
    clearTimeout(timer.current);
    setUrl({ status: "", purpose: "", q: "", from: "", to: "", page: "1" });
  };

  const pills = [
    { value: "all", label: "All", count: counts ? counts.sent + counts.failed + counts.blocked : undefined },
    ...STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s], count: counts?.[s] })),
  ];

  return (
    <div className="space-y-3" data-testid="sms-messages">
      <div className="flex flex-wrap items-center gap-3" data-testid="sms-message-filters">
        <div className="max-w-full overflow-x-auto" data-testid="sms-status-filter">
          <PillTabs
            size="sm"
            items={pills}
            value={status || "all"}
            onChange={(v) => setUrl({ status: v === "all" ? "" : v, page: "1" })}
          />
        </div>
        <select
          value={purpose}
          onChange={(e) => setUrl({ purpose: e.target.value, page: "1" })}
          aria-label="Purpose"
          data-testid="sms-purpose-filter"
          className="h-8 rounded-md border border-input bg-card px-2 text-xs text-foreground"
        >
          <option value="">All purposes</option>
          {PURPOSES.map((p) => (
            <option key={p} value={p}>
              {PURPOSE_LABEL[p]}
            </option>
          ))}
        </select>
        <div className="relative">
          <Search
            size={13}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={text}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search name, code or last digits"
            aria-label="Search messages"
            data-testid="sms-search"
            className="h-8 w-52 pl-8 text-xs"
          />
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Input
            type="date"
            value={url.from}
            onChange={(e) => setUrl({ from: e.target.value, page: "1" })}
            aria-label="From date"
            data-testid="sms-date-from"
            className="h-8 w-36 text-xs"
          />
          to
          <Input
            type="date"
            value={url.to}
            onChange={(e) => setUrl({ to: e.target.value, page: "1" })}
            aria-label="To date"
            data-testid="sms-date-to"
            className="h-8 w-36 text-xs"
          />
        </div>
        {filtered && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1 text-xs"
            onClick={clear}
            data-testid="sms-clear-filters"
          >
            <X size={12} /> Clear
          </Button>
        )}
      </div>

      {isError && !data ? (
        <Notice tone="bad" role="alert" testId="sms-messages-error">
          <div className="flex flex-wrap items-center gap-3">
            <span>The messages could not be loaded. Check the connection and try again.</span>
            <Button size="sm" variant="outline" onClick={() => void refetch()}>
              Try again
            </Button>
          </div>
        </Notice>
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card" data-testid="sms-message-table">
          <table className="w-full min-w-[44rem] text-xs">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr className="text-left">
                <th scope="col" className="px-3 py-2 font-semibold">
                  When
                </th>
                <th scope="col" className="px-3 py-2 font-semibold">
                  Employee
                </th>
                <th scope="col" className="px-3 py-2 font-semibold">
                  Mobile
                </th>
                <th scope="col" className="px-3 py-2 font-semibold">
                  Purpose
                </th>
                <th scope="col" className="px-3 py-2 font-semibold">
                  Status
                </th>
                <th scope="col" className="px-3 py-2 font-semibold">
                  What happened
                </th>
                <th scope="col" className="px-3 py-2 font-semibold">
                  Asked from
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
                    data-testid="sms-messages-empty"
                  >
                    {filtered
                      ? "No messages match these filters."
                      : "No SMS has been sent yet. They appear here when an employee asks for a code by SMS, or when you send a test."}
                  </td>
                </tr>
              ) : (
                rows.map((m) => (
                  <tr key={m.id} className="border-t align-top" data-testid="sms-message-row" data-status={m.status}>
                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{formatWhen(m.at)}</td>
                    <td className="px-3 py-2">
                      {m.employeeName ? (
                        <>
                          <p className="font-semibold">{m.employeeName}</p>
                          {m.employeeCode && <p className="text-[10px] text-muted-foreground">{m.employeeCode}</p>}
                        </>
                      ) : (
                        <span className="text-muted-foreground">No employee</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{m.maskedPhone || "—"}</td>
                    <td className="px-3 py-2">{purposeLabel(m.purpose)}</td>
                    <td className="px-3 py-2">
                      <StatusPill status={m.status} />
                    </td>
                    <td className="max-w-[20rem] px-3 py-2">
                      {m.error ? (
                        <p
                          className={
                            m.status === "blocked"
                              ? "text-amber-700 dark:text-amber-400"
                              : "text-red-700 dark:text-red-400"
                          }
                        >
                          {m.error}
                        </p>
                      ) : (
                        <p className="text-muted-foreground">{STATUS_HELP[m.status]}</p>
                      )}
                      {m.providerMessageId && (
                        <p className="mt-0.5 break-all text-[10px] text-muted-foreground">
                          2Factor ID <code>{m.providerMessageId}</code>
                        </p>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{m.ip || "—"}</td>
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
        onPageSizeChange={(s) => setUrl({ size: String(s), page: "1" })}
        totalItems={data?.total}
      />
      {isFetching && !isLoading && <p className="text-[10px] text-muted-foreground">Refreshing…</p>}
      <p className="text-xs text-muted-foreground">
        The code itself is never saved or shown here, and a mobile number is shown with all but its last four digits
        hidden.
      </p>
    </div>
  );
}

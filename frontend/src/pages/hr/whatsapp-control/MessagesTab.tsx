import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Skeleton } from "@/components/ui/skeleton";
import DataPagination from "@/components/ui/DataPagination";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Search, X } from "lucide-react";
import {
  useWhatsAppMessages,
  useWhatsAppOverview,
  type WhatsAppCategory,
  type WhatsAppMessage,
  type WhatsAppMessageStatus,
} from "@/lib/api-client/custom-hooks";
import {
  CATEGORIES,
  MessageDetailDialog,
  categoryLabel,
  STATUS_LABEL,
  StatusPill,
  fmtDateTime,
  useDebounced,
} from "./shared";

export type MessageFilterPreset = {
  status?: WhatsAppMessageStatus | "";
  category?: WhatsAppCategory | "";
};

const STATUS_TABS = [
  { value: "all", label: "All" },
  ...(["pending", "sent", "delivered", "read", "failed"] as WhatsAppMessageStatus[]).map((s) => ({
    value: s,
    label: STATUS_LABEL[s],
  })),
];

/** The history table with its filters. Used on the Messages tab, and (locked to one
 *  employee, filters hidden) inside the Employees tab's detail dialog. */
export function MessageList({
  preset,
  employeeId,
  compact = false,
}: {
  preset?: MessageFilterPreset;
  employeeId?: number;
  compact?: boolean;
}) {
  const [status, setStatus] = useState<WhatsAppMessageStatus | "">(preset?.status ?? "");
  const [category, setCategory] = useState<WhatsAppCategory | "">(preset?.category ?? "");
  const [related, setRelated] = useState("");
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(compact ? 10 : 25);
  const [selected, setSelected] = useState<WhatsAppMessage | null>(null);
  const debouncedSearch = useDebounced(search);

  // A shortcut from another tab ("View all failures", a category card) re-seeds the filters.
  useEffect(() => {
    setStatus(preset?.status ?? "");
    setCategory(preset?.category ?? "");
    setPage(1);
  }, [preset?.status, preset?.category]);

  // The modules and workflows HR can filter by come from the server's catalog.
  const overview = useWhatsAppOverview(30).data;
  const modules = overview?.categories ?? CATEGORIES.map((key) => ({ key, label: categoryLabel(key) }));
  const workflows = overview?.relatedModules ?? [];

  const { data, isLoading, isFetching } = useWhatsAppMessages({
    status,
    category,
    related,
    employeeId,
    search: debouncedSearch,
    dateFrom,
    dateTo,
    page,
    pageSize,
  });
  const rows = data?.items ?? [];
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / pageSize));
  const reset =
    <T,>(setter: (v: T) => void) =>
    (v: T) => {
      setter(v);
      setPage(1);
    };
  const filtered = Boolean(status || category || related || debouncedSearch || dateFrom || dateTo);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <PillTabs
          size="sm"
          className="flex-wrap h-auto"
          items={STATUS_TABS}
          value={status || "all"}
          onChange={(v) => reset(setStatus)(v === "all" ? "" : (v as WhatsAppMessageStatus))}
        />
        {!compact && (
          <>
            <Select
              value={category || "all"}
              onValueChange={(v) => reset(setCategory)(v === "all" ? "" : (v as WhatsAppCategory))}
            >
              <SelectTrigger className="h-8 w-44 text-xs" aria-label="Module">
                <SelectValue placeholder="All modules" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All modules</SelectItem>
                {modules.map((c) => (
                  <SelectItem key={c.key} value={c.key}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={related || "all"} onValueChange={(v) => reset(setRelated)(v === "all" ? "" : v)}>
              <SelectTrigger className="h-8 w-44 text-xs" aria-label="Workflow">
                <SelectValue placeholder="All workflows" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All workflows</SelectItem>
                {workflows.map((w) => (
                  <SelectItem key={w.key} value={w.key}>
                    {w.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <Input
                value={search}
                onChange={(e) => reset(setSearch)(e.target.value)}
                placeholder="Search name, code or phone"
                className="h-8 w-56 pl-8 text-xs"
                aria-label="Search messages"
              />
            </div>
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <Input
                type="date"
                value={dateFrom}
                onChange={(e) => reset(setDateFrom)(e.target.value)}
                className="h-8 w-36 text-xs"
                aria-label="From date"
              />
              to
              <Input
                type="date"
                value={dateTo}
                onChange={(e) => reset(setDateTo)(e.target.value)}
                className="h-8 w-36 text-xs"
                aria-label="To date"
              />
            </div>
            {filtered && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-xs gap-1"
                onClick={() => {
                  setStatus("");
                  setCategory("");
                  setRelated("");
                  setSearch("");
                  setDateFrom("");
                  setDateTo("");
                  setPage(1);
                }}
              >
                <X size={12} /> Clear
              </Button>
            )}
          </>
        )}
      </div>

      <div className="rounded-xl border bg-white overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-gray-500">
            <tr className="text-left">
              <th className="px-3 py-2 font-semibold">When</th>
              {!employeeId && <th className="px-3 py-2 font-semibold">Employee</th>}
              <th className="px-3 py-2 font-semibold">Mobile</th>
              <th className="px-3 py-2 font-semibold">Message type</th>
              <th className="px-3 py-2 font-semibold">Module</th>
              <th className="px-3 py-2 font-semibold">Status</th>
              <th className="px-3 py-2 font-semibold">Message / failure reason</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <tr key={i} className="border-t">
                  <td colSpan={8} className="px-3 py-2">
                    <Skeleton className="h-5 w-full" />
                  </td>
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-10 text-center text-gray-400">
                  {filtered ? "No messages match these filters." : "No WhatsApp messages have been sent yet."}
                </td>
              </tr>
            ) : (
              rows.map((m) => (
                <tr
                  key={m.id}
                  className="border-t hover:bg-slate-50 cursor-pointer"
                  onClick={() => setSelected(m)}
                  data-testid="whatsapp-message-row"
                >
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">{fmtDateTime(m.createdAt)}</td>
                  {!employeeId && (
                    <td className="px-3 py-2">
                      <p className="font-semibold text-gray-800">{m.employeeName}</p>
                      <p className="text-[10px] text-gray-400">{m.employeeCode}</p>
                    </td>
                  )}
                  <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{m.phone ? `+${m.phone}` : "—"}</td>
                  <td className="px-3 py-2">
                    <span className="font-medium text-gray-700">{m.typeLabel}</span>
                    {m.automatic && (
                      <Badge variant="outline" className="ml-1.5 text-[9px] px-1 py-0">
                        Auto
                      </Badge>
                    )}
                  </td>
                  <td className="px-3 py-2 text-gray-500 whitespace-nowrap" data-testid="whatsapp-message-module">
                    {m.relatedLabel}
                  </td>
                  <td className="px-3 py-2">
                    <StatusPill status={m.status} />
                  </td>
                  <td className="px-3 py-2 max-w-[300px] text-gray-500">
                    <p className="truncate">{m.messageText.split("\n")[0]}</p>
                    {m.error && <p className="truncate text-red-700">{m.error}</p>}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <DataPagination
        page={page}
        totalPages={totalPages}
        onPageChange={setPage}
        pageSize={pageSize}
        onPageSizeChange={(s) => {
          setPageSize(s);
          setPage(1);
        }}
        totalItems={data?.total}
      />
      {isFetching && !isLoading && <p className="text-[10px] text-gray-400">Refreshing…</p>}

      <MessageDetailDialog message={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

export default function MessagesTab({ preset }: { preset?: MessageFilterPreset }) {
  return <MessageList preset={preset} />;
}

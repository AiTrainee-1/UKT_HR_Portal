import { useEffect, useState, type ReactNode } from "react";
import { Check, CheckCheck, Search, X, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import DataPagination from "@/components/ui/DataPagination";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useWhatsAppMessages,
  whatsAppErrorMessage,
  type WhatsAppCategory,
  type WhatsAppMessage,
  type WhatsAppMessageStatus,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { deliveryTicks, pricingLabel } from "./logic";
import {
  CATEGORIES,
  KIND_HELP,
  KindTag,
  STATUS_HELP,
  STATUS_LABEL,
  STATUS_ORDER,
  StatusPill,
  WORKFLOWS,
  categoryLabel,
  fmtDateTime,
  reasonLabel,
  reasonTone,
  useDebounced,
} from "./shared";

export type MessageFilterPreset = {
  status?: WhatsAppMessageStatus | "";
  category?: WhatsAppCategory | "";
};

const STATUS_TABS = [
  { value: "all", label: "All" },
  ...STATUS_ORDER.map((s) => ({ value: s, label: STATUS_LABEL[s] })),
];

/** WhatsApp's own ticks: one grey (sent), two grey (delivered), two blue (read), a red cross (failed). */
export function DeliveryTicks({ status }: { status: string }) {
  const t = deliveryTicks(status);
  const label = STATUS_LABEL[status as WhatsAppMessageStatus] ?? status;
  if (t === "none") return null;
  return (
    <span className="inline-flex items-center" title={label} aria-label={label} data-testid="wa-ticks" data-ticks={t}>
      {t === "sent" && <Check size={14} className="text-slate-400" />}
      {t === "delivered" && <CheckCheck size={14} className="text-slate-400" />}
      {t === "read" && <CheckCheck size={14} className="text-sky-500" />}
      {t === "failed" && <XCircle size={13} className="text-red-500" />}
    </span>
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

/** Everything about one message: who, which template, what Meta charged it as, when it was sent, delivered and read. */
export function MessageDetailDialog({ message, onClose }: { message: WhatsAppMessage | null; onClose: () => void }) {
  if (!message) return null;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg" data-testid="wa-message-detail" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {message.typeLabel} <StatusPill status={message.status} />
          </DialogTitle>
        </DialogHeader>
        <div className="divide-y">
          <Row label="Employee">
            {message.employeeName} <span className="text-muted-foreground">({message.employeeCode})</span>
          </Row>
          <Row label="Module">{message.relatedLabel || message.categoryLabel}</Row>
          <Row label="Status">
            <span className="text-muted-foreground">
              {STATUS_HELP[message.status as WhatsAppMessageStatus] ?? message.status}
            </span>
          </Row>
          <Row label="Sent to">{message.phone ? `+${message.phone}` : "—"}</Row>
          {message.templateName && (
            <Row label="Template">
              <code className="font-mono text-xs">{message.templateName}</code>
            </Row>
          )}
          {(message.pricingCategory || message.billable !== null) && (
            <Row label="Charged as">
              {pricingLabel(message.pricingCategory)}
              {message.billable === true && <span className="text-muted-foreground"> · billable</span>}
              {message.billable === false && <span className="text-muted-foreground"> · free</span>}
            </Row>
          )}
          <Row label="Created">{fmtDateTime(message.createdAt)}</Row>
          {message.sentAt && <Row label="Sent">{fmtDateTime(message.sentAt)}</Row>}
          {message.deliveredAt && <Row label="Delivered">{fmtDateTime(message.deliveredAt)}</Row>}
          {message.readAt && <Row label="Read">{fmtDateTime(message.readAt)}</Row>}
          {message.expiresAt && ["queued", "sending", "expired"].includes(message.status) && (
            <Row label={message.status === "expired" ? "Expired at" : "Expires"}>{fmtDateTime(message.expiresAt)}</Row>
          )}
          <Row label="Trigger">
            {message.automatic ? (
              <Badge variant="outline" className="text-[10px]">
                Automatic
              </Badge>
            ) : (
              <span>Sent by {message.sentBy ?? "HR"}</span>
            )}
            {message.kind && (
              <span className="ml-2 text-xs text-muted-foreground">
                {KIND_HELP[message.kind as keyof typeof KIND_HELP] ?? message.kind}
              </span>
            )}
          </Row>
          {typeof message.attempts === "number" && message.attempts > 0 && (
            <Row label="Attempts">{message.attempts}</Row>
          )}
          {message.error && (
            <Row label={reasonLabel(message.status)}>
              <span className={reasonTone(message.status)}>{message.error}</span>
            </Row>
          )}
          {message.providerMessageId && (
            <Row label="Meta message id">
              <code className="break-all text-xs">{message.providerMessageId}</code>
            </Row>
          )}
        </div>
        <div>
          <p className="mb-1 text-xs font-semibold text-muted-foreground">Message</p>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-emerald-100 bg-emerald-50 p-3 font-sans text-xs text-gray-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-50">
            {message.messageText || "The text of this message wasn't recorded."}
          </pre>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The history table with its filters. Used on the Messages tab, and (locked to one employee, filters hidden) inside the
 *  Employees tab's detail dialog. */
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

  // A shortcut from another tab re-seeds the filters.
  useEffect(() => {
    setStatus(preset?.status ?? "");
    setCategory(preset?.category ?? "");
    setPage(1);
  }, [preset?.status, preset?.category]);

  const { data, isLoading, isFetching, isError, error } = useWhatsAppMessages({
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
    <div className="space-y-3" data-testid="wa-message-list">
      <div className="max-w-full overflow-x-auto" data-view-safe="">
        <PillTabs
          size="sm"
          className="h-auto flex-wrap"
          items={STATUS_TABS}
          value={status || "all"}
          onChange={(v) => reset(setStatus)(v === "all" ? "" : (v as WhatsAppMessageStatus))}
        />
      </div>
      {!compact && (
        <div className="flex flex-wrap items-center gap-2">
          <Select value={category || "all"} onValueChange={(v) => reset(setCategory)(v === "all" ? "" : v)}>
            <SelectTrigger className="h-8 w-44 text-xs" aria-label="Module">
              <SelectValue placeholder="All modules" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All modules</SelectItem>
              {CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {categoryLabel(c)}
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
              {WORKFLOWS.map((w) => (
                <SelectItem key={w.key} value={w.key}>
                  {w.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="relative w-full sm:w-56">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => reset(setSearch)(e.target.value)}
              placeholder="Search name, code or phone"
              className="h-8 pl-8 text-xs"
              aria-label="Search messages"
            />
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
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
              className="h-8 gap-1 text-xs"
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
              <X size={12} /> Clear filters
            </Button>
          )}
        </div>
      )}
      {status && (
        <p className="-mt-1 text-[11px] text-muted-foreground" data-testid="whatsapp-status-help">
          <b className="text-foreground">{STATUS_LABEL[status]}:</b> {STATUS_HELP[status]}
          {status === "skipped" && " The rule that held it back is shown with each message."}
        </p>
      )}

      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full min-w-[760px] text-xs">
          <thead className="bg-muted text-muted-foreground">
            <tr className="text-left">
              <th className="px-3 py-2 font-semibold">When</th>
              {!employeeId && <th className="px-3 py-2 font-semibold">Employee</th>}
              <th className="px-3 py-2 font-semibold">Message type</th>
              <th className="px-3 py-2 font-semibold">Template</th>
              <th className="px-3 py-2 font-semibold">Charged as</th>
              <th className="px-3 py-2 font-semibold">Status</th>
              <th className="px-3 py-2 font-semibold">Message / reason</th>
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
            ) : isError ? (
              <tr>
                <td
                  colSpan={7}
                  role="alert"
                  className="px-3 py-10 text-center font-medium text-red-700 dark:text-red-300"
                  data-testid="wa-messages-error"
                >
                  The messages could not be loaded: {whatsAppErrorMessage(error, "Try Refresh in a moment.")}
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-10 text-center text-muted-foreground">
                  {filtered ? "No messages match these filters." : "No WhatsApp messages have been sent yet."}
                </td>
              </tr>
            ) : (
              rows.map((m) => (
                <tr
                  key={m.id}
                  className="cursor-pointer border-t hover:bg-muted"
                  onClick={() => setSelected(m)}
                  data-testid="whatsapp-message-row"
                >
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{fmtDateTime(m.createdAt)}</td>
                  {!employeeId && (
                    <td className="px-3 py-2">
                      <p className="font-semibold">{m.employeeName}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {m.employeeCode}
                        {m.phone ? ` · +${m.phone}` : ""}
                      </p>
                    </td>
                  )}
                  <td className="px-3 py-2">
                    <span className="font-medium">{m.typeLabel}</span>
                    {m.kind ? <KindTag kind={m.kind} /> : null}
                    <p className="text-[10px] text-muted-foreground" data-testid="whatsapp-message-module">
                      {m.relatedLabel || m.categoryLabel}
                    </p>
                  </td>
                  <td className="px-3 py-2">
                    {m.templateName ? (
                      <code className="font-mono text-[11px]" data-testid="whatsapp-message-template">
                        {m.templateName}
                      </code>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td
                    className="whitespace-nowrap px-3 py-2 text-muted-foreground"
                    data-testid="whatsapp-message-pricing"
                  >
                    {pricingLabel(m.pricingCategory)}
                    {m.billable === true && (
                      <span className="ml-1 rounded bg-amber-100 px-1 text-[9px] font-bold text-amber-800 dark:bg-amber-900 dark:text-amber-100">
                        ₹
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span className="inline-flex items-center gap-1.5">
                      <StatusPill status={m.status} />
                      <DeliveryTicks status={m.status} />
                    </span>
                  </td>
                  <td className="max-w-[280px] px-3 py-2 text-muted-foreground">
                    <p className="truncate">{m.messageText.split("\n")[0]}</p>
                    {m.error && (
                      <p className={cn("truncate", reasonTone(m.status))} title={m.error}>
                        {m.error}
                      </p>
                    )}
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
      {isFetching && !isLoading && <p className="text-[10px] text-muted-foreground">Refreshing…</p>}

      <MessageDetailDialog message={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

export default function MessagesTab({ preset }: { preset?: MessageFilterPreset }) {
  return <MessageList preset={preset} />;
}

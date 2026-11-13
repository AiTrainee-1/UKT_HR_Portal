import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  AlertTriangle,
  BellRing,
  CheckCircle2,
  Info,
  Loader2,
  MailCheck,
  Search,
  Send,
  Smartphone,
  SmartphoneNfc,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useDebounced } from "@/hooks/use-debounced";
import { useToast } from "@/hooks/use-toast";
import {
  useMobileDevices,
  useMobileMessageControls,
  useMobileMessageLog,
  useMobileMessagesOverview,
  useSendMobileMessage,
  useUpdateMobileMessageControls,
  type MobileDeviceRow,
  type MobileMessageControl,
  type MobileMessageFilters,
  type PushCounts,
  type PushStatus,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { isRouteViewOnly, useAuth } from "@/contexts/AuthContext";
import { moduleForPath } from "@/lib/permission-modules";
import { pickVisible, useLevel, useViewOnlyLock, ViewOnlyTabNote, visibleItems } from "@/lib/tab-access";

type Section = "overview" | "controls" | "log" | "devices" | "send";

// Each section has its own permission key (Account Management -> Mobile App Login -> Mobile Messages); with no setting of
// its own it follows the Mobile Messages tab.
const MESSAGES_MODULE = "mobile_app_login.messages";
const SECTION_MODULE: Record<Section, string> = {
  overview: "mobile_app_login.messages.overview",
  controls: "mobile_app_login.messages.controls",
  log: "mobile_app_login.messages.log",
  devices: "mobile_app_login.messages.devices",
  send: "mobile_app_login.messages.send",
};

const STATUS_STYLE: Record<PushStatus | "", { label: string; cls: string }> = {
  sent: { label: "Sent (waiting for confirmation)", cls: "border-blue-200 bg-blue-50 text-blue-700" },
  delivered: { label: "Delivered to the phone", cls: "border-green-200 bg-green-50 text-green-700" },
  no_device: { label: "No phone registered", cls: "border-amber-200 bg-amber-50 text-amber-800" },
  failed: { label: "Push failed", cls: "border-red-200 bg-red-50 text-red-700" },
  off: { label: "Switched off for phones", cls: "border-slate-200 bg-slate-100 text-slate-600" },
  "": { label: "Not pushed (older notice)", cls: "border-slate-200 bg-slate-50 text-slate-500" },
};

const when = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
    : "-";

function Stat({ label, value, sub, tone }: { label: string; value: string | number; sub?: string; tone: string }) {
  return (
    <div className={cn("rounded-2xl p-4", tone)}>
      <p className="text-xs font-medium opacity-70">{label}</p>
      <p className="text-2xl font-black">{value}</p>
      {sub && <p className="mt-0.5 text-xs opacity-60">{sub}</p>}
    </div>
  );
}

function CountsLine({ label, c }: { label: string; c: PushCounts }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b py-2.5 last:border-b-0">
      <span className="w-24 text-sm font-semibold text-gray-800">{label}</span>
      <span className="text-sm font-black tabular-nums">{c.total}</span>
      <span className="text-xs text-green-700">{c.sent} sent to phones</span>
      <span className="text-xs text-amber-700">{c.noDevice} no phone</span>
      <span className="text-xs text-slate-500">{c.off} switched off</span>
      <span className={cn("text-xs", c.failed ? "font-semibold text-red-700" : "text-slate-400")}>
        {c.failed} failed
      </span>
    </div>
  );
}

function Overview({ onGo, canGo }: { onGo: (s: Section) => void; canGo: (s: Section) => boolean }) {
  const { data, isLoading, isError, refetch } = useMobileMessagesOverview();
  if (isLoading) return <Skeleton className="h-80 rounded-2xl" />;
  if (isError || !data)
    return (
      <Card className="border-0 shadow-sm">
        <CardContent className="flex items-center justify-between gap-3 p-4 text-sm text-red-700">
          The overview could not be loaded.
          <Button size="sm" variant="outline" onClick={() => void refetch()}>
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  const peak = Math.max(1, ...data.byDay.map((d) => d.total));
  return (
    <div className="space-y-4" data-testid="mm-overview">
      {!data.pushEnabled && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            Phone notifications are switched <b>OFF</b>: nothing is pushed to phones (the Notifications page of the apps
            still records everything).{" "}
            {canGo("controls") && (
              <button type="button" className="font-semibold underline" onClick={() => onGo("controls")}>
                Switch them on
              </button>
            )}
          </span>
        </div>
      )}
      {data.devices.employees > 0 && data.devices.withDevice === 0 && (
        <div
          className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"
          data-testid="mm-no-phones"
        >
          <Info size={14} className="mt-0.5 shrink-0" />
          <span>
            <b>No phone has registered for notifications yet</b>, so nothing can reach a notification bar. Notifications
            still appear inside the app. The usual cause is an app build made without Firebase (Google&apos;s push
            service): follow <b>docs/PUSH_NOTIFICATIONS.md</b> in the mobile app folder, install the new app and log in.
          </span>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Phones ready"
          value={`${data.devices.withDevice} / ${data.devices.employees}`}
          sub={`${data.devices.tokens} phone${data.devices.tokens === 1 ? "" : "s"} registered`}
          tone="bg-green-50 text-green-800"
        />
        <Stat
          label="No phone yet"
          value={data.devices.withoutDevice}
          sub="employees who will not get a push"
          tone="bg-amber-50 text-amber-800"
        />
        <Stat
          label="Pushed today"
          value={data.today.sent}
          sub={`of ${data.today.total} notification${data.today.total === 1 ? "" : "s"}`}
          tone="bg-blue-50 text-blue-800"
        />
        <Stat
          label="Opened (30 days)"
          value={data.readRate === null ? "-" : `${data.readRate}%`}
          sub="of notifications read"
          tone="bg-slate-100 text-slate-800"
        />
      </div>

      <Card className="border-0 shadow-sm">
        <CardHeader className="pb-1">
          <CardTitle className="text-sm font-bold">What was sent</CardTitle>
        </CardHeader>
        <CardContent>
          <CountsLine label="Today" c={data.today} />
          <CountsLine label="Last 7 days" c={data.week} />
          <CountsLine label="Last 30 days" c={data.month} />
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="border-0 shadow-sm">
          <CardHeader className="pb-1">
            <CardTitle className="text-sm font-bold">Last 14 days</CardTitle>
            <p className="text-xs text-gray-500">Notifications per day; the dark part reached a phone.</p>
          </CardHeader>
          <CardContent>
            <div className="flex h-28 items-end gap-1" role="img" aria-label="Notifications per day for 14 days">
              {data.byDay.map((d) => (
                <div
                  key={d.date}
                  className="flex h-full flex-1 flex-col justify-end"
                  title={`${d.date}: ${d.total}, ${d.sent} to phones`}
                >
                  <div className="rounded-t bg-blue-100" style={{ height: `${((d.total - d.sent) / peak) * 100}%` }} />
                  <div
                    className={cn("bg-blue-600", d.total === d.sent && "rounded-t")}
                    style={{ height: `${(d.sent / peak) * 100}%` }}
                  />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
        <Card className="border-0 shadow-sm">
          <CardHeader className="pb-1">
            <CardTitle className="text-sm font-bold">By kind of message (30 days)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {data.byKind.length === 0 && <p className="text-sm text-gray-500">Nothing was sent yet.</p>}
            {data.byKind.map((k) => (
              <div key={k.label} className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate text-gray-700">{k.label}</span>
                <span className="font-bold tabular-nums">{k.count}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function ControlRow({
  row,
  disabled,
  onToggle,
}: {
  row: MobileMessageControl;
  disabled: boolean;
  onToggle: (on: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-gray-800">{row.label}</p>
        {row.description && <p className="mt-0.5 text-xs text-gray-500">{row.description}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2 pt-0.5">
        <span className={cn("w-8 text-right text-xs font-bold", row.enabled ? "text-emerald-600" : "text-gray-400")}>
          {row.enabled ? "ON" : "OFF"}
        </span>
        <Switch
          checked={row.enabled}
          disabled={disabled}
          onCheckedChange={onToggle}
          aria-label={`Phone notification: ${row.label}`}
          data-testid={`mm-toggle-${row.key}`}
        />
      </div>
    </div>
  );
}

function Controls() {
  const { toast } = useToast();
  const { data, isLoading, isError, refetch } = useMobileMessageControls();
  const update = useUpdateMobileMessageControls();
  const groups = useMemo(() => {
    const out = new Map<string, { label: string; rows: MobileMessageControl[] }>();
    for (const row of data?.controls ?? []) {
      const g = out.get(row.group) ?? { label: row.groupLabel, rows: [] };
      g.rows.push(row);
      out.set(row.group, g);
    }
    return [...out.entries()];
  }, [data]);
  if (isLoading) return <Skeleton className="h-96 rounded-2xl" />;
  if (isError || !data)
    return (
      <Card className="border-0 shadow-sm">
        <CardContent className="flex items-center justify-between gap-3 p-4 text-sm text-red-700">
          The switches could not be loaded.
          <Button size="sm" variant="outline" onClick={() => void refetch()}>
            Try again
          </Button>
        </CardContent>
      </Card>
    );

  const done = (title: string) => ({
    onSuccess: () => toast({ title }),
    onError: (e: unknown) =>
      toast({ title: "Could not change that", description: (e as Error).message, variant: "destructive" }),
  });
  return (
    <div className="space-y-4" data-testid="mm-controls">
      <div className="flex items-start gap-2 rounded-xl border border-blue-100 bg-blue-50 p-3 text-xs text-blue-800">
        <Info size={14} className="mt-0.5 shrink-0" />
        <span>
          Every message the system sends on WhatsApp is also pushed to the employee's phone and saved in the
          Notifications page of the app. These switches only stop the <b>push to the phone</b>: the record in the app is
          always saved, so nothing is lost. Login, password-reset and activation codes are never sent this way. Changes
          apply at once.
        </span>
      </div>

      <Card className="border-0 shadow-sm">
        <CardContent className="flex items-start justify-between gap-4 p-4">
          <div>
            <p className="text-sm font-bold text-gray-900">Phone notifications</p>
            <p className="mt-0.5 text-xs text-gray-500">
              The master switch. OFF stops every push to every phone (messages HR sends from the Send tab included).
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className={cn("text-xs font-bold", data.pushEnabled ? "text-emerald-600" : "text-gray-400")}>
              {data.pushEnabled ? "ON" : "OFF"}
            </span>
            <Switch
              checked={data.pushEnabled}
              disabled={update.isPending}
              onCheckedChange={(on) =>
                update.mutate({ pushEnabled: on }, done(`Phone notifications ${on ? "ON" : "OFF"}`))
              }
              aria-label="Phone notifications (master switch)"
              data-testid="mm-master"
            />
          </div>
        </CardContent>
      </Card>

      {groups.map(([group, g]) => (
        <Card key={group} className={cn("border-0 shadow-sm", !data.pushEnabled && "opacity-60")}>
          <CardHeader className="pb-1">
            <CardTitle className="text-sm font-bold">{g.label}</CardTitle>
          </CardHeader>
          <CardContent className="divide-y">
            {g.rows.map((row) => (
              <ControlRow
                key={row.key}
                row={row}
                disabled={update.isPending}
                onToggle={(on) =>
                  update.mutate({ types: { [row.key]: on } }, done(`${row.label}: ${on ? "ON" : "OFF"}`))
                }
              />
            ))}
          </CardContent>
        </Card>
      ))}
      {data.updatedBy && (
        <p className="text-[11px] text-gray-400">
          Last changed by {data.updatedBy} on {when(data.updatedAt)}
        </p>
      )}
    </div>
  );
}

function StatusChip({ status }: { status: PushStatus | "" }) {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE[""];
  return (
    <Badge variant="outline" className={cn("whitespace-nowrap text-[10px]", s.cls)}>
      {s.label}
    </Badge>
  );
}

function Pager({
  page,
  total,
  pageSize,
  onPage,
}: {
  page: number;
  total: number;
  pageSize: number;
  onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex items-center justify-between pt-2 text-xs text-gray-500">
      <span>
        {total} in all, page {page} of {pages}
      </span>
      <span className="flex gap-2">
        <Button size="sm" variant="outline" className="h-8" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <Button size="sm" variant="outline" className="h-8" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </Button>
      </span>
    </div>
  );
}

function MessageLog() {
  const [filters, setFilters] = useState<MobileMessageFilters>({ page: 1, pageSize: 20 });
  const [text, setText] = useState("");
  const { data, isLoading, isError, refetch } = useMobileMessageLog(filters);
  const kinds = useMobileMessageControls().data?.controls.filter((c) => c.kind === "message") ?? [];
  const set = (patch: Partial<MobileMessageFilters>) => setFilters((f) => ({ ...f, ...patch, page: patch.page ?? 1 }));
  return (
    <div className="space-y-3" data-testid="mm-log">
      <div className="flex flex-wrap items-center gap-2">
        <form
          className="relative"
          onSubmit={(e) => {
            e.preventDefault();
            set({ search: text.trim() });
          }}
        >
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => set({ search: text.trim() })}
            placeholder="Employee, code or words in the message"
            className="h-9 w-72 pl-8 text-sm"
            aria-label="Search the messages"
          />
        </form>
        <select
          aria-label="Push result"
          value={filters.status ?? ""}
          onChange={(e) => set({ status: e.target.value as PushStatus | "" })}
          className="h-9 rounded-md border bg-white px-2 text-sm"
        >
          <option value="">Any push result</option>
          <option value="sent">Sent (waiting for confirmation)</option>
          <option value="delivered">Delivered to the phone</option>
          <option value="no_device">No phone registered</option>
          <option value="failed">Push failed</option>
          <option value="off">Switched off for phones</option>
        </select>
        <select
          aria-label="Kind of message"
          value={filters.kind ?? ""}
          onChange={(e) => set({ kind: e.target.value })}
          className="h-9 max-w-[16rem] rounded-md border bg-white px-2 text-sm"
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
          aria-label="Read or unread"
          value={filters.read ?? ""}
          onChange={(e) => set({ read: e.target.value as "read" | "unread" | "" })}
          className="h-9 rounded-md border bg-white px-2 text-sm"
        >
          <option value="">Read or not</option>
          <option value="unread">Not opened yet</option>
          <option value="read">Opened</option>
        </select>
        <Input
          type="date"
          aria-label="From date"
          value={filters.dateFrom ?? ""}
          onChange={(e) => set({ dateFrom: e.target.value })}
          className="h-9 w-40 text-sm"
        />
        <Input
          type="date"
          aria-label="To date"
          value={filters.dateTo ?? ""}
          onChange={(e) => set({ dateTo: e.target.value })}
          className="h-9 w-40 text-sm"
        />
      </div>

      {isLoading ? (
        <Skeleton className="h-72 rounded-2xl" />
      ) : isError || !data ? (
        <Card className="border-0 shadow-sm">
          <CardContent className="flex items-center justify-between gap-3 p-4 text-sm text-red-700">
            The messages could not be loaded.
            <Button size="sm" variant="outline" onClick={() => void refetch()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : data.items.length === 0 ? (
        <Card className="border-0 shadow-sm">
          <CardContent className="py-12 text-center text-sm text-gray-500">
            No message matches these filters.
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-2">
            {data.items.map((m) => (
              <Card key={m.id} className="border-0 shadow-sm" data-testid={`mm-row-${m.id}`}>
                <CardContent className="space-y-1.5 p-3.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-bold text-gray-900">{m.employeeName}</p>
                    <span className="font-mono text-[11px] text-gray-400">({m.employeeCode})</span>
                    <Badge variant="outline" className="text-[10px]">
                      {m.kind}
                    </Badge>
                    <StatusChip status={m.pushStatus} />
                    <span className={cn("text-[11px]", m.isRead ? "text-gray-400" : "font-semibold text-blue-700")}>
                      {m.isRead ? "Opened" : "Not opened"}
                    </span>
                    <span className="ml-auto text-[11px] text-gray-400">{when(m.createdAt)}</span>
                  </div>
                  {m.title && <p className="text-sm font-semibold text-gray-800">{m.title}</p>}
                  <p className="line-clamp-3 whitespace-pre-line text-xs text-gray-600">{m.message}</p>
                  {m.pushError && <p className="text-[11px] text-red-600">Reason: {m.pushError}</p>}
                </CardContent>
              </Card>
            ))}
          </div>
          <Pager page={data.page} total={data.total} pageSize={data.pageSize} onPage={(page) => set({ page })} />
        </>
      )}
    </div>
  );
}

function Devices() {
  const [params, setParams] = useState<{ search: string; has: "with" | "without" | ""; page: number }>({
    search: "",
    has: "",
    page: 1,
  });
  const [text, setText] = useState("");
  const { data, isLoading } = useMobileDevices({ ...params, pageSize: 20 });
  return (
    <div className="space-y-3" data-testid="mm-devices">
      <div className="flex flex-wrap items-center gap-2">
        <PillTabs
          items={[
            { value: "", label: "All" },
            { value: "with", label: "Has a phone" },
            { value: "without", label: "No phone yet" },
          ]}
          value={params.has}
          onChange={(v) => setParams((p) => ({ ...p, has: v as "with" | "without" | "", page: 1 }))}
          size="sm"
        />
        <form
          className="relative ml-auto"
          onSubmit={(e) => {
            e.preventDefault();
            setParams((p) => ({ ...p, search: text.trim(), page: 1 }));
          }}
        >
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => setParams((p) => ({ ...p, search: text.trim(), page: 1 }))}
            placeholder="Name, code or phone"
            className="h-9 w-56 pl-8 text-sm"
            aria-label="Search employees"
          />
        </form>
      </div>
      <div className="flex items-start gap-2 rounded-lg border bg-slate-50 p-2.5 text-[11px] leading-relaxed text-slate-600">
        <Info size={13} className="mt-0.5 shrink-0" />
        <span>
          An employee gets phone notifications once they have signed in on the mobile app (a new build) and allowed
          notifications. Someone with no phone still gets every notification inside the app and the Employee Web App.
        </span>
      </div>
      {isLoading || !data ? (
        <Skeleton className="h-64 rounded-2xl" />
      ) : (
        <>
          <div className="grid gap-2">
            {data.items.map((e: MobileDeviceRow) => (
              <Card key={e.id} className="border-0 shadow-sm">
                <CardContent className="flex flex-wrap items-center gap-3 p-3">
                  <div className="min-w-[200px] flex-1">
                    <p className="text-sm font-bold text-gray-900">
                      {e.name}{" "}
                      <span className="font-mono text-[11px] font-normal text-gray-400">({e.employeeCode})</span>
                    </p>
                    <p className="text-xs text-gray-500">
                      {e.employmentType === "production" ? "Production" : "Staff"}
                      {e.phone ? ` · ${e.phone}` : ""}
                    </p>
                  </div>
                  {e.devices > 0 ? (
                    <span className="flex items-center gap-1 text-xs font-semibold text-green-700">
                      <SmartphoneNfc size={13} /> {e.devices} phone{e.devices === 1 ? "" : "s"} · registered{" "}
                      {when(e.lastRegisteredAt)}
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-xs font-semibold text-amber-700">
                      <Smartphone size={13} /> No phone yet
                    </span>
                  )}
                </CardContent>
              </Card>
            ))}
            {data.items.length === 0 && (
              <Card className="border-0 shadow-sm">
                <CardContent className="py-10 text-center text-sm text-gray-500">No employee matches.</CardContent>
              </Card>
            )}
          </div>
          <Pager
            page={data.page}
            total={data.total}
            pageSize={data.pageSize}
            onPage={(page) => setParams((p) => ({ ...p, page }))}
          />
        </>
      )}
    </div>
  );
}

function SendMessage() {
  const { toast } = useToast();
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<MobileDeviceRow | null>(null);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  // asked once typing pauses, not once per letter (the last matches stay listed meanwhile)
  const searchText = useDebounced(text.trim());
  const search = useMobileDevices({ search: searchText, page: 1, pageSize: 6 });
  const send = useSendMobileMessage();
  const ready = !!picked && title.trim().length > 0 && message.trim().length > 0;

  const submit = () => {
    if (!picked) return;
    send.mutate(
      { employeeId: picked.id, title: title.trim(), message: message.trim() },
      {
        onSuccess: (row) => {
          toast({
            title: row.pushStatus === "sent" ? "Message sent to the phone" : "Message saved in the app",
            description:
              row.pushStatus === "sent"
                ? `${picked.name} will see it on the lock screen and in the app.`
                : `${row.pushStatusLabel}. ${picked.name} can still read it in the app.`,
          });
          setTitle("");
          setMessage("");
        },
        onError: (e) =>
          toast({ title: "Could not send it", description: (e as Error).message, variant: "destructive" }),
      },
    );
  };
  return (
    <div className="grid gap-4 lg:grid-cols-2" data-testid="mm-send">
      <Card className="border-0 shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-bold">1. Choose the employee</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Name, code or phone"
              className="h-9 pl-8 text-sm"
              aria-label="Find the employee"
            />
          </div>
          <div className="grid gap-1.5">
            {(search.data?.items ?? []).map((e) => (
              <button
                type="button"
                key={e.id}
                onClick={() => setPicked(e)}
                data-testid={`mm-pick-${e.employeeCode}`}
                aria-pressed={picked?.id === e.id}
                className={cn(
                  "flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                  picked?.id === e.id ? "border-blue-400 bg-blue-50" : "bg-white hover:bg-slate-50",
                )}
              >
                <span>
                  <b>{e.name}</b> <span className="font-mono text-[11px] text-gray-400">({e.employeeCode})</span>
                </span>
                <span className={cn("text-[11px] font-semibold", e.devices ? "text-green-700" : "text-amber-700")}>
                  {e.devices ? `${e.devices} phone${e.devices === 1 ? "" : "s"}` : "No phone yet"}
                </span>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>
      <Card className="border-0 shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-bold">2. Write the message</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {picked && (
            <p className="rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-900" data-testid="mm-picked">
              To <b>{picked.name}</b> ({picked.employeeCode})
              {picked.devices === 0 && ". They have no phone registered, so it will only be in the app."}
            </p>
          )}
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={60}
            placeholder="Title (shown first on the phone)"
            aria-label="Title"
            data-testid="mm-title"
          />
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={500}
            rows={4}
            placeholder="The message"
            aria-label="Message"
            data-testid="mm-message"
          />
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] text-gray-400">{message.length} / 500</span>
            <Button
              className="gap-1.5"
              disabled={!ready || send.isPending}
              onClick={submit}
              data-testid="mm-send-button"
            >
              {send.isPending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Send
            </Button>
          </div>
          <p className="text-[11px] text-gray-400">
            It is saved in the employee's Notifications page and pushed to their phone. It is not sent on WhatsApp. Use
            it to try a phone, or for a short note that is not one of the system's messages.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

/** Mobile App Login -> Mobile Messages: the control panel for what is pushed to employees' phones. */
const SECTIONS: { value: Section; label: string; icon: React.ReactNode }[] = [
  { value: "overview", label: "Overview", icon: <BellRing size={12} /> },
  { value: "controls", label: "Controls", icon: <CheckCircle2 size={12} /> },
  { value: "log", label: "Messages", icon: <MailCheck size={12} /> },
  { value: "devices", label: "Phones", icon: <SmartphoneNfc size={12} /> },
  { value: "send", label: "Send a message", icon: <Send size={12} /> },
];

export default function MobileMessagesTab() {
  const { user } = useAuth();
  const [location] = useLocation();
  const level = useLevel();
  const [asked, setSection] = useState<Section>("overview");
  // Only the sections this role may see are offered, and only the one shown is mounted (a hidden one asks for nothing).
  const visible = visibleItems(SECTIONS, (s) => SECTION_MODULE[s.value], level);
  const visibleValues = visible.map((s) => s.value);
  const section = pickVisible(asked, visibleValues);
  // A View-only section of a Mobile Messages tab the role may edit: the note and the lock (the page or the tab being View
  // only already has its own).
  const sectionViewOnly =
    visible.length > 0 &&
    !isRouteViewOnly(user, location, moduleForPath(location)) &&
    level(MESSAGES_MODULE) === "edit" &&
    level(SECTION_MODULE[section]) === "view";
  useViewOnlyLock(sectionViewOnly, section);

  if (visible.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="mobile-messages-nothing-open">
        Nothing on this page is open to your role.
      </p>
    );
  }

  return (
    <div className="space-y-4" data-testid="mobile-messages">
      <PillTabs items={visible} value={section} onChange={(v) => setSection(v as Section)} size="sm" />
      <ViewOnlyTabNote show={sectionViewOnly} />
      {section === "overview" && <Overview onGo={setSection} canGo={(s) => visibleValues.includes(s)} />}
      {section === "controls" && <Controls />}
      {section === "log" && <MessageLog />}
      {section === "devices" && <Devices />}
      {section === "send" && <SendMessage />}
    </div>
  );
}

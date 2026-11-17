import { useEffect, useRef, useState } from "react";
import { BellOff, BellRing, ChevronDown, ChevronUp, Search, Smartphone, SmartphoneNfc, Trash2 } from "lucide-react";
import { useUrlParams } from "@/components/payroll/kit/url-state";
import DataPagination from "@/components/ui/DataPagination";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { useToast } from "@/hooks/use-toast";
import {
  useMobileDevices,
  useMuteMobileEmployee,
  useRemoveMobilePhone,
  type MobileDeviceRow,
  type MobilePhone,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import {
  PAGE_SIZES,
  asEmployeeShow,
  asPage,
  asSize,
  employeeFilter,
  errorText,
  formatWhen,
  platformLabel,
  plural,
  type EmployeeShow,
} from "./logic";
import { InlineConfirm, LoadError, Notice, useLockedWhy } from "./ui";

// What is shown lives in the address (?show=muted&q=asha&page=2), so the Overview's "See who has no phone" opens it narrowed.
type EmployeeUrl = { show: string; q: string; page: string; size: string };
const URL_DEFAULTS: EmployeeUrl = { show: "all", q: "", page: "1", size: "20" };

const SHOWS: { value: EmployeeShow; label: string }[] = [
  { value: "all", label: "All" },
  { value: "with", label: "Has a phone" },
  { value: "without", label: "No phone yet" },
  { value: "muted", label: "Muted" },
];

/** What is being asked about, inside the employee's card. */
type Ask = { kind: "mute"; muted: boolean } | { kind: "remove"; phone: MobilePhone } | null;

function PhoneRow({ phone, locked, onRemove }: { phone: MobilePhone; locked: string | null; onRemove: () => void }) {
  return (
    <li className="flex flex-wrap items-center gap-3 py-2" data-testid={`pn-phone-${phone.id}`}>
      <SmartphoneNfc size={14} className="shrink-0 text-emerald-600" />
      <div className="min-w-0 flex-1 text-xs">
        <p className="font-semibold">{platformLabel(phone.platform)}</p>
        <p className="text-muted-foreground">
          Registered {formatWhen(phone.registeredAt)} · last seen {formatWhen(phone.updatedAt)}
        </p>
      </div>
      <Button
        size="sm"
        variant="outline"
        className="h-7 gap-1 px-2 text-[11px] text-red-700"
        disabled={locked !== null}
        title={locked ?? "Forget this phone: it stops getting notifications until the app is opened on it again"}
        onClick={onRemove}
        data-testid={`pn-remove-${phone.id}`}
      >
        <Trash2 size={12} /> Remove this phone
      </Button>
    </li>
  );
}

function EmployeeCard({ e }: { e: MobileDeviceRow }) {
  const { toast } = useToast();
  const locked = useLockedWhy();
  const mute = useMuteMobileEmployee();
  const remove = useRemoveMobilePhone();
  const [showPhones, setShowPhones] = useState(false);
  const [ask, setAsk] = useState<Ask>(null);
  const phones = e.phones ?? [];
  const muted = !!e.muted;

  const doMute = (next: boolean) =>
    mute.mutate(
      { employeeId: e.id, muted: next },
      {
        onSuccess: () => {
          setAsk(null);
          toast({
            title: next ? `${e.name}: phone notifications muted` : `${e.name}: phone notifications back on`,
            description: next ? "Their in-app Notifications list still fills." : undefined,
          });
        },
        onError: (err) =>
          toast({ title: "Could not change that", description: errorText(err, "Try again."), variant: "destructive" }),
      },
    );

  const doRemove = (phone: MobilePhone) =>
    remove.mutate(phone.id, {
      onSuccess: () => {
        setAsk(null);
        toast({
          title: "Phone removed",
          description: `${e.name} gets no notification on it until the app is opened there again.`,
        });
      },
      onError: (err) =>
        toast({ title: "Could not remove it", description: errorText(err, "Try again."), variant: "destructive" }),
    });

  return (
    <div
      className={cn("rounded-2xl border bg-card p-3 text-card-foreground shadow-sm", muted && "border-orange-200")}
      data-testid={`pn-employee-${e.id}`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-[200px] flex-1">
          <p className="flex flex-wrap items-center gap-2 text-sm font-bold">
            {e.name} <span className="font-mono text-[11px] font-normal text-muted-foreground">({e.employeeCode})</span>
            {muted && <StatusBadge tone="caution">Muted</StatusBadge>}
          </p>
          <p className="text-xs text-muted-foreground">
            {e.employmentType === "production" ? "Production" : "Staff"}
            {e.phone ? ` · ${e.phone}` : ""}
            {muted && e.mutedBy ? ` · muted by ${e.mutedBy} on ${formatWhen(e.mutedAt)}` : ""}
          </p>
        </div>
        {e.devices > 0 ? (
          <span className="flex items-center gap-1 text-xs font-semibold text-emerald-700">
            <SmartphoneNfc size={13} /> {plural(e.devices, "phone")} · registered {formatWhen(e.lastRegisteredAt)}
          </span>
        ) : (
          <span className="flex items-center gap-1 text-xs font-semibold text-amber-700">
            <Smartphone size={13} /> No phone yet
          </span>
        )}
        <div className="flex flex-wrap gap-1.5">
          {e.devices > 0 && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1 px-2 text-[11px]"
              onClick={() => setShowPhones((v) => !v)}
              aria-expanded={showPhones}
              data-view-safe
              data-testid={`pn-phones-${e.id}`}
            >
              {showPhones ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              {showPhones ? "Hide phones" : "Show phones"}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 px-2 text-[11px]"
            disabled={locked !== null || mute.isPending}
            title={locked ?? undefined}
            onClick={() => setAsk({ kind: "mute", muted: !muted })}
            data-testid={`pn-mute-${e.id}`}
          >
            {muted ? <BellRing size={12} /> : <BellOff size={12} />}
            {muted ? "Unmute notifications" : "Mute notifications"}
          </Button>
        </div>
      </div>

      {ask?.kind === "mute" && (
        <InlineConfirm
          testId={`pn-confirm-mute-${e.id}`}
          confirmLabel={ask.muted ? "Mute notifications" : "Unmute notifications"}
          destructive={ask.muted}
          pending={mute.isPending}
          onConfirm={() => doMute(ask.muted)}
          onCancel={() => setAsk(null)}
        >
          {ask.muted ? (
            <>
              Mute <b>{e.name}</b>? No phone notification will reach them, whatever its kind. Their in-app Notifications
              list still fills, and WhatsApp is not affected.
            </>
          ) : (
            <>
              Unmute <b>{e.name}</b>? Their phones get notifications again (the kinds that are switched on).
            </>
          )}
        </InlineConfirm>
      )}

      {showPhones && phones.length > 0 && (
        <ul className="mt-2 divide-y border-t">
          {phones.map((p) => (
            <PhoneRow key={p.id} phone={p} locked={locked} onRemove={() => setAsk({ kind: "remove", phone: p })} />
          ))}
        </ul>
      )}
      {showPhones && phones.length === 0 && (
        <p className="mt-2 border-t pt-2 text-xs text-muted-foreground">
          This server does not list the phones one by one yet.
        </p>
      )}

      {ask?.kind === "remove" && (
        <InlineConfirm
          testId={`pn-confirm-remove-${ask.phone.id}`}
          confirmLabel="Remove this phone"
          destructive
          pending={remove.isPending}
          onConfirm={() => doRemove(ask.phone)}
          onCancel={() => setAsk(null)}
        >
          Remove the {platformLabel(ask.phone.platform).toLowerCase()} of <b>{e.name}</b>? It stops getting
          notifications now. The app registers it again the next time it is opened on that phone, so use this for a
          phone that was lost, sold or handed over.
        </InlineConfirm>
      )}
    </div>
  );
}

/**
 * Employees: who has a phone registered for notifications (and who has none), each employee's phones, removing one, and
 * muting an employee (no phone notification at all; the in-app list still fills).
 */
export default function EmployeesTab() {
  const [url, setUrl] = useUrlParams(URL_DEFAULTS);
  const show = asEmployeeShow(url.show);
  const page = asPage(url.page);
  const pageSize = asSize(url.size);
  const filter = employeeFilter(show);

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

  const { data, isLoading, isError, refetch } = useMobileDevices({
    search: url.q,
    has: filter.has,
    muted: filter.muted,
    page,
    pageSize,
  });
  const rows = data?.items ?? [];
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / pageSize));

  return (
    <div className="space-y-3" data-testid="pn-employees">
      <div className="flex flex-wrap items-center gap-3">
        <div className="max-w-full overflow-x-auto" data-testid="pn-employee-filter" data-view-safe>
          <PillTabs size="sm" items={SHOWS} value={show} onChange={(v) => setUrl({ show: v, page: "1" })} />
        </div>
        <div className="relative ml-auto">
          <Search
            size={13}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={text}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Name, code or phone number"
            aria-label="Search employees"
            data-testid="pn-employee-search"
            className="h-8 w-60 pl-8 text-xs"
          />
        </div>
      </div>
      <Notice tone="neutral">
        An employee gets phone notifications once they have signed in on the mobile app and allowed notifications; each
        phone they sign in on is registered here. Someone with no phone, or muted, still gets every notification inside
        the app and the Employee Web App.
      </Notice>

      {isError && !data ? (
        <LoadError what="The employees" onRetry={() => void refetch()} testId="pn-employees-error" />
      ) : isLoading ? (
        <Skeleton className="h-64 rounded-2xl" />
      ) : rows.length === 0 ? (
        <p
          className="rounded-2xl border bg-card py-10 text-center text-sm text-muted-foreground"
          data-testid="pn-employees-empty"
        >
          {show === "muted" && !url.q ? "No employee is muted." : "No employee matches."}
        </p>
      ) : (
        <div className="grid gap-2">
          {rows.map((e) => (
            <EmployeeCard key={e.id} e={e} />
          ))}
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
    </div>
  );
}

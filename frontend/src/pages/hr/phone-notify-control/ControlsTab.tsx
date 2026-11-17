import { useMemo, useState } from "react";
import { MessageCircle, Power, PowerOff, Workflow } from "lucide-react";
import { useUrlParams } from "@/components/payroll/kit/url-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import {
  useMobileMessageControls,
  useUpdateMobileMessageControls,
  type MobileMessageControl,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import {
  asCategory,
  audienceLabel,
  controlCategories,
  errorText,
  formatNumber,
  formatWhen,
  groupChange,
  groupControls,
  inCategory,
  plural,
  type ControlGroup,
} from "./logic";
import { FilterChips, InlineConfirm, LoadError, Notice, OnOff, Panel, useLockedWhy } from "./ui";

// The category filter lives in the address (?category=chat), so the Overview's "Manage" on a category opens it narrowed.
type ControlsUrl = { category: string };
const URL_DEFAULTS: ControlsUrl = { category: "" };

/** The 30-day line under a switch (a workflow row: the messages of that workflow). */
function StatsLine({ row }: { row: MobileMessageControl }) {
  const s = row.stats;
  if (!s) return null;
  if (s.total === 0) {
    return (
      <p className="mt-1 text-[11px] text-muted-foreground" data-testid={`pn-stats-${row.key}`}>
        Last 30 days: none sent
      </p>
    );
  }
  return (
    <p className="mt-1 text-[11px] text-muted-foreground" data-testid={`pn-stats-${row.key}`}>
      Last 30 days: <b className="text-foreground">{formatNumber(s.total)}</b> saved · {formatNumber(s.sent)} pushed ·{" "}
      {formatNumber(s.delivered)} delivered
      {s.failed > 0 && <span className="font-semibold text-red-700"> · {formatNumber(s.failed)} failed</span>}
      {s.off > 0 && <> · {formatNumber(s.off)} switched off</>}
      {s.noDevice > 0 && <> · {formatNumber(s.noDevice)} no phone</>}
    </p>
  );
}

function ControlRow({
  row,
  disabled,
  locked,
  onToggle,
}: {
  row: MobileMessageControl;
  disabled: boolean;
  locked: string | null;
  onToggle: (on: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3" data-testid={`pn-control-${row.key}`}>
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold">
          {row.label}
          <StatusBadge tone="neutral">{audienceLabel(row.audience)}</StatusBadge>
          {row.origin === "whatsapp" && (
            <span title="The same message also goes by WhatsApp (WhatsApp Control has its own switch)">
              <StatusBadge tone="success">
                <MessageCircle size={10} className="mr-1" />
                Also by WhatsApp
              </StatusBadge>
            </span>
          )}
        </p>
        {row.description && <p className="mt-0.5 text-xs text-muted-foreground">{row.description}</p>}
        {row.sentFrom && (
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Sent from: <span className="font-medium text-foreground">{row.sentFrom}</span>
          </p>
        )}
        <StatsLine row={row} />
      </div>
      <div className="flex shrink-0 items-center gap-2 pt-0.5">
        <OnOff on={row.enabled} />
        <Switch
          checked={row.enabled}
          disabled={disabled || locked !== null}
          title={locked ?? undefined}
          onCheckedChange={onToggle}
          aria-label={`Phone notification: ${row.label}`}
          data-testid={`pn-toggle-${row.key}`}
        />
      </div>
    </div>
  );
}

function GroupPanel({
  group,
  dim,
  busy,
  locked,
  onChange,
}: {
  group: ControlGroup;
  dim: boolean;
  busy: boolean;
  locked: string | null;
  onChange: (types: Record<string, boolean>, title: string) => void;
}) {
  const all = group.rows.length;
  const setAll = (on: boolean) =>
    onChange(groupChange(group.rows, on), `${group.label}: every switch ${on ? "ON" : "OFF"}`);
  return (
    <Panel
      title={group.label}
      icon={group.workflow ? Workflow : undefined}
      testId={`pn-group-${group.key}`}
      className={cn("transition-opacity", dim && "opacity-60")}
      description={
        group.workflow ? (
          <>
            One switch per approval workflow. A decision message (approved, rejected, waiting for you) is pushed only
            while
            <b> both</b> its own kind above <b>and</b> its workflow here are on.
          </>
        ) : (
          `${group.on} of ${all} on`
        )
      }
      actions={
        <div className="flex gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            disabled={busy || locked !== null || group.on === all}
            title={locked ?? undefined}
            onClick={() => setAll(true)}
            data-testid={`pn-group-on-${group.key}`}
          >
            Turn all on
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            disabled={busy || locked !== null || group.on === 0}
            title={locked ?? undefined}
            onClick={() => setAll(false)}
            data-testid={`pn-group-off-${group.key}`}
          >
            Turn all off
          </Button>
        </div>
      }
    >
      <div className="divide-y">
        {group.rows.map((row) => (
          <ControlRow
            key={row.key}
            row={row}
            disabled={busy}
            locked={locked}
            onToggle={(on) => onChange({ [row.key]: on }, `${row.label}: ${on ? "ON" : "OFF"}`)}
          />
        ))}
      </div>
    </Panel>
  );
}

/**
 * Controls: the master switch on top (it asks first, both ways), then every kind of notification grouped as on the server,
 * each with its switch, where it is sent from, who receives it, whether WhatsApp carries it too, and its last 30 days. A group
 * can be turned all on or all off. The switches stop only the push to the phone: the in-app record is always saved. The
 * category chips (?category=) narrow the groups to one category of the Overview's dashboard.
 */
export default function ControlsTab() {
  const { toast } = useToast();
  const locked = useLockedWhy();
  const { data, isLoading, isError, refetch } = useMobileMessageControls();
  const update = useUpdateMobileMessageControls();
  const [askMaster, setAskMaster] = useState<boolean | null>(null);
  const [url, setUrl] = useUrlParams(URL_DEFAULTS);
  const categories = useMemo(() => controlCategories(data?.controls ?? []), [data]);
  const category = asCategory(url.category, categories);
  const groups = useMemo(() => groupControls(inCategory(data?.controls ?? [], category)), [data, category]);
  const picked = categories.find((c) => c.key === category);

  if (isLoading) return <Skeleton className="h-96 rounded-2xl" />;
  if (isError || !data)
    return <LoadError what="The switches" onRetry={() => void refetch()} testId="pn-controls-error" />;

  const change = (
    body: { pushEnabled?: boolean; types?: Record<string, boolean> },
    title: string,
    after?: () => void,
  ) =>
    update.mutate(body, {
      onSuccess: () => {
        after?.();
        toast({ title });
      },
      onError: (e) => {
        after?.();
        toast({ title: "Could not change that", description: errorText(e, "Try again."), variant: "destructive" });
      },
    });

  const on = data.pushEnabled;
  const MasterIcon = on ? Power : PowerOff;
  return (
    <div className="space-y-4" data-testid="pn-controls">
      <div
        data-testid="pn-master"
        data-state={on ? "on" : "off"}
        className={cn(
          "flex items-start justify-between gap-4 rounded-2xl border-2 p-4",
          on ? "border-emerald-200 bg-emerald-50" : "border-red-200 bg-red-50",
        )}
      >
        <div className="flex min-w-0 items-start gap-3">
          <div className={cn("rounded-xl p-2", on ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700")}>
            <MasterIcon size={18} />
          </div>
          <div className="min-w-0">
            <p className="text-base font-black text-gray-900">Phone notifications</p>
            <p className={cn("mt-0.5 text-xs", on ? "text-emerald-900" : "text-red-800")}>
              {on
                ? "ON: every kind switched on below is pushed to the employee's registered phones."
                : "OFF: nothing is pushed to any phone, not even a message HR sends from the Send tab. The app still records everything."}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-1">
          <span className={cn("w-9 text-right text-sm font-black", on ? "text-emerald-600" : "text-red-600")}>
            {on ? "ON" : "OFF"}
          </span>
          <Switch
            checked={on}
            disabled={update.isPending || locked !== null}
            title={locked ?? undefined}
            onCheckedChange={(next) => setAskMaster(next)}
            aria-label="Phone notifications (master switch)"
            data-testid="pn-master-switch"
          />
        </div>
      </div>

      {askMaster !== null && (
        <InlineConfirm
          testId="pn-confirm-master"
          confirmLabel={askMaster ? "Turn phone notifications ON" : "Turn phone notifications OFF"}
          destructive={!askMaster}
          pending={update.isPending}
          onConfirm={() =>
            change({ pushEnabled: askMaster }, `Phone notifications ${askMaster ? "ON" : "OFF"}`, () =>
              setAskMaster(null),
            )
          }
          onCancel={() => setAskMaster(null)}
        >
          {askMaster
            ? "Phones start getting notifications again, for every kind switched on below. Kinds switched off stay off."
            : "No notification will be pushed to any phone: attendance alerts, approvals, documents, visitors, everything. They are still saved in the app, and WhatsApp is not affected."}
        </InlineConfirm>
      )}

      <Notice tone="info">
        A notification is always saved in the employee&apos;s app (their Notifications page). These switches only stop
        the <b>push to the phone</b>, so nothing is lost. A muted employee (Employees tab) gets no push at all. Login,
        password-reset and activation codes are never sent this way. Changes apply at once.
      </Notice>

      {!on && (
        <Notice tone="neutral" testId="pn-master-off-note">
          The master switch is <b>OFF</b>, so none of the switches below push anything until it is turned back on. You
          can still set them now.
        </Notice>
      )}

      {categories.length > 0 && (
        <div className="space-y-2" data-testid="pn-category-filter-row">
          <FilterChips
            label="Category"
            testId="pn-category-filter"
            value={category}
            onChange={(v) => setUrl({ category: v })}
            items={[
              { value: "", label: "All", count: data.controls.length },
              ...categories.map((c) => ({
                value: c.key,
                label: c.label,
                count: c.on === c.total ? c.total : `${c.on}/${c.total}`,
                title: `${c.label}: ${c.on} of ${plural(c.total, "switch", "switches")} on`,
              })),
            ]}
          />
          {picked && (
            <p className="text-xs text-muted-foreground" data-testid="pn-category-showing">
              Showing the {plural(picked.total, "switch", "switches")} of <b className="text-foreground">{picked.label}</b>{" "}
              ({picked.on} on).{" "}
              <button
                type="button"
                className="font-semibold text-sky-700 underline-offset-2 hover:underline dark:text-sky-400"
                onClick={() => setUrl({ category: "" })}
                data-view-safe
              >
                Show every category
              </button>
            </p>
          )}
        </div>
      )}

      {groups.map((g) => (
        <GroupPanel
          key={g.key}
          group={g}
          dim={!on}
          busy={update.isPending}
          locked={locked}
          onChange={(types, title) => change({ types }, title)}
        />
      ))}

      {data.updatedBy && (
        <p className="text-[11px] text-muted-foreground">
          Last changed by {data.updatedBy} on {formatWhen(data.updatedAt)}
        </p>
      )}
    </div>
  );
}

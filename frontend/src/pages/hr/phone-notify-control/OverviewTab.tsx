import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  BellOff,
  BellRing,
  CalendarDays,
  CheckCheck,
  CheckCircle2,
  LayoutGrid,
  ListChecks,
  Power,
  Send,
  Smartphone,
  SmartphoneNfc,
  Users,
  XCircle,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import {
  useMobileMessageControls,
  useMobileMessagesConfig,
  useMobileMessagesOverview,
  useUpdateMobileMessageControls,
  type MobileMessageControl,
  type MobileMessageRow,
  type PushCategory,
  type PushCounts,
  type RecipientsLine,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import {
  CATEGORY_STATE_LABEL,
  HEALTH_LABEL,
  VIEW_ONLY_TEXT,
  audienceNames,
  canPushAgain,
  categoryChange,
  categoryCounts,
  categoryState,
  categoryTarget,
  dayBars,
  deliveredOf,
  errorText,
  formatNumber,
  formatWhen,
  healthNeedsBanner,
  healthTone,
  monthSegments,
  overviewTiles,
  plural,
  recipientsLine,
  type CategoryState,
  type SegmentId,
  type TileId,
} from "./logic";
import { PushAgainButton } from "./MessagesTab";
import { pnPath, type PnTabKey } from "./routes";
import { InlineConfirm, LoadError, Notice, Panel, StatusCard, useLockedWhy } from "./ui";

const TILE_ICON: Record<TileId, typeof BellRing> = {
  master: Power,
  phones: SmartphoneNfc,
  today: Send,
  week: CalendarDays,
  delivered: CheckCheck,
  failed: XCircle,
  off: BellOff,
  nophone: Smartphone,
};

/** Where a tile leads (a pre-filtered tab), when that tab is open to the role. */
const TILE_LINK: Partial<Record<TileId, { tab: PnTabKey; query: string; label: string }>> = {
  master: { tab: "controls", query: "", label: "Open the switches" },
  phones: { tab: "employees", query: "show=with", label: "See who has a phone" },
  today: { tab: "messages", query: "", label: "See the messages" },
  delivered: { tab: "messages", query: "status=delivered", label: "See the delivered ones" },
  failed: { tab: "messages", query: "status=failed", label: "See the failures" },
  off: { tab: "messages", query: "status=off", label: "See the switched-off ones" },
  nophone: { tab: "employees", query: "show=without", label: "See who has no phone" },
};

function TileLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      href={to}
      className="mt-1.5 inline-flex items-center gap-1 text-xs font-semibold text-sky-700 underline-offset-2 hover:underline"
    >
      {children} <ArrowRight size={11} />
    </Link>
  );
}

function CountsLine({ label, c }: { label: string; c: PushCounts }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b py-2.5 last:border-b-0">
      <span className="w-24 text-sm font-semibold">{label}</span>
      <span className="text-sm font-black tabular-nums">{formatNumber(c.total)}</span>
      <span className="text-xs text-sky-700">{formatNumber(c.sent)} pushed</span>
      {c.delivered !== undefined && (
        <span className="text-xs text-emerald-700">{formatNumber(deliveredOf(c))} delivered</span>
      )}
      <span className="text-xs text-amber-700">{formatNumber(c.noDevice)} no phone</span>
      <span className="text-xs text-muted-foreground">{formatNumber(c.off)} switched off</span>
      <span className={cn("text-xs", c.failed ? "font-semibold text-red-700" : "text-muted-foreground")}>
        {formatNumber(c.failed)} failed
      </span>
    </div>
  );
}

function DayChart({ days }: { days: { date: string; total: number; sent: number }[] }) {
  const { bars } = dayBars(days);
  const total = bars.reduce((n, b) => n + b.total, 0);
  const sent = bars.reduce((n, b) => n + b.sent, 0);
  return (
    <Panel
      title="The last 14 days"
      description="Notifications saved each day: the dark part was pushed to a phone, the light part stayed in the app only."
      icon={BarChart3}
      testId="pn-chart"
    >
      {total === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground" data-testid="pn-chart-empty">
          No notification in the last 14 days.
        </p>
      ) : (
        <div role="img" aria-label={`Last 14 days: ${total} notifications, ${sent} pushed to phones`}>
          <div className="flex h-32 items-end gap-1">
            {bars.map((b) => (
              <div
                key={b.date}
                className="flex h-full min-w-0 flex-1 flex-col justify-end"
                title={`${b.label}: ${b.total} saved, ${b.sent} pushed`}
                data-testid={`pn-bar-${b.date}`}
              >
                <div className="rounded-t-sm bg-sky-100" style={{ height: `${b.notPushedPct}%` }} />
                <div
                  className={cn("bg-sky-600", b.notPushed === 0 && "rounded-t-sm")}
                  style={{ height: `${b.sentPct}%`, minHeight: b.sent ? 2 : 0 }}
                />
              </div>
            ))}
          </div>
          <div className="mt-1.5 flex gap-1">
            {bars.map((b, i) => (
              <span key={b.date} className="min-w-0 flex-1 truncate text-center text-[10px] text-muted-foreground">
                {i % 2 === 0 ? b.label : ""}
              </span>
            ))}
          </div>
        </div>
      )}
      {/* the same numbers as a table, for a screen reader */}
      <table className="sr-only">
        <caption>Notifications per day, last 14 days</caption>
        <thead>
          <tr>
            <th>Day</th>
            <th>Saved</th>
            <th>Pushed</th>
          </tr>
        </thead>
        <tbody>
          {bars.map((b) => (
            <tr key={b.date}>
              <td>{b.label}</td>
              <td>{b.total}</td>
              <td>{b.sent}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <i className="inline-block h-2 w-2 rounded-sm bg-sky-600" /> Pushed to a phone
        </span>
        <span className="flex items-center gap-1">
          <i className="inline-block h-2 w-2 rounded-sm bg-sky-100" /> In the app only
        </span>
      </div>
    </Panel>
  );
}

// ── the categories ────────────────────────────────────────────────────────────

/** The stripe down a category card's left edge, and the colour of its state word. */
const STATE_EDGE: Record<CategoryState, string> = {
  on: "border-l-emerald-400",
  partial: "border-l-amber-400",
  off: "border-l-red-400",
  none: "border-l-border",
};

const STATE_WORD: Record<CategoryState, string> = {
  on: "text-emerald-600 dark:text-emerald-400",
  partial: "text-amber-600 dark:text-amber-400",
  off: "text-gray-400",
  none: "text-muted-foreground",
};

const SEGMENT_COLOR: Record<SegmentId, string> = {
  delivered: "bg-emerald-500",
  sent: "bg-sky-500",
  failed: "bg-red-500",
  off: "bg-slate-400",
  noDevice: "bg-amber-400",
  waiting: "bg-slate-200 dark:bg-slate-600",
};

/** One number of a category's 30 days: the number on top, its name under it. */
function MonthStat({ label, value, tone }: { label: string; value: number; tone?: "good" | "bad" | "warn" }) {
  return (
    <div className="flex min-w-0 flex-col-reverse items-center justify-end rounded-lg bg-muted px-1 py-1.5 text-center">
      <dt className="text-[10px] leading-tight text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "text-sm font-bold tabular-nums",
          value > 0 && tone === "good" && "text-emerald-700 dark:text-emerald-400",
          value > 0 && tone === "bad" && "text-red-700 dark:text-red-400",
          value > 0 && tone === "warn" && "text-amber-700 dark:text-amber-400",
        )}
      >
        {formatNumber(value)}
      </dd>
    </div>
  );
}

/** The last 30 days of a category as one bar (what became of each notification) and the five numbers under it. */
function MonthBlock({ cat }: { cat: PushCategory }) {
  const m = cat.month;
  const segments = monthSegments(m);
  return (
    <div className="mt-3" data-testid={`pn-category-month-${cat.key}`}>
      <p className="text-[11px] text-muted-foreground">
        Last 30 days:{" "}
        {m.total === 0 ? (
          "none sent"
        ) : (
          <>
            <b className="text-foreground">{formatNumber(m.total)}</b> saved in the app
          </>
        )}
      </p>
      {/* an empty track when nothing was sent, so every card's numbers sit at the same height */}
      <div
        role="img"
        aria-label={
          segments.length ? segments.map((s) => `${s.label}: ${s.value}`).join(", ") : "Nothing in the last 30 days"
        }
        className="mt-1.5 flex h-2 overflow-hidden rounded-full bg-muted"
      >
        {segments.map((s) => (
          <div
            key={s.id}
            title={`${s.label}: ${formatNumber(s.value)}`}
            className={cn("h-full", SEGMENT_COLOR[s.id])}
            style={{ width: `${s.pct}%` }}
          />
        ))}
      </div>
      <dl className="mt-2 grid grid-cols-5 gap-1">
        <MonthStat label="Pushed" value={m.sent} />
        <MonthStat label="Delivered" value={m.delivered} tone="good" />
        <MonthStat label="Failed" value={m.failed} tone="bad" />
        <MonthStat label="Switched off" value={m.off} />
        <MonthStat label="No phone" value={m.noDevice} tone="warn" />
      </dl>
    </div>
  );
}

/**
 * One category: its name and what it covers, how many of its switches are on, one switch for all of them (a press turns
 * them all on, or all off when every one is on; turning them off asks first, in the card), its last 30 days, who gets it,
 * and a way into the Controls tab narrowed to it.
 */
function CategoryCard({
  cat,
  counts,
  dim,
  busy,
  locked,
  manageHref,
  onSet,
}: {
  cat: PushCategory;
  counts: { on: number; total: number };
  dim: boolean;
  busy: boolean;
  locked: string | null;
  manageHref: string | null;
  onSet: (on: boolean, after?: () => void) => void;
}) {
  const [asking, setAsking] = useState(false);
  const state = categoryState(counts);
  const press = () => {
    if (categoryTarget(state)) onSet(true);
    else setAsking(true);
  };
  const who = audienceNames(cat.audience);
  return (
    <article
      data-testid={`pn-category-${cat.key}`}
      data-state={state}
      className={cn(
        "flex min-w-0 flex-col rounded-2xl border border-l-4 bg-card p-4 text-card-foreground shadow-sm transition-opacity",
        STATE_EDGE[state],
        dim && "opacity-60",
      )}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold leading-tight">{cat.label}</h4>
          <p className="mt-0.5 text-xs text-muted-foreground" data-testid={`pn-category-count-${cat.key}`}>
            {counts.on} of {plural(counts.total, "switch", "switches")} on
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-0.5">
          <span
            className={cn("text-right text-xs font-bold", STATE_WORD[state])}
            data-testid={`pn-category-state-${cat.key}`}
          >
            {CATEGORY_STATE_LABEL[state]}
          </span>
          <Switch
            checked={state === "on"}
            disabled={busy || locked !== null || state === "none"}
            title={locked ?? (state === "on" ? "Turn every switch in it off" : "Turn every switch in it on")}
            onCheckedChange={press}
            aria-label={`Phone notifications: ${cat.label} (${CATEGORY_STATE_LABEL[state]})`}
            className={cn(state === "partial" && "data-[state=unchecked]:bg-amber-400")}
            data-testid={`pn-category-switch-${cat.key}`}
          />
        </div>
      </header>

      {cat.description && (
        <p className="mt-2 line-clamp-2 text-xs leading-snug text-muted-foreground" title={cat.description}>
          {cat.description}
        </p>
      )}

      <MonthBlock cat={cat} />

      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-3">
        <p className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
          Goes to:
          {who.map((w) => (
            <StatusBadge key={w} tone={w === "Approvers" ? "accent" : "neutral"}>
              {w}
            </StatusBadge>
          ))}
        </p>
        {manageHref && (
          <Link
            href={manageHref}
            aria-label={`Manage the ${cat.label} switches`}
            data-testid={`pn-category-manage-${cat.key}`}
            className="inline-flex items-center gap-1 text-xs font-semibold text-sky-700 underline-offset-2 hover:underline dark:text-sky-400"
          >
            Manage <ArrowRight size={11} />
          </Link>
        )}
      </div>

      {/* only while every switch is still on (a change made elsewhere closes it) */}
      {asking && state === "on" && (
        <InlineConfirm
          testId={`pn-confirm-category-${cat.key}`}
          confirmLabel="Turn all off"
          destructive
          stacked
          className="mt-3"
          pending={busy}
          onConfirm={() => onSet(false, () => setAsking(false))}
          onCancel={() => setAsking(false)}
        >
          Turn off all {plural(counts.total, "switch", "switches")} in <b>{cat.label}</b>? {who.join(" and ")} stop
          getting these on their phones. They are still saved in the app.
        </InlineConfirm>
      )}
    </article>
  );
}

function CategoriesPanel({
  categories,
  controls,
  pushEnabled,
  busy,
  locked,
  canManage,
  onSet,
}: {
  categories: readonly PushCategory[];
  controls: readonly MobileMessageControl[] | undefined;
  pushEnabled: boolean;
  busy: boolean;
  locked: string | null;
  canManage: boolean;
  onSet: (cat: PushCategory, on: boolean, after?: () => void) => void;
}) {
  const counted = categories.map((cat) => ({ cat, counts: categoryCounts(cat, controls) }));
  const fullyOn = counted.filter((c) => categoryState(c.counts) === "on").length;
  return (
    <Panel
      title="Notification categories"
      icon={LayoutGrid}
      testId="pn-categories"
      description="Every phone notification the HRMS sends, by part of the HRMS. A category's switch turns all of its kinds on or off at once; the notification is still saved in the employee's app either way."
      actions={
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className="text-muted-foreground" data-testid="pn-categories-summary">
            <b className="text-foreground">{fullyOn}</b> of {plural(categories.length, "category", "categories")} fully
            on
          </span>
          {canManage && (
            <Link
              href={pnPath("controls")}
              className="inline-flex items-center gap-1 font-semibold text-sky-700 underline-offset-2 hover:underline dark:text-sky-400"
            >
              Every switch <ArrowRight size={11} />
            </Link>
          )}
        </div>
      }
    >
      {(locked || !pushEnabled) && (
        <div className="mb-3 space-y-2">
          {locked && (
            <Notice tone="neutral" testId="pn-categories-locked">
              {locked}
            </Notice>
          )}
          {!pushEnabled && (
            <Notice tone="neutral" testId="pn-categories-master-off">
              The master switch is <b>OFF</b>, so no category pushes anything until it is turned back on. You can still
              set them now.
            </Notice>
          )}
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {counted.map(({ cat, counts }) => (
          <CategoryCard
            key={cat.key}
            cat={cat}
            counts={counts}
            dim={!pushEnabled}
            busy={busy}
            locked={locked}
            manageHref={canManage ? pnPath("controls", `category=${encodeURIComponent(cat.key)}`) : null}
            onSet={(on, after) => onSet(cat, on, after)}
          />
        ))}
      </div>
    </Panel>
  );
}

// ── what needs attention ──────────────────────────────────────────────────────

/** The week's latest failed pushes, each with its reason and (where it can be) Push again. */
function NeedsAttention({
  rows,
  categories,
  locked,
  canSeeAll,
}: {
  rows: readonly MobileMessageRow[];
  categories: readonly PushCategory[];
  locked: string | null;
  canSeeAll: boolean;
}) {
  const categoryName = (key: string | undefined) => categories.find((c) => c.key === key)?.label;
  return (
    <Panel
      title="Needs attention"
      icon={AlertTriangle}
      testId="pn-attention"
      description={rows.length ? "The latest pushes that failed in the last 7 days, newest first." : undefined}
      actions={
        canSeeAll && rows.length > 0 ? (
          <Link
            href={pnPath("messages", "status=failed")}
            data-testid="pn-attention-all"
            className="inline-flex items-center gap-1 text-xs font-semibold text-sky-700 underline-offset-2 hover:underline dark:text-sky-400"
          >
            See every failed push <ArrowRight size={11} />
          </Link>
        ) : undefined
      }
    >
      {rows.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="pn-attention-empty">
          <CheckCircle2 size={15} className="shrink-0 text-emerald-600" /> No failed pushes this week.
        </p>
      ) : (
        <ul className="divide-y">
          {rows.map((r) => {
            const category = categoryName(r.category);
            return (
              <li
                key={r.id}
                className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 py-2.5 first:pt-0 last:pb-0"
                data-testid={`pn-failed-${r.id}`}
              >
                <div className="min-w-0 flex-1 basis-60">
                  <p className="text-sm font-semibold">
                    {r.employeeName}{" "}
                    <span className="font-mono text-[11px] font-normal text-muted-foreground">({r.employeeCode})</span>
                  </p>
                  <p className="break-words text-xs">
                    {r.title || r.kind}
                    <span className="text-muted-foreground">
                      {category ? ` · ${category}` : ""} · {formatWhen(r.createdAt)}
                    </span>
                  </p>
                  {r.pushError && (
                    <p className="mt-0.5 break-words text-[11px] text-red-700 dark:text-red-400">
                      Reason: {r.pushError}
                    </p>
                  )}
                </div>
                {canPushAgain(r) ? (
                  <PushAgainButton row={r} locked={locked} />
                ) : (
                  <span className="text-[11px] text-muted-foreground" data-testid={`pn-failed-nophone-${r.id}`}>
                    No phone registered now
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

/** Who gets phone notifications at all (the Settings tab), with a way there when the role may open it. */
function RecipientsLineStrip({ r, canOpenSettings }: { r: RecipientsLine; canOpenSettings: boolean }) {
  const line = recipientsLine(r);
  const nobody = r.receiving === 0;
  return (
    <div
      data-testid="pn-recipients-line"
      data-mode={r.mode}
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border px-3 py-2 text-[13px]",
        nobody
          ? "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
          : "bg-card text-card-foreground",
      )}
    >
      <Users size={15} className={cn("shrink-0", nobody ? "text-amber-600" : "text-violet-600")} />
      <span className="min-w-0 flex-1">
        Phone notifications go to: <b>{line.label}</b> — {line.reach}
      </span>
      {canOpenSettings && (
        <Link
          href={pnPath("settings")}
          data-testid="pn-recipients-settings"
          className="inline-flex items-center gap-1 text-xs font-semibold text-sky-700 underline-offset-2 hover:underline dark:text-sky-400"
        >
          Change who receives them <ArrowRight size={11} />
        </Link>
      )}
    </div>
  );
}

function Loading() {
  return (
    <div className="space-y-4" data-testid="pn-overview-loading">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-28 rounded-2xl" />
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-48 rounded-2xl" />
        ))}
      </div>
      <Skeleton className="h-40 w-full rounded-2xl" />
      <Skeleton className="h-56 w-full rounded-2xl" />
    </div>
  );
}

/**
 * Overview, the dashboard of every phone notification: the master switch, the phones registered, what was pushed today and
 * in 7 days and what became of it (delivered, failed, switched off, no phone); then every category of notification with one
 * switch for all of its kinds and its last 30 days; the week's failed pushes with Push again; the last 14 days and the kinds
 * of message. The health of the push service shows on top when it is not fine. `canOpen` says which tabs the role may open,
 * so a shortcut only leads where it may go; `canEdit` which it may change, because a category's switch is the Controls tab's
 * right on the server and Push again the Messages tab's.
 */
export default function OverviewTab({
  canOpen,
  canEdit,
}: {
  canOpen: (tab: PnTabKey) => boolean;
  canEdit: (tab: PnTabKey) => boolean;
}) {
  const { toast } = useToast();
  const tabLock = useLockedWhy();
  const { data, isLoading, isError, refetch } = useMobileMessagesOverview();
  // the health lives on the Configuration tab's endpoint: read only when the role may open that tab
  const config = useMobileMessagesConfig(canOpen("configuration"));
  // the switches, so a category counts (and changes) exactly the ones that are on: read only when Controls is open to the role
  const controls = useMobileMessageControls(canOpen("controls"));
  const update = useUpdateMobileMessageControls();
  // nothing changes on a View-only Overview, nor a switch without the Controls tab's right, nor a push without the Messages'
  const switchLock = tabLock ?? (canEdit("controls") ? null : VIEW_ONLY_TEXT);
  const againLock = tabLock ?? (canEdit("messages") ? null : VIEW_ONLY_TEXT);

  if (isLoading) return <Loading />;
  if (isError || !data) {
    return <LoadError what="The overview" onRetry={() => void refetch()} testId="pn-overview-error" />;
  }

  const o = data;
  const tiles = overviewTiles(o);
  const health = config.data?.health;
  const categories = o.categories ?? [];
  const link = (id: TileId) => {
    const to = TILE_LINK[id];
    return to && canOpen(to.tab) ? <TileLink to={pnPath(to.tab, to.query)}>{to.label}</TileLink> : null;
  };

  const setCategory = (cat: PushCategory, on: boolean, after?: () => void) => {
    const types = categoryChange(cat.keys, on, controls.data?.controls);
    if (Object.keys(types).length === 0) {
      after?.();
      return;
    }
    update.mutate(
      { types },
      {
        onSuccess: () => {
          after?.();
          toast({ title: `${cat.label}: every switch ${on ? "ON" : "OFF"}` });
        },
        onError: (e) => {
          after?.();
          toast({ title: "Could not change that", description: errorText(e, "Try again."), variant: "destructive" });
        },
      },
    );
  };

  return (
    <div className="space-y-4" data-testid="pn-overview">
      {health && healthNeedsBanner(health) && (
        <Notice tone={healthTone(health.state) === "bad" ? "bad" : "warn"} testId="pn-health-banner">
          <p className="font-semibold">Phone notifications: {HEALTH_LABEL[health.state]}</p>
          <p className="mt-0.5">{health.note}</p>
          {canOpen("configuration") && (
            <Link href={pnPath("configuration")} className="mt-1 inline-flex font-semibold underline">
              See why on the Configuration tab
            </Link>
          )}
        </Notice>
      )}
      {!o.pushEnabled && (
        <Notice tone="warn" testId="pn-master-off">
          Phone notifications are switched <b>OFF</b>: nothing is pushed to any phone. The employees&apos; Notifications
          list in the app still records everything.{" "}
          {canOpen("controls") && (
            <Link href={pnPath("controls")} className="font-semibold underline">
              Switch them on
            </Link>
          )}
        </Notice>
      )}
      {o.devices.employees > 0 && o.devices.withDevice === 0 && (
        <Notice tone="warn" testId="pn-no-phones">
          <b>No phone has registered for notifications yet</b>, so nothing can reach a notification bar. Notifications
          still appear inside the app. The usual cause is an app build made without Firebase (Google&apos;s push
          service): follow <b>docs/PUSH_NOTIFICATIONS.md</b> in the mobile app folder, install the new app and sign in.
        </Notice>
      )}

      {o.recipients && <RecipientsLineStrip r={o.recipients} canOpenSettings={canOpen("settings")} />}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="pn-tiles">
        {tiles.map((t) => (
          <StatusCard
            key={t.id}
            testId={`pn-tile-${t.id}`}
            label={t.label}
            value={t.value}
            sub={t.sub}
            tone={t.tone}
            icon={TILE_ICON[t.id]}
          >
            {link(t.id)}
          </StatusCard>
        ))}
      </div>

      {categories.length > 0 && (
        <CategoriesPanel
          categories={categories}
          controls={controls.data?.controls}
          pushEnabled={o.pushEnabled}
          busy={update.isPending}
          locked={switchLock}
          canManage={canOpen("controls")}
          onSet={setCategory}
        />
      )}

      {o.failedRecent && (
        <NeedsAttention
          rows={o.failedRecent}
          categories={categories}
          locked={againLock}
          canSeeAll={canOpen("messages")}
        />
      )}

      <Panel
        title="What was sent"
        description="Every notification is saved in the employee's app; these say what happened to its push."
        icon={ListChecks}
        testId="pn-counts"
        actions={
          <span className="text-xs text-muted-foreground" data-testid="pn-read-rate">
            Opened in the app (30 days):{" "}
            <b className="text-foreground">{o.readRate === null ? "-" : `${o.readRate}%`}</b>
          </span>
        }
      >
        <CountsLine label="Today" c={o.today} />
        <CountsLine label="Last 7 days" c={o.week} />
        <CountsLine label="Last 30 days" c={o.month} />
        <p className="mt-2 text-[11px] text-muted-foreground">
          Last phone registered: {formatWhen(o.devices.lastRegisteredAt)}
        </p>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <DayChart days={o.byDay} />
        <Panel title="By kind of message (30 days)" icon={BellRing} testId="pn-by-kind">
          {o.byKind.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing was sent yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="sr-only">
                <tr>
                  <th>Kind</th>
                  <th>Notifications</th>
                </tr>
              </thead>
              <tbody>
                {o.byKind.map((k) => (
                  <tr key={k.label} className="border-b last:border-b-0">
                    <td className="truncate py-1.5 pr-3">{k.label}</td>
                    <td className="py-1.5 text-right font-bold tabular-nums">{formatNumber(k.count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </div>
  );
}

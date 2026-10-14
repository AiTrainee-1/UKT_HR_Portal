import {
  AlertTriangle,
  ArrowLeft,
  BookOpenCheck,
  CalendarCheck,
  Info,
  Loader2,
  MinusCircle,
  RefreshCw,
  SearchX,
  ShieldCheck,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyNote, KpiTile, PayrollLoader, SectionCard, SkeletonRows } from "@/components/payroll/kit/parts";
import type { PayrollKind } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import type { Accent } from "./accent";
import { SECTIONS } from "./logic";

/**
 * What the page looks like before the first answer arrives: the same header, KPI tiles, section bar and section cards
 * it will have, drawn as placeholders, with the payroll loader in the card that waits on everything else.
 */
export function PageSkeleton({ accent, backLabel, onBack }: { accent: Accent; backLabel: string; onBack: () => void }) {
  return (
    <div className="space-y-5" data-testid="pd-skeleton" aria-busy="true" aria-live="polite">
      <div className="clay-card relative overflow-hidden rounded-2xl border border-slate-100 p-4 pt-5 sm:p-5 sm:pt-6">
        <span className={cn("absolute inset-x-0 top-0 h-1", accent.bar)} aria-hidden="true" />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button variant="outline" size="sm" className="h-9 gap-2" onClick={onBack} data-testid="pd-back">
            <ArrowLeft size={14} /> {backLabel}
          </Button>
          <Skeleton className="h-9 w-48 rounded-xl" />
        </div>
        <div className="mt-4 flex items-start gap-4">
          <Skeleton className="h-14 w-14 shrink-0 rounded-xl" />
          <div className="flex-1 space-y-2.5">
            <Skeleton className="h-7 w-64 max-w-full" />
            <div className="flex flex-wrap gap-1.5">
              {[20, 28, 16, 24, 28].map((w, i) => (
                <Skeleton key={i} className="h-5 rounded-full" style={{ width: `${w * 4}px` }} />
              ))}
            </div>
            <Skeleton className="h-3 w-72 max-w-full" />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 2xl:grid-cols-6" data-testid="pd-skeleton-kpis">
        <KpiTile label="Gross" value="" icon={TrendingUp} tone="bg-blue-50 text-blue-800" loading />
        <KpiTile label="Deductions" value="" icon={MinusCircle} tone="bg-red-50 text-red-800" loading />
        <KpiTile
          label="Net payable"
          value=""
          icon={Wallet}
          tone={cn(accent.kpi, accent.tileRing)}
          className="order-first col-span-2 sm:order-none sm:col-span-1"
          loading
        />
        <KpiTile label="Days worked" value="" icon={CalendarCheck} tone="bg-sky-50 text-sky-800" loading />
        <KpiTile label="Issues" value="" icon={ShieldCheck} tone="bg-slate-50 text-slate-700" loading />
        <KpiTile
          label="Rules"
          value=""
          icon={BookOpenCheck}
          tone="bg-violet-50 text-violet-800"
          className="col-span-2 sm:col-span-1"
          loading
        />
      </div>

      <div className="-mx-4 flex gap-2 border-b border-slate-200/70 bg-white/85 px-4 py-2 lg:-mx-6 lg:px-6">
        {SECTIONS.map((s) => (
          <Skeleton key={s.id} className="h-8 w-20 shrink-0 rounded-full" />
        ))}
      </div>

      <SectionCard title="How this salary was worked out" description="Loading the payroll's figures…">
        <PayrollLoader label="Loading the payroll" />
        <div className="mt-2 grid gap-4 md:grid-cols-2">
          <SkeletonRows rows={3} />
          <SkeletonRows rows={3} />
        </div>
      </SectionCard>
      <SectionCard title="Issues detected" description="Loading what payroll flagged…">
        <SkeletonRows rows={3} />
      </SectionCard>
    </div>
  );
}

/** The server said no (not found, outside this login's branch, or the role may not open it) or the address is not a payroll. */
export function NotFoundState({ backLabel, onBack }: { backLabel: string; onBack: () => void }) {
  return (
    <div className="clay-card rounded-2xl border border-slate-100 p-6" data-testid="pd-not-found">
      <EmptyNote
        icon={SearchX}
        title="This payroll was not found, or you do not have access to it"
        hint="It may have been removed, belong to another branch, or the link may be wrong."
        action={
          <Button
            variant="outline"
            size="sm"
            className="mt-2 h-9 gap-2"
            onClick={onBack}
            data-testid="pd-not-found-back"
          >
            <ArrowLeft size={14} /> {backLabel}
          </Button>
        }
      />
    </div>
  );
}

/** Any other failure: say so, show what the server said, and let the reader try again. */
export function ErrorState({
  message,
  onRetry,
  retrying,
  backLabel,
  onBack,
}: {
  message: string;
  onRetry: () => void;
  retrying: boolean;
  backLabel: string;
  onBack: () => void;
}) {
  return (
    <div className="clay-card rounded-2xl border border-red-100 p-6" data-testid="pd-error">
      <div className="flex flex-col items-center gap-2 text-center">
        <AlertTriangle size={30} className="text-red-400" />
        <p className="text-sm font-semibold text-gray-800">Could not load this payroll</p>
        <p className="max-w-md text-xs text-muted-foreground">{message}</p>
        <div className="mt-2 flex flex-wrap justify-center gap-2">
          <Button size="sm" className="h-9 gap-2" onClick={onRetry} disabled={retrying} data-testid="pd-retry">
            {retrying ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Retry
          </Button>
          <Button variant="outline" size="sm" className="h-9 gap-2" onClick={onBack}>
            <ArrowLeft size={14} /> {backLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** A refresh failed but the page still has the last answer: keep showing it and offer to try again. */
export function StaleBar({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900 print:hidden"
      role="status"
      data-testid="pd-stale"
    >
      <span className="flex items-center gap-2">
        <AlertTriangle size={15} /> Could not refresh this payroll. You are looking at the last details that loaded.
      </span>
      <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={onRetry} disabled={retrying}>
        {retrying ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Retry
      </Button>
    </div>
  );
}

/**
 * A payroll with no day-by-day breakdown behind it (older session-based production, or no stored slip): the days, rules
 * and issues are not there, and this says why instead of leaving three sections that look merely empty. The server puts its
 * own explanation in the payroll's notes (after anything HR typed); it is shown as it came, and this page's sentence is
 * only added when the notes do not already say it.
 */
export function DegradedNotice({ legacy, notes }: { legacy: boolean; notes: string | null }) {
  const fallback = legacy
    ? "This payroll was calculated by the older session-based production engine: its day-by-day detail, rules and issues are not available here."
    : "No day-by-day breakdown is stored for this payroll (it has no salary slip), so the days, rules and issues that come from it are not available here.";
  const explained = !!notes && /not available here/i.test(notes);
  const body = explained ? notes : [fallback, notes].filter(Boolean).join("\n");
  return (
    <div
      className="flex items-start gap-3 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-950"
      role="note"
      data-testid="pd-degraded"
    >
      <Info size={17} className="mt-0.5 shrink-0 text-sky-600" />
      <div className="min-w-0">
        <p className="font-bold">Some details are not available for this payroll</p>
        <p className="mt-0.5 whitespace-pre-line text-xs leading-relaxed text-sky-900/80">{body}</p>
      </div>
    </div>
  );
}

/** Previous / Next: the page keeps the old payroll (dimmed) and says the next one is on its way. */
export function SwitchingChip({ kind }: { kind: PayrollKind }) {
  return (
    <div
      role="status"
      className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 shadow-lg print:hidden"
      data-testid="pd-switching"
    >
      <Loader2 size={14} className="animate-spin" />
      Loading the {kind === "production" ? "production " : ""}payroll…
    </div>
  );
}

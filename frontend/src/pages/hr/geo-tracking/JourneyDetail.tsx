// Journey History: one journey, as a page-like panel with a Back button. The hero (who, where to, when), the figures, the map beside
// the journey told as a story (started, breaks, resumed, completed), the detailed log of every segment and event, and the phone's
// health, and the buttons: Export (xlsx), Rebuild (recompute stops, gaps and totals from the raw points, after a confirm) and Refresh.
// A journey that is still active carries a Live badge and reads itself again every 30 seconds.
import { useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  CalendarDays,
  Download,
  Loader2,
  MapPinned,
  RefreshCw,
  Wrench,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Avatar, SectionCard } from "@/components/payroll/kit/parts";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { canEdit, useAuth } from "@/contexts/AuthContext";
import {
  downloadJourneyExport,
  isTrackingNotFound,
  trackingErrorMessage,
  useJourney,
  useJourneyTrail,
  useRebuildJourney,
} from "@/lib/api-client/custom-hooks";
import ActivityTimeline from "./ActivityTimeline";
import DeviceCard from "./DeviceCard";
import JourneyMap from "./JourneyMap";
import JourneySummary from "./JourneySummary";
import PlaceDetails from "./PlaceDetails";
import Timeline from "./Timeline";
import { buildActivities, journeyStats } from "./activity";
import { buildTimeline, endReasonLabel, fmtDate, fmtDateTime, istDay, mapModel, trailModel } from "./logic";
import { ApprovalChip, Chip, EmptyNote, LiveBadge, StatePill } from "./ui";

export default function JourneyDetail({ id, onBack }: { id: number; onBack: () => void }) {
  const { toast } = useToast();
  const { token, user } = useAuth();
  const query = useJourney(id);
  const rebuild = useRebuildJourney();
  const [selected, setSelected] = useState<string | null>(null);
  const [fits, setFits] = useState(0);
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  const [exporting, setExporting] = useState(false);

  const detail = query.data;
  const active = detail?.track.status === "active";
  const rows = useMemo(() => (detail ? buildTimeline(detail.segments, detail.events, active) : []), [detail, active]);
  const model = useMemo(() => (detail ? mapModel(detail, rows) : null), [detail, rows]);
  // every recorded position of the journey (the complete route and the points HR can pick); the map still works without it
  const trailQuery = useJourneyTrail(id, detail !== undefined, active);
  const trail = useMemo(() => trailModel(trailQuery.data, rows), [trailQuery.data, rows]);
  const trailStatus = trailQuery.isError ? "error" : trailQuery.data ? "ready" : "loading";
  // the first and the last recorded position: what picking "Journey started" / "On-duty completed" points out on the map
  const startKey = trail?.dots[0]?.key ?? null;
  const endKey = trail?.dots.length ? trail.dots[trail.dots.length - 1].key : null;
  const activities = useMemo(
    () => (detail ? buildActivities(detail, rows, active, { startKey, endKey }) : []),
    [detail, rows, active, startKey, endKey],
  );
  const stats = useMemo(() => (detail ? journeyStats(detail, activities) : null), [detail, activities]);
  // allowed to recompute: a role with View only can read a journey and export it, but not rebuild it
  const mayRebuild = canEdit(user, "geo_attendance");

  const handleExport = async () => {
    if (!detail) return;
    setExporting(true);
    try {
      const base = `journey-${detail.track.employeeCode || detail.track.employeeId}-${istDay(detail.track.startedAt) || id}`;
      const name = await downloadJourneyExport(id, () => token, base);
      toast({ title: "Journey exported", description: name });
    } catch (err) {
      toast({
        title: "Export failed",
        description: trackingErrorMessage(err, "The file could not be made."),
        variant: "destructive",
      });
    } finally {
      setExporting(false);
    }
  };

  const handleRebuild = async () => {
    setConfirmRebuild(false);
    try {
      await rebuild.mutateAsync(id);
      setSelected(null);
      toast({ title: "Journey rebuilt", description: "Stops, gaps and totals were recomputed from the raw points." });
    } catch (err) {
      toast({
        title: "Rebuild failed",
        description: trackingErrorMessage(err, "The journey could not be rebuilt."),
        variant: "destructive",
      });
    }
  };

  const back = (
    <Button variant="ghost" size="sm" className="-ml-2 h-8 gap-1.5 text-xs" onClick={onBack} data-testid="journey-back">
      <ArrowLeft size={13} /> Back to journeys
    </Button>
  );

  if (query.isPending) {
    return (
      <div className="space-y-3" data-testid="journey-detail-loading">
        {back}
        <Skeleton className="h-28 rounded-2xl" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-2xl" />
          ))}
        </div>
        <Skeleton className="h-[460px] rounded-2xl" />
      </div>
    );
  }

  if (!detail || !model || !stats) {
    return (
      <div className="space-y-3" data-testid="journey-detail-error">
        {back}
        <Card className="border-0 shadow-sm">
          <CardContent className="p-0">
            <EmptyNote icon={<AlertTriangle size={30} />}>
              <p className="font-semibold text-gray-700">
                {isTrackingNotFound(query.error) ? "This journey was not found." : "The journey could not be loaded."}
              </p>
              <p className="mt-1">{trackingErrorMessage(query.error, "Check the connection and try again.")}</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => void query.refetch()}>
                Try again
              </Button>
            </EmptyNote>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { track, summary } = detail;
  const hasGeometry = model.all.length > 0;

  return (
    <div className="space-y-4" data-testid="journey-detail" data-journey-id={track.id} data-status={track.status}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {back}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1.5 text-xs"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
            data-testid="journey-refresh"
            data-view-safe
          >
            {query.isFetching ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1.5 text-xs"
            onClick={() => void handleExport()}
            disabled={exporting}
            data-testid="journey-export"
            data-view-safe
          >
            {exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} Export (Excel)
          </Button>
          {mayRebuild && (
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1.5 text-xs"
              onClick={() => setConfirmRebuild(true)}
              disabled={rebuild.isPending}
              data-testid="journey-rebuild"
            >
              {rebuild.isPending ? <Loader2 size={13} className="animate-spin" /> : <Wrench size={13} />} Rebuild
            </Button>
          )}
        </div>
      </div>

      <section className="clay-card rounded-2xl border border-slate-100 p-4 sm:p-5" data-testid="journey-hero">
        <div className="flex flex-wrap items-start gap-4">
          <Avatar name={track.employeeName} size={56} className="rounded-2xl text-lg" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <h3 className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xl font-black leading-tight text-gray-900">
              {track.employeeName}
              <span className="font-mono text-sm font-semibold text-gray-500">({track.employeeCode})</span>
            </h3>
            <p className="text-sm text-gray-700">
              On-Duty to <b>"{track.destination || "no destination"}"</b>
              <span className="text-gray-500">
                {" "}
                · {track.department ?? "No department"} · {track.branchName ?? "No branch"}
              </span>
            </p>
            <div className="flex flex-wrap items-center gap-1.5">
              {active ? <LiveBadge /> : <Chip className="bg-gray-100 text-gray-700">Ended</Chip>}
              {active && <StatePill state={track.state} />}
              <ApprovalChip status={track.approvalStatus} />
              {track.hasMock && (
                <Chip testId="mock-flag" className="bg-red-50 text-red-700">
                  <AlertTriangle size={11} /> Simulated location
                </Chip>
              )}
            </div>
            <p className="text-xs text-gray-600" data-testid="journey-times">
              Started {fmtDateTime(track.startedAt, true)} ·{" "}
              {active ? (
                <>Still tracking</>
              ) : (
                <>
                  Ended {fmtDateTime(track.endedAt, true)} ({endReasonLabel(track.endReason, track.status)})
                </>
              )}
            </p>
          </div>
          <div className="hidden items-center gap-2 rounded-xl bg-slate-50 px-3.5 py-2 sm:flex text-sm font-semibold text-slate-700 ring-1 ring-slate-100">
            <CalendarDays size={15} className="text-[#006496]" />
            {fmtDate(track.startedAt)}
          </div>
        </div>
      </section>

      {active && (
        <p className="flex items-center gap-1.5 text-xs text-gray-600" data-testid="live-note">
          <Activity size={13} className="text-green-600" /> This journey is still being recorded. The page reads it
          again every 30 seconds (last update {fmtDateTime(new Date(query.dataUpdatedAt).toISOString(), true)}).
        </p>
      )}
      {query.isError && (
        <p
          role="alert"
          className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800"
          data-testid="refresh-failed"
        >
          The latest update could not be loaded ({trackingErrorMessage(query.error, "connection problem")}). Showing
          what was loaded before.
        </p>
      )}
      {track.endReason === "rejected" && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800" data-testid="rejected-note">
          The On-Duty request was rejected, so tracking stopped. Everything recorded until then is kept here.
        </p>
      )}
      {track.hasMock && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800" data-testid="mock-note">
          The phone reported a simulated (fake GPS) location during this journey. Those parts of the route are drawn in
          red and the positions cannot be trusted.
        </p>
      )}

      <JourneySummary detail={detail} stats={stats} />

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <div className="space-y-4 xl:sticky xl:top-3">
          <SectionCard
            title="Route"
            description="The recorded path, every break and every position."
            icon={MapPinned}
            testId="journey-route"
            actions={
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={() => {
                  setSelected(null);
                  setFits((n) => n + 1);
                }}
                data-testid="journey-fit"
              >
                Fit route
              </Button>
            }
          >
            <JourneyMap
              detail={detail}
              model={model}
              trail={trail}
              trailStatus={trailStatus}
              selectedKey={selected}
              onSelect={setSelected}
              fitSignal={`${id}:${hasGeometry ? "geo" : "none"}:${fits}`}
            />
          </SectionCard>
          <PlaceDetails detail={detail} model={model} rows={rows} trail={trail} selectedKey={selected} />
        </div>
        <ActivityTimeline
          activities={activities}
          stats={stats}
          selectedKey={selected}
          onSelect={setSelected}
          active={active}
        />
      </div>

      <Timeline rows={rows} selectedKey={selected} onSelect={setSelected} active={active} />

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <DeviceCard detail={detail} />
        <Card className="clay-card rounded-2xl border border-slate-100" data-testid="journey-facts">
          <CardContent className="space-y-1 p-4 text-xs text-gray-600">
            <p>
              First position: <b className="text-gray-900">{fmtDateTime(summary.firstPointAt, true)}</b>
            </p>
            <p>
              Last position: <b className="text-gray-900">{fmtDateTime(track.lastPointAt, true)}</b>
            </p>
            <p>
              Totals worked out: <b className="text-gray-900">{fmtDateTime(summary.rebuiltAt, true)}</b>
            </p>
            <p className="pt-1 text-gray-500">
              A stop is a place the employee stayed at for at least the stop time set in the tracking rules. A gap is a
              time with no location at all. Rebuild recomputes both from the raw points.
            </p>
          </CardContent>
        </Card>
      </div>

      <AlertDialog open={confirmRebuild} onOpenChange={setConfirmRebuild}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rebuild this journey?</AlertDialogTitle>
            <AlertDialogDescription>
              The stops, gaps, route and totals of {track.employeeName}'s journey are recomputed from the raw points
              with the current tracking rules. The raw points and events are not changed or deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleRebuild()}>Rebuild journey</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

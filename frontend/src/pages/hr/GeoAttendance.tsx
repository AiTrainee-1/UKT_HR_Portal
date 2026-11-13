// Geo Attendance (HR): a module of its own for the work done away from the premises: On-Duty approvals, geo punch
// verification, the Live Map, every journey (with its replay), the On-Duty Map and the tracking rules. Each section has its
// own address (geo-tracking/routes.ts: /hr/geo-attendance/live-map, /journeys/12/simulate ...); the old single page's
// addresses (?tab=map, ?tab=journeys&journey=12) are sent on to them. This file is the frame: the title row, the section
// strip, and the section that is open. Each section is its own chunk (Leaflet only loads with a map), and only the open
// section asks the server for anything: the frame itself reads the two pending lists the sidebar already reads (no extra
// request) and the on-duty count once a minute (the Live Map refreshes it every 20 s).
// The Managing Director's portal mounts this same component (components/md/MdHrApp.tsx, under /md/geo-attendance/...), so it
// stays the default export of this path, takes no props and navigates through wouter (the MD router translates the address).
import { lazy, Suspense, useCallback, useEffect, useRef, type ReactNode } from "react";
import { Redirect, useLocation, useSearch } from "wouter";
import { Camera, MapPinned, Navigation, Radar, Route as RouteIcon, Users } from "lucide-react";
import HrLayout from "@/components/HrLayout";
import { RefreshButton } from "@/components/PageRefreshBar";
import { PillTabs, type PillTabItem } from "@/components/ui/pill-tabs";
import { useLiveTracks, useOnDutyPunchVerificationsHR, useOnDutySessionsHR } from "@/lib/api-client/custom-hooks";
import { useMdEmbedded } from "@/lib/md/embed";
import { useLevel } from "@/lib/tab-access";
import { cn } from "@/lib/utils";
import { SectionSkeleton } from "./geo-tracking/kit";
import {
  GEO_SECTIONS,
  GEO_SECTION_KEY,
  GEO_SECTION_LABEL,
  geoPath,
  journeyPath,
  readGeoRoute,
  simulatePath,
  type GeoSection,
} from "./geo-tracking/routes";

const ApprovalsTab = lazy(() => import("./geo-tracking/tabs/ApprovalsTab"));
const VerificationsTab = lazy(() => import("./geo-tracking/tabs/VerificationsTab"));
const LiveMapTab = lazy(() => import("./geo-tracking/tabs/LiveMapTab"));
const JourneyHistoryTab = lazy(() => import("./geo-tracking/JourneyHistoryTab"));
const OnDutyMapTab = lazy(() => import("./geo-tracking/tabs/OnDutyMapTab"));
const TrackingSettingsTab = lazy(() => import("./geo-tracking/tabs/TrackingSettingsTab"));

const ICONS: Record<GeoSection, ReactNode> = {
  approvals: <MapPinned size={13} />,
  verifications: <Camera size={13} />,
  "live-map": <Radar size={13} />,
  journeys: <RouteIcon size={13} />,
  "on-duty-map": <Users size={13} />,
  settings: <Navigation size={13} />,
};

/** The header chip reads the live board once a minute (the Live Map itself reads it every 20 s). */
const HEADER_POLL_MS = 60_000;

/** A tab's name with the number of things waiting for HR, as a small badge (the number is read as "pending" by a screen reader). */
function TabLabel({ text, count }: { text: string; count?: number }) {
  return (
    <>
      {text}
      {count ? (
        <span
          className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-amber-500 px-1.5 text-[10px] font-bold leading-none text-white"
          data-testid="tab-badge"
        >
          {count}
          <span className="sr-only"> pending</span>
        </span>
      ) : null}
    </>
  );
}

export default function GeoAttendance() {
  const [location, navigate] = useLocation();
  const search = useSearch();
  // Each section is an address of its own (the route guard blocks a hidden one, HrLayout locks a View-only one): the strip
  // offers the ones this role may see, a landing goes to the first of them, and the header asks only for what they show.
  const level = useLevel();
  const visible = GEO_SECTIONS.filter((s) => level(GEO_SECTION_KEY[s]) !== "hidden");
  const parsed = readGeoRoute(location, search, visible);
  const section = parsed.route?.section ?? "approvals";

  const { data: pendingSessions } = useOnDutySessionsHR("pending", visible.includes("approvals"));
  const { data: pendingPunches } = useOnDutyPunchVerificationsHR("pending", visible.includes("verifications"));
  // the Managing Director's copy has a Live chip and an "On duty now" figure of its own right beside the title
  const embedded = useMdEmbedded();
  const live = useLiveTracks(!embedded && visible.includes("live-map"), HEADER_POLL_MS);
  const onDuty = embedded || live.isError ? undefined : live.data?.length;

  const sessions = pendingSessions?.length ?? 0;
  const punches = pendingPunches?.length ?? 0;

  const go = useCallback((to: string) => navigate(to), [navigate]);
  const openJourney = useCallback((id: number | null) => go(id === null ? geoPath("journeys") : journeyPath(id)), [go]);
  const simulate = useCallback((id: number) => go(simulatePath(id)), [go]);
  // "Simulate a journey" hidden: no replay is offered anywhere (the picker, a row's button, a journey's button)
  const maySimulate = level("geo_attendance.journeys.simulate") !== "hidden";

  // on a phone the strip scrolls: the open tab is brought into view (a link to a section opens it out of sight otherwise)
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    strip.current
      ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      ?.scrollIntoView?.({ inline: "center", block: "nearest" });
  }, [section, sessions, punches]);

  if (visible.length === 0) {
    return (
      <HrLayout>
        <p
          className="rounded-2xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground"
          data-testid="nothing-open"
        >
          Nothing on this page is open to your role.
        </p>
      </HrLayout>
    );
  }
  if (parsed.redirect) return <Redirect to={parsed.redirect} replace />;
  const route = parsed.route;

  const tabs: (PillTabItem & { value: GeoSection })[] = visible.map((value) => ({
    value,
    label: (
      <TabLabel
        text={GEO_SECTION_LABEL[value]}
        count={value === "approvals" ? sessions : value === "verifications" ? punches : undefined}
      />
    ),
    icon: ICONS[value],
  }));

  return (
    <HrLayout>
      <div className="space-y-5" data-testid="geo-attendance" data-section={section}>
        {/* The title row keeps the shape every HR page has (a block with the title and one line under it, the Refresh button
            beside it): the Managing Director's portal finds that row in the page and slots its own pieces into it. The
            "on duty now" chip sits inside the heading, like the "pending" badge of the Requests page. */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <span
              aria-hidden
              className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-sky-50 text-[#006496] ring-1 ring-sky-100 sm:flex"
            >
              <MapPinned size={22} />
            </span>
            <div className="min-w-0">
              <h2 className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-2xl font-black text-gray-900">
                Geo Attendance
                {onDuty !== undefined && (
                  <button
                    type="button"
                    onClick={() => go(geoPath("live-map"))}
                    title="Open the Live Map"
                    data-testid="on-duty-now"
                    data-count={onDuty}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300",
                      onDuty > 0
                        ? "border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
                        : "border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100",
                    )}
                  >
                    {/* a still dot: an endless pulse here kept the browser recalculating styles on every frame */}
                    <span
                      aria-hidden
                      className={cn(
                        "inline-block h-1.5 w-1.5 rounded-full",
                        onDuty > 0 ? "bg-emerald-500 ring-2 ring-emerald-200" : "bg-slate-400",
                      )}
                    />
                    {onDuty > 0 ? `${onDuty} on duty now` : "No one on duty now"}
                  </button>
                )}
              </h2>
              <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">
                Approve On-Duty requests, verify geo punches, and follow employees working off the premises, live and
                journey by journey.
              </p>
            </div>
          </div>
          <RefreshButton />
        </div>

        {/* On a phone the six tabs scroll sideways inside their own box instead of pushing the page wider. The strip is made
            again when a count changes, so the pills measure themselves with the badge in place. */}
        <div ref={strip} className="overflow-x-auto pb-1" data-testid="geo-tabs">
          <PillTabs
            key={`${sessions}-${punches}`}
            items={tabs}
            value={section}
            onChange={(v) => go(geoPath(v as GeoSection))}
          />
        </div>

        <div
          key={section}
          className="animate-in fade-in slide-in-from-bottom-1 duration-300 motion-reduce:animate-none"
          data-testid="geo-section"
        >
          <Suspense fallback={<SectionSkeleton section={section} />}>
            {section === "approvals" && <ApprovalsTab />}
            {section === "verifications" && <VerificationsTab />}
            {section === "live-map" && <LiveMapTab onOpenJourney={openJourney} />}
            {section === "journeys" && route && (
              <JourneyHistoryTab
                journeyId={route.journey}
                view={route.view}
                onJourneyChange={openJourney}
                onSimulate={maySimulate ? simulate : undefined}
              />
            )}
            {section === "on-duty-map" && <OnDutyMapTab />}
            {section === "settings" && <TrackingSettingsTab />}
          </Suspense>
        </div>
      </div>
    </HrLayout>
  );
}

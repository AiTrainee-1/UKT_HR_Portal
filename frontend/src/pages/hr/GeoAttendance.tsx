// Geo Attendance (HR): Office Geo Punch, On-Duty approvals, punch verification, live tracking and the journeys of employees working
// off the premises. This file is the page frame (title row, tab strip, which tab is open); each tab is in geo-tracking/tabs/, the
// Journey History tab in geo-tracking/JourneyHistoryTab. The open tab and journey live in the address (?tab=journeys&journey=12).
// The Managing Director's portal mounts this same component (components/md/MdHrApp.tsx), so it stays the default export of this
// path and takes no props.
import { useEffect, useRef } from "react";
import { Camera, MapPinned, Navigation, Radar, Route as RouteIcon, Users } from "lucide-react";
import HrLayout from "@/components/HrLayout";
import { RefreshButton } from "@/components/PageRefreshBar";
import { Chip } from "@/components/payroll/kit/parts";
import { PillTabs, type PillTabItem } from "@/components/ui/pill-tabs";
import { useLiveTracks, useOnDutyPunchVerificationsHR, useOnDutySessionsHR } from "@/lib/api-client/custom-hooks";
import { useMdEmbedded } from "@/lib/md/embed";
import { useGeoAddress, type GeoTab } from "./geo-tracking/address";
import JourneyHistoryTab from "./geo-tracking/JourneyHistoryTab";
import ApprovalsTab from "./geo-tracking/tabs/ApprovalsTab";
import LiveMapTab from "./geo-tracking/tabs/LiveMapTab";
import OnDutyMapTab from "./geo-tracking/tabs/OnDutyMapTab";
import TrackingSettingsTab from "./geo-tracking/tabs/TrackingSettingsTab";
import VerificationsTab from "./geo-tracking/tabs/VerificationsTab";

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
  const { tab, setTab, journeyId, setJourney } = useGeoAddress();
  const { data: pendingSessions } = useOnDutySessionsHR("pending");
  const { data: pendingPunches } = useOnDutyPunchVerificationsHR("pending");
  // the same query as the Live Map's board: nothing extra is asked of the server
  const live = useLiveTracks();
  // the Managing Director's copy has a Live chip and an "On duty now" figure of its own right beside the title
  const embedded = useMdEmbedded();
  const onDuty = embedded ? undefined : live.data?.length;

  const sessions = pendingSessions?.length ?? 0;
  const punches = pendingPunches?.length ?? 0;

  // on a phone the strip scrolls: the open tab is brought into view (a link such as ?tab=onduty opens it out of sight otherwise)
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    strip.current
      ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      ?.scrollIntoView?.({ inline: "center", block: "nearest" });
  }, [tab, sessions, punches]);
  const tabs: (PillTabItem & { value: GeoTab })[] = [
    {
      value: "approvals",
      label: <TabLabel text="On-Duty Approvals" count={sessions} />,
      icon: <MapPinned size={13} />,
    },
    {
      value: "verifications",
      label: <TabLabel text="Punch Verifications" count={punches} />,
      icon: <Camera size={13} />,
    },
    { value: "map", label: "Live Map", icon: <Radar size={13} /> },
    { value: "journeys", label: "Journey History", icon: <RouteIcon size={13} /> },
    { value: "onduty", label: "On-Duty Map", icon: <Users size={13} /> },
    { value: "tracking", label: "Tracking Settings", icon: <Navigation size={13} /> },
  ];

  return (
    <HrLayout>
      <div className="space-y-5" data-testid="geo-attendance">
        {/* The title row keeps the shape every HR page has (a block with the title and one line under it, the Refresh button
            beside it): the Managing Director's portal finds that row in the page and slots its own pieces into it. The
            "on duty now" chip sits inside the heading, like the "pending" badge of the Requests page. */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-2xl font-black text-gray-900">
              <MapPinned size={22} className="text-[#006496]" />
              Geo Attendance
              {onDuty !== undefined && (
                <button
                  type="button"
                  onClick={() => setTab("map")}
                  title="Open the Live Map"
                  data-testid="on-duty-now"
                  data-count={onDuty}
                  className="rounded-full text-base font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
                >
                  <Chip tone={onDuty > 0 ? "success" : "neutral"} className="cursor-pointer text-xs">
                    <span
                      aria-hidden
                      className={`inline-block h-1.5 w-1.5 rounded-full bg-current ${onDuty > 0 ? "animate-pulse" : ""}`}
                    />
                    {onDuty > 0 ? `${onDuty} on duty now` : "No one on duty now"}
                  </Chip>
                </button>
              )}
            </h2>
            <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">
              Approve On-Duty requests, check geo punches, and follow employees working off the premises, live and by
              journey.
            </p>
          </div>
          <RefreshButton />
        </div>

        {/* On a phone the six tabs scroll sideways inside their own box instead of pushing the page wider. The strip is made
            again when a count changes, so the pills measure themselves with the badge in place. */}
        <div ref={strip} className="overflow-x-auto pb-1" data-testid="geo-tabs">
          <PillTabs key={`${sessions}-${punches}`} items={tabs} value={tab} onChange={(v) => setTab(v as GeoTab)} />
        </div>

        {tab === "approvals" && <ApprovalsTab />}
        {tab === "verifications" && <VerificationsTab />}
        {tab === "map" && <LiveMapTab onOpenJourney={setJourney} />}
        {tab === "journeys" && <JourneyHistoryTab journeyId={journeyId} onJourneyChange={setJourney} />}
        {tab === "onduty" && <OnDutyMapTab />}
        {tab === "tracking" && <TrackingSettingsTab />}
      </div>
    </HrLayout>
  );
}

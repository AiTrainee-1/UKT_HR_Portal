// Journey History: the details of what is picked on the map or in the timeline (a stationary period, a recorded position, a
// stretch of travel, a gap, an event), with the buttons that open the place in Google Maps and, when HR turns it on, Google's
// own map of the place beside our route (Google's names, shops and landmarks). Nothing picked = the latest / last position.
import { useMemo, useState } from "react";
import { Eye, EyeOff, MapPin } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { JourneyDetail, JourneySegment } from "@/lib/api-client/custom-hooks";
import {
  causeLabel,
  eventDetail,
  eventStyle,
  fmtCoords,
  fmtDateTime,
  fmtDistance,
  fmtDuration,
  pointFacts,
  segmentKey,
  timeRange,
  type LatLng,
  type MapModel,
  type TimelineRow,
  type TrailModel,
} from "./logic";
import { googleEmbedUrl, readGoogleView, saveGoogleView } from "./mapLinks";
import { PlaceLinks } from "./PlaceLinks";
import { Chip } from "./ui";

type End = { label: string; pos: LatLng };

type Info = {
  heading: string;
  chips: { text: string; className: string; testId?: string }[];
  title: string;
  facts: [string, string][];
  note: string;
  /** The one place this is about: it gets the buttons and the Google view. */
  pos: LatLng | null;
  /** A stretch (travel, a gap) has two ends instead: each gets the buttons. */
  ends: End[];
};

const none = (): Info => ({ heading: "", chips: [], title: "", facts: [], note: "", pos: null, ends: [] });

const at = (lat: number | null, lng: number | null): LatLng | null =>
  lat !== null && lng !== null ? [lat, lng] : null;

function ends(seg: JourneySegment, from: string, to: string): End[] {
  const a = at(seg.startLat, seg.startLng);
  const b = at(seg.endLat, seg.endLng);
  return [...(a ? [{ label: from, pos: a }] : []), ...(b ? [{ label: to, pos: b }] : [])];
}

function describeSelection(
  key: string | null,
  detail: JourneyDetail,
  model: MapModel,
  rows: TimelineRow[],
  trail: TrailModel | null,
): Info {
  const active = detail.track.status === "active";
  if (key?.startsWith("pt-")) {
    const dot = trail?.byKey.get(key);
    if (dot) {
      const chips: Info["chips"] = [];
      if (!dot.point.used) {
        chips.push({ text: "set aside: poor accuracy or a GPS jump", className: "bg-gray-100 text-gray-700" });
      }
      if (dot.point.mock) chips.push({ text: "simulated", className: "bg-red-50 text-red-700" });
      if (dot.stopNumber !== null) {
        chips.push({
          text: `during stop ${dot.stopNumber}`,
          className: dot.longStop ? "bg-purple-50 text-purple-700" : "bg-amber-50 text-amber-800",
        });
      }
      return {
        ...none(),
        heading: "Recorded position",
        chips,
        title: fmtDateTime(new Date(dot.point.t).toISOString(), true),
        facts: pointFacts(dot.point),
        pos: dot.pos,
      };
    }
  }
  if (key?.startsWith("seg-")) {
    const seg = detail.segments.find((s) => segmentKey(s) === key);
    const row = rows.find((r) => r.key === key);
    if (seg && row) {
      const when = timeRange(row.startedAt, row.endedAt, row.open);
      const how = row.open && row.durationS === null ? "ongoing" : fmtDuration(row.durationS);
      if (seg.kind === "stop") {
        const stop = model.stops.find((s) => s.key === key);
        // the other stops of this place (the same gate, the same shop, visited again later), with when
        const others = (model.stopGroups.find((g) => g.stops.some((s) => s.key === key))?.stops ?? [])
          .filter((s) => s.key !== key)
          .map((s) => `Stop ${s.row.stopNumber} (${timeRange(s.row.startedAt, s.row.endedAt, s.row.open)})`);
        const farthest = seg.radiusM > 0 ? `; the farthest was ${Math.round(seg.radiusM)} m from the pin` : "";
        return {
          ...none(),
          heading: `Stop ${row.stopNumber ?? ""}`.trim(),
          chips: [
            row.longStop
              ? { text: "long stop", className: "bg-purple-50 text-purple-700" }
              : { text: "waiting", className: "bg-amber-50 text-amber-800" },
            ...(row.estimated ? [{ text: "estimated", className: "bg-sky-50 text-sky-700" }] : []),
            ...(row.mock ? [{ text: "simulated", className: "bg-red-50 text-red-700" }] : []),
          ],
          title: seg.address || (stop ? fmtCoords(stop.pos[0], stop.pos[1]) : row.title),
          facts: [
            ["Time (IST)", when],
            ["Stayed", how],
            ...(seg.address && stop ? ([["Position", fmtCoords(stop.pos[0], stop.pos[1])]] as [string, string][]) : []),
            ["Positions", `${seg.pointCount} recorded${farthest}`],
            ...(others.length > 0 ? ([["Same place as", others.join(", ")]] as [string, string][]) : []),
          ],
          note: row.estimated
            ? "Part of this stop had no position recorded (the phone could not report): its length is estimated."
            : "",
          pos: stop?.pos ?? null,
        };
      }
      if (seg.kind === "gap") {
        return {
          ...none(),
          heading: "Gap (no location)",
          chips: row.estimated ? [{ text: "estimated", className: "bg-sky-50 text-sky-700" }] : [],
          title: causeLabel(seg.cause || "unknown"),
          facts: [
            ["Time (IST)", when],
            ["Length", how],
          ],
          note: "No position was recorded in this time, so it is drawn as a straight dashed line between the two ends.",
          ends: ends(seg, "Last position before", "First position after"),
        };
      }
      return {
        ...none(),
        heading: "Travel",
        chips: [
          ...(row.estimated ? [{ text: "estimated", className: "bg-sky-50 text-sky-700" }] : []),
          ...(row.mock ? [{ text: "simulated", className: "bg-red-50 text-red-700" }] : []),
        ],
        title: `Travelled ${fmtDistance(seg.distanceM)}`,
        facts: [
          ["Time (IST)", when],
          ["Duration", how],
          ["Average speed", seg.avgSpeedKmh > 0 ? `${Math.round(seg.avgSpeedKmh)} km/h` : "-"],
          ["Top speed", seg.maxSpeedKmh > 0 ? `${Math.round(seg.maxSpeedKmh)} km/h` : "-"],
          ["Positions", String(seg.pointCount)],
        ],
        ends: ends(seg, "From", "To"),
      };
    }
  }
  if (key?.startsWith("ev-")) {
    const ev = model.events.find((e) => e.key === key);
    const row = rows.find((r) => r.key === key);
    if (ev && row) {
      const style = eventStyle(ev.event.kind);
      return {
        ...none(),
        heading: "Event",
        title: style.label,
        facts: [
          ["Time (IST)", timeRange(row.startedAt, row.endedAt, row.open)],
          ...(eventDetail(ev.event) ? ([["Detail", eventDetail(ev.event)]] as [string, string][]) : []),
          ["Last known place", fmtCoords(ev.pos[0], ev.pos[1])],
        ],
        pos: ev.pos,
      };
    }
  }
  // nothing (valid) picked: where the journey is now / ended
  if (model.end) {
    return {
      ...none(),
      heading: active ? "Latest position" : "End of the journey",
      title: fmtCoords(model.end[0], model.end[1]),
      facts: [
        ["Time (IST)", fmtDateTime(detail.track.lastPointAt ?? detail.track.endedAt, true)],
        ["Position", fmtCoords(model.end[0], model.end[1])],
      ],
      note: "Pick a stop, a dot on the route or a row of the timeline to see it here.",
      pos: model.end,
    };
  }
  return none();
}

export default function PlaceDetails({
  detail,
  model,
  rows,
  trail,
  selectedKey,
}: {
  detail: JourneyDetail;
  model: MapModel;
  rows: TimelineRow[];
  trail: TrailModel | null;
  selectedKey: string | null;
}) {
  // Google's map is asked for only when HR turns it on (and the choice is remembered in this browser)
  const [googleOn, setGoogleOn] = useState(() => readGoogleView());
  const info = useMemo(
    () => describeSelection(selectedKey, detail, model, rows, trail),
    [selectedKey, detail, model, rows, trail],
  );

  const toggle = () => {
    saveGoogleView(!googleOn);
    setGoogleOn(!googleOn);
  };

  if (!info.heading) {
    return (
      <Card className="border-0 shadow-sm" data-testid="place-details" data-kind="none">
        <CardContent className="space-y-1 p-4 text-xs text-gray-600">
          <h3 className="flex items-center gap-1.5 text-sm font-bold text-gray-900">
            <MapPin size={14} className="text-[#006496]" /> Place
          </h3>
          <p>No location has been recorded yet. Pick a stop or a dot on the route here once the phone reports.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-0 shadow-sm" data-testid="place-details" data-kind={selectedKey ? "picked" : "latest"}>
      <CardContent className="space-y-3 p-4">
        <div className="space-y-1">
          <h3 className="flex flex-wrap items-center gap-1.5 text-sm font-bold text-gray-900">
            <MapPin size={14} className="shrink-0 text-[#006496]" />
            <span data-testid="place-heading">{info.heading}</span>
            {info.chips.map((c) => (
              <Chip key={c.text} className={c.className}>
                {c.text}
              </Chip>
            ))}
          </h3>
          <p className="break-words text-sm font-semibold text-gray-800" data-testid="place-title">
            {info.title}
          </p>
        </div>

        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs" data-testid="place-facts">
          {info.facts.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-gray-500">{label}</dt>
              <dd className="break-words font-semibold text-gray-900">{value}</dd>
            </div>
          ))}
        </dl>
        {info.note && <p className="text-xs text-gray-500">{info.note}</p>}

        {info.pos && <PlaceLinks lat={info.pos[0]} lng={info.pos[1]} />}
        {info.ends.map((end) => (
          <div key={end.label} className="space-y-1" data-testid="place-end">
            <p className="text-xs text-gray-600">
              {end.label}: <b className="text-gray-900">{fmtCoords(end.pos[0], end.pos[1])}</b>
            </p>
            <PlaceLinks lat={end.pos[0]} lng={end.pos[1]} />
          </div>
        ))}

        {info.pos && (
          <div className="space-y-2 border-t pt-3">
            <button
              type="button"
              onClick={toggle}
              aria-pressed={googleOn}
              data-testid="google-view-toggle"
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#006496] hover:underline"
            >
              {googleOn ? <EyeOff size={13} /> : <Eye size={13} />}
              {googleOn ? "Hide Google Maps view" : "Show Google Maps view"}
            </button>
            {googleOn ? (
              <>
                <iframe
                  key={`${info.pos[0]},${info.pos[1]}`}
                  title="Google Maps view of the place"
                  data-testid="google-view-frame"
                  src={googleEmbedUrl(info.pos[0], info.pos[1], 18)}
                  loading="lazy"
                  referrerPolicy="no-referrer-when-downgrade"
                  className="h-60 w-full rounded-md border border-gray-200"
                />
                <p className="text-[11px] text-gray-500">
                  Google's own map of this place, with its local names, shops and landmarks. It is loaded from Google
                  while it is shown.
                </p>
              </>
            ) : (
              <p className="text-[11px] text-gray-500">
                Shows Google's map of this place (local names, shops, landmarks). Nothing is requested from Google until
                you turn it on.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

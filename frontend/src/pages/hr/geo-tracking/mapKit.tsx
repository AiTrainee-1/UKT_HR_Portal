// Geo Attendance: what the Live Map and the On-Duty Map share. The map's own buttons (Back to Tiruppur, Fit all) live in the card
// header, outside the Leaflet container, so they reach the map through a small bridge placed inside it: MapBridge hands the map
// object to the page, useMapView turns it into the two commands. The map is never locked: these only move the view.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { Map as LeafletMap } from "leaflet";
import { useMap } from "react-leaflet";
import { Crosshair, Maximize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { boundsOf } from "./logic";
import { FIT_MAX_ZOOM, FIT_PADDING, TIRUPPUR_CENTER, TIRUPPUR_ZOOM, type LatLng } from "./tiruppur";

/** Inside a MapContainer: gives the page the map. */
export function MapBridge({ onMap }: { onMap: (map: LeafletMap | null) => void }) {
  const map = useMap() as LeafletMap;
  useEffect(() => {
    onMap(map);
    return () => onMap(null);
  }, [map, onMap]);
  return null;
}

/** Where the map is looking now: Tiruppur, or fitted to a list of places. */
export function viewTiruppur(map: Pick<LeafletMap, "setView">): void {
  map.setView(TIRUPPUR_CENTER, TIRUPPUR_ZOOM);
}

/** Fits the map to some places (one place: centred on it, with its surroundings; none: back to Tiruppur). */
export function viewPlaces(map: Pick<LeafletMap, "setView" | "fitBounds">, places: LatLng[]): void {
  if (places.length === 0) {
    viewTiruppur(map);
    return;
  }
  const bounds = boundsOf(places);
  if (!bounds || (bounds[0][0] === bounds[1][0] && bounds[0][1] === bounds[1][1])) {
    map.setView(places[0], FIT_MAX_ZOOM);
    return;
  }
  map.fitBounds(bounds, { padding: FIT_PADDING, maxZoom: FIT_MAX_ZOOM });
}

/** The two commands of the map's buttons, once the map has been handed over (nothing happens before that). */
export function useMapView() {
  const [map, setMap] = useState<LeafletMap | null>(null);
  const backToTiruppur = useCallback(() => {
    if (map) viewTiruppur(map);
  }, [map]);
  const fit = useCallback(
    (places: LatLng[]) => {
      if (map) viewPlaces(map, places);
    },
    [map],
  );
  return { map, onMap: setMap, backToTiruppur, fit };
}

/** The buttons above a map: back to the Tiruppur window, and fit everything that is on the map. */
export function MapViewButtons({
  onTiruppur,
  onFit,
  fitLabel = "Fit all",
  fitDisabled,
  className,
}: {
  onTiruppur: () => void;
  onFit: () => void;
  fitLabel?: string;
  fitDisabled?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-2", className)} data-testid="map-view-buttons">
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-8 gap-1.5 text-xs"
        onClick={onTiruppur}
        data-testid="map-back-to-tiruppur"
      >
        <Crosshair size={13} /> Back to Tiruppur
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-8 gap-1.5 text-xs"
        onClick={onFit}
        disabled={fitDisabled}
        data-testid="map-fit-all"
      >
        <Maximize2 size={13} /> {fitLabel}
      </Button>
    </div>
  );
}

/** The head of a map card: a title with what it shows, the map's buttons on the right. */
export function MapCardHeader({
  title,
  icon,
  children,
  actions,
}: {
  title: ReactNode;
  icon?: ReactNode;
  /** Chips and captions under the title. */
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-4 py-3">
      <div className="min-w-0 space-y-1">
        <h3 className="flex items-center gap-2 text-sm font-bold text-gray-900">
          {icon}
          {title}
        </h3>
        {children && <div className="flex flex-wrap items-center gap-1.5">{children}</div>}
      </div>
      {actions}
    </div>
  );
}

/** A small note laid over a map (nothing to show here, and why). It lets clicks through to the map. */
export function MapOverlayNote({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div
      className="pointer-events-none absolute inset-0 z-[500] flex items-center justify-center bg-white/60 p-6 text-center"
      data-testid={testId}
    >
      <p className="max-w-xs rounded-xl bg-white px-4 py-3 text-sm text-gray-600 ring-1 ring-gray-200">{children}</p>
    </div>
  );
}

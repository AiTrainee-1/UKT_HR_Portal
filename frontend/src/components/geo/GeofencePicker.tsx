import { MapContainer, TileLayer, Marker, Circle, useMapEvents } from "react-leaflet";
import L from "leaflet";

// A plain colored dot instead of Leaflet's default marker images — those
// break under Vite's asset pipeline unless manually re-pathed, and a dot in
// the app's own brand color reads better here than the default pin anyway.
const pinIcon = L.divIcon({
  className: "",
  html: `<div style="width:18px;height:18px;border-radius:50%;background:#006496;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.45);"></div>`,
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

const INDIA_CENTER: [number, number] = [20.5937, 78.9629];

function ClickHandler({ onPick }: { onPick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onPick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

/**
 * Click-to-place geofence center + drag-to-adjust + a radius ring, backed by
 * OpenStreetMap tiles (no API key / billing account needed, unlike Google
 * Maps — appropriate for this on-premise deployment). The parent must give
 * this a stable `key` per branch being edited (see Branches.tsx) since
 * react-leaflet only reads `center`/`zoom` on first mount, not on prop
 * updates.
 */
export function GeofencePicker({
  lat, lng, radiusM, onPick,
}: {
  lat: number | null;
  lng: number | null;
  radiusM: number;
  onPick: (lat: number, lng: number) => void;
}) {
  const hasLocation = lat != null && lng != null;
  const center: [number, number] = hasLocation ? [lat, lng] : INDIA_CENTER;

  return (
    <div className="rounded-lg overflow-hidden border h-64 relative z-0">
      <MapContainer center={center} zoom={hasLocation ? 16 : 5} style={{ height: "100%", width: "100%" }}>
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution="&copy; OpenStreetMap contributors"
        />
        <ClickHandler onPick={onPick} />
        {hasLocation && (
          <>
            <Marker
              position={[lat, lng]}
              icon={pinIcon}
              draggable
              eventHandlers={{
                dragend: (e) => {
                  const pos = (e.target as L.Marker).getLatLng();
                  onPick(pos.lat, pos.lng);
                },
              }}
            />
            <Circle
              center={[lat, lng]}
              radius={radiusM}
              pathOptions={{ color: "#006496", weight: 2, fillColor: "#4FB8F0", fillOpacity: 0.15 }}
            />
          </>
        )}
      </MapContainer>
      {!hasLocation && (
        <div className="absolute inset-x-0 bottom-2 flex justify-center pointer-events-none">
          <span className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-white/90 shadow text-gray-600">
            Click the map to set this branch's location
          </span>
        </div>
      )}
    </div>
  );
}

export default GeofencePicker;

// Test support: a stand-in for react-leaflet. jsdom cannot draw a map, so a render test replaces the library with plain elements
// that carry what was asked for (the colour, dash and weight of a line, the position and title of a pin) and reports clicks.
// Use it as: vi.mock("react-leaflet", async () => (await import("./leafletMock")).leafletMock);
import type { ReactNode } from "react";
import { vi } from "vitest";

type Handlers = { click?: () => void };

/** What the code asked the map to do (fitBounds, setView): reset it in beforeEach. */
export const mapSpy = {
  fitBounds: vi.fn(),
  setView: vi.fn(),
  getZoom: vi.fn(() => 13),
  addLayer: vi.fn(),
  removeLayer: vi.fn(),
  // what the dots layer asks of a map (jsdom has none to draw)
  getPane: vi.fn(() => document.createElement("div")),
  createPane: vi.fn(() => document.createElement("div")),
  on: vi.fn(),
  off: vi.fn(),
  latLngToContainerPoint: vi.fn(() => ({ x: 0, y: 0 })),
  getContainer: vi.fn(() => document.createElement("div")),
  invalidateSize: vi.fn(),
};

/** The handlers a component gave to useMapEvents: a test calls one to play a map event (e.g. baselayerchange). */
export const mapEvents: { current: Record<string, (e: { name: string }) => void> } = { current: {} };

export const resetMap = () => {
  mapSpy.fitBounds.mockClear();
  mapSpy.setView.mockClear();
};

const htmlOf = (icon: unknown): string => (icon as { options?: { html?: string } } | undefined)?.options?.html ?? "";
const pinOf = (icon: unknown): string => /data-pin="(\w+)"/.exec(htmlOf(icon))?.[1] ?? "";
/** The colour a pin is filled with: a round pin's background, or the body of a teardrop pin. */
const colorOf = (icon: unknown): string => /(?:background:|fill=")(#[0-9a-fA-F]{6})/.exec(htmlOf(icon))?.[1] ?? "";

export const leafletMock = {
  MapContainer: ({ children, center, zoom }: { children?: ReactNode; center?: [number, number]; zoom?: number }) => (
    <div data-testid="leaflet-map" data-center={JSON.stringify(center)} data-zoom={zoom}>
      {children}
    </div>
  ),
  TileLayer: ({ url, attribution }: { url?: string; attribution?: string }) => (
    <div data-testid="tile-layer" data-url={url} data-attribution={attribution} />
  ),
  LayerGroup: ({ children }: { children?: ReactNode }) => <div data-testid="layer-group">{children}</div>,
  LayersControl: Object.assign(
    ({ children }: { children?: ReactNode }) => <div data-testid="layers-control">{children}</div>,
    {
      BaseLayer: ({ name, checked, children }: { name: string; checked?: boolean; children?: ReactNode }) => (
        <div data-testid="base-layer" data-name={name} data-checked={String(Boolean(checked))}>
          {children}
        </div>
      ),
    },
  ),
  Polyline: ({
    positions,
    pathOptions,
    eventHandlers,
    interactive,
  }: {
    positions: [number, number][];
    pathOptions?: { color?: string; weight?: number; dashArray?: string };
    eventHandlers?: Handlers;
    interactive?: boolean;
  }) => (
    <div
      // a line that cannot be clicked is a stretch of the route trail, not a travel or a gap
      data-testid={interactive === false ? "trail-run" : "polyline"}
      data-color={pathOptions?.color}
      data-weight={pathOptions?.weight}
      data-dash={pathOptions?.dashArray ?? ""}
      data-points={positions.length}
      onClick={() => eventHandlers?.click?.()}
    />
  ),
  Circle: ({ radius }: { radius: number }) => <div data-testid="circle" data-radius={radius} />,
  CircleMarker: ({ center, children }: { center: [number, number]; children?: ReactNode }) => (
    <div data-testid="circle-marker" data-lat={center[0]} data-lng={center[1]}>
      {children}
    </div>
  ),
  Marker: ({
    position,
    icon,
    title,
    eventHandlers,
    children,
  }: {
    position: [number, number];
    icon?: unknown;
    title?: string;
    eventHandlers?: Handlers;
    children?: ReactNode;
  }) => (
    <div
      data-testid="marker"
      data-pin={pinOf(icon)}
      data-color={colorOf(icon)}
      data-title={title}
      data-lat={position[0]}
      data-lng={position[1]}
      onClick={() => eventHandlers?.click?.()}
    >
      {children}
    </div>
  ),
  Popup: ({ children }: { children?: ReactNode }) => <div data-testid="popup">{children}</div>,
  useMap: () => mapSpy,
  useMapEvents: (handlers: Record<string, (e: { name: string }) => void>) => {
    mapEvents.current = handlers;
    return mapSpy;
  },
};

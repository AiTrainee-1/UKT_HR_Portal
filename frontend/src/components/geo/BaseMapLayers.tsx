import { useState } from "react";
import { LayerGroup, LayersControl, TileLayer, useMapEvents } from "react-leaflet";
import { BASE_LAYERS, MAX_ZOOM, baseLayerIdForName, readBaseLayer, saveBaseLayer } from "./baseLayers";

/**
 * The base map of every Leaflet map in the portal, with a switch (top right) between the street map, the satellite view and the
 * satellite view with road and area names. It replaces a lone <TileLayer> inside a <MapContainer>. The choice is remembered in
 * this browser, so the next map opens on the one that was used last.
 */
export function BaseMapLayers() {
  // react-leaflet reads `checked` only when the layer is built, so the saved choice is read once
  const [initial] = useState(() => readBaseLayer());

  useMapEvents({
    baselayerchange: (e) => {
      const id = baseLayerIdForName(e.name);
      if (id) saveBaseLayer(id);
    },
  });

  return (
    <LayersControl position="topright">
      {BASE_LAYERS.map((layer) => (
        <LayersControl.BaseLayer key={layer.id} name={layer.label} checked={layer.id === initial}>
          <LayerGroup>
            {layer.tiles.map((tile, i) => (
              <TileLayer
                key={tile.url}
                url={tile.url}
                attribution={tile.attribution}
                maxZoom={tile.maxZoom ?? MAX_ZOOM}
                maxNativeZoom={tile.maxNativeZoom}
                zIndex={i + 1}
              />
            ))}
          </LayerGroup>
        </LayersControl.BaseLayer>
      ))}
    </LayersControl>
  );
}

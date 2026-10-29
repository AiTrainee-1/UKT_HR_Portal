// Journey History: what HR can do with a place (a stop, a recorded position, a pin): open it in Google Maps, get directions to it,
// or copy its coordinates. Used in the map popups, in the details panel and (as one icon) in the timeline.
import { useState, type MouseEvent } from "react";
import { Check, Copy, ExternalLink, Navigation } from "lucide-react";
import { cn } from "@/lib/utils";
import { coordsText, googleDirectionsUrl, googleMapsUrl } from "./mapLinks";

const BUTTON =
  "inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-[11px] font-semibold text-[#006496] hover:bg-gray-50";

export function PlaceLinks({
  lat,
  lng,
  compact = false,
  className,
}: {
  lat: number;
  lng: number;
  /** One small icon (the timeline row): "Open in Google Maps" only. */
  compact?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const stop = (e: MouseEvent) => e.stopPropagation();

  if (compact) {
    return (
      <a
        href={googleMapsUrl(lat, lng)}
        target="_blank"
        rel="noopener noreferrer"
        title="Open in Google Maps"
        aria-label="Open this place in Google Maps"
        data-testid="open-google-maps"
        onClick={stop}
        className={cn("inline-flex items-center text-[#006496] hover:text-sky-800", className)}
      >
        <ExternalLink size={13} />
      </a>
    );
  }

  const copy = async (e: MouseEvent) => {
    stop(e);
    try {
      await navigator.clipboard.writeText(coordsText(lat, lng));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // the clipboard is not available (an old browser, an insecure page): the coordinates are shown next to the buttons
    }
  };

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)} data-testid="place-links">
      <a
        href={googleMapsUrl(lat, lng)}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="open-google-maps"
        onClick={stop}
        className={BUTTON}
      >
        <ExternalLink size={11} /> Open in Google Maps
      </a>
      <a
        href={googleDirectionsUrl(lat, lng)}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="google-directions"
        onClick={stop}
        className={BUTTON}
      >
        <Navigation size={11} /> Directions
      </a>
      <button type="button" data-testid="copy-coords" onClick={(e) => void copy(e)} className={BUTTON}>
        {copied ? <Check size={11} /> : <Copy size={11} />} {copied ? "Copied" : "Copy coordinates"}
      </button>
    </div>
  );
}

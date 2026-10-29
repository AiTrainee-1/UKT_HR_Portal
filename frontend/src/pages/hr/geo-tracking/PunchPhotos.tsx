// Punch Verifications: the photos of one On-Duty punch. An On-Duty punch takes one photo, or two (Photo 1 and Photo 2) once HR
// switched the rule to two. Both are shown as thumbnails; a click enlarges one. The photos are behind the login, so each is
// fetched with the person's own token and shown from a temporary object URL (revoked when the dialog closes).
import { useEffect, useState } from "react";
import { Camera, ImageOff, Maximize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/contexts/AuthContext";
import { fetchAuthedImageObjectUrl, type OnDutyPunchVerificationItem } from "@/lib/api-client/custom-hooks";

type Loaded = { status: "loading" | "ready" | "error"; src: string | null };

/** The address of photo 1 or 2 of a punch. */
export const photoUrl = (verificationId: number, n: 1 | 2): string =>
  `/api/on-duty-punch-verifications/${verificationId}/photo${n === 2 ? "?n=2" : ""}`;

function useAuthedImage(url: string | null): Loaded {
  const { token } = useAuth();
  const [state, setState] = useState<Loaded>({ status: "loading", src: null });
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    setState({ status: "loading", src: null });
    fetchAuthedImageObjectUrl(url, () => token)
      .then((made) => {
        if (cancelled) URL.revokeObjectURL(made);
        else {
          objectUrl = made;
          setState({ status: "ready", src: made });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error", src: null });
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url, token]);
  return state;
}

function Tile({
  url,
  label,
  enlarged,
  onToggle,
}: {
  url: string;
  label: string;
  enlarged: boolean;
  onToggle: () => void;
}) {
  const image = useAuthedImage(url);
  return (
    <figure className="space-y-2" data-testid="punch-photo" data-label={label}>
      <figcaption className="text-xs font-bold text-gray-700">{label}</figcaption>
      {image.status === "loading" ? (
        <Skeleton className={enlarged ? "h-[60vh] rounded-xl" : "h-56 rounded-xl"} />
      ) : image.src ? (
        <button
          type="button"
          onClick={onToggle}
          aria-label={enlarged ? `Back to the photos (${label})` : `Enlarge ${label}`}
          className="group relative block w-full overflow-hidden rounded-xl border bg-slate-50 transition-colors hover:border-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
        >
          <img
            src={image.src}
            alt={`${label} of the punch`}
            className={enlarged ? "max-h-[70vh] w-full object-contain" : "h-56 w-full cursor-zoom-in object-cover"}
          />
          {!enlarged && (
            <span
              aria-hidden
              className="pointer-events-none absolute right-2 top-2 inline-flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold text-white opacity-90 group-hover:opacity-100"
            >
              <Maximize2 size={10} /> Enlarge
            </span>
          )}
        </button>
      ) : (
        <div
          className="flex h-56 flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed bg-slate-50 text-xs text-gray-500"
          data-testid="punch-photo-error"
        >
          <ImageOff size={18} className="text-gray-300" aria-hidden />
          {label} could not be loaded
        </div>
      )}
    </figure>
  );
}

export default function PunchPhotosDialog({
  verification,
  onClose,
}: {
  verification: OnDutyPunchVerificationItem | null;
  onClose: () => void;
}) {
  const [enlarged, setEnlarged] = useState<1 | 2 | null>(null);
  // a different punch starts from the thumbnails
  useEffect(() => setEnlarged(null), [verification?.id]);

  const two = verification?.hasPhoto2 === true;
  return (
    <Dialog open={verification !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={two && enlarged === null ? "max-w-3xl" : "max-w-2xl"}>
        <DialogHeader className="space-y-1 text-left">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Camera size={16} className="text-[#006496]" /> Punch verification {two ? "photos" : "photo"}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {verification
              ? `${verification.employeeName}, punch #${verification.punchNumber} (${verification.punchType === "IN" ? "check-in" : "check-out"}) at ${verification.punchTime.slice(0, 5)}`
              : ""}
          </DialogDescription>
        </DialogHeader>
        {verification &&
          (verification.hasPhoto || two ? (
            <div className="space-y-3">
              {enlarged !== null && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => setEnlarged(null)}
                  data-testid="photos-back"
                >
                  Back to the photos
                </Button>
              )}
              <div className={two && enlarged === null ? "grid gap-3 sm:grid-cols-2" : "grid gap-3"}>
                {(enlarged === null || enlarged === 1) && verification.hasPhoto && (
                  <Tile
                    url={photoUrl(verification.id, 1)}
                    label={two ? "Photo 1" : "Photo"}
                    enlarged={enlarged === 1}
                    onToggle={() => setEnlarged(enlarged === 1 ? null : 1)}
                  />
                )}
                {(enlarged === null || enlarged === 2) && two && (
                  <Tile
                    url={photoUrl(verification.id, 2)}
                    label="Photo 2"
                    enlarged={enlarged === 2}
                    onToggle={() => setEnlarged(enlarged === 2 ? null : 2)}
                  />
                )}
              </div>
              {enlarged === null && <p className="text-xs text-gray-500">Click a photo to enlarge it.</p>}
            </div>
          ) : (
            <p
              className="flex flex-col items-center gap-2 rounded-xl border border-dashed bg-slate-50 px-3 py-10 text-center text-sm text-gray-500"
              data-testid="no-photo"
            >
              <ImageOff size={22} className="text-gray-300" aria-hidden />
              No photo was taken at this punch.
            </p>
          ))}
      </DialogContent>
    </Dialog>
  );
}

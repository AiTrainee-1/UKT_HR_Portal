import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, Loader2, RefreshCw, Trash2, Upload, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { compressImageToDataUrl } from "@/lib/image-compression";
import { cn } from "@/lib/utils";

const SIZE = 480; // the saved photo is a SIZE x SIZE square: plenty for an ID card, small enough to store

/** Why the camera did not open, in words a person can act on. */
export function cameraErrorMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "The browser blocked the camera. Allow it for this site (the camera icon in the address bar), then try again.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No camera was found on this computer.";
  if (name === "NotReadableError" || name === "AbortError") {
    return "The camera is being used by another program. Close it and try again.";
  }
  return "The camera could not be opened.";
}

/** A square crop of the video's centre, as a JPEG data URL. */
export function captureFrame(video: HTMLVideoElement): string {
  const side = Math.min(video.videoWidth, video.videoHeight);
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Image processing isn't supported in this browser.");
  const sx = (video.videoWidth - side) / 2;
  const sy = (video.videoHeight - side) / 2;
  ctx.drawImage(video, sx, sy, side, side, 0, 0, SIZE, SIZE);
  return canvas.toDataURL("image/jpeg", 0.85);
}

/**
 * Take a person's photo with the computer's camera, or upload one. The photo is handed back as a JPEG data URL, the
 * same form every other photo in the HRMS is kept in.
 *
 * The camera needs a secure page (https, or localhost): on plain http browsers refuse it, and this says so and offers
 * the upload instead.
 */
export default function CameraCapture({
  value,
  onChange,
  disabled,
}: {
  value: string | null;
  onChange: (dataUrl: string | null) => void;
  disabled?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [state, setState] = useState<"idle" | "starting" | "live">("idle");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);
  // Closing the dialog while the camera is still starting must not leave it on: remember whether we are still here
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stop();
    };
  }, [stop]);

  // the <video> only exists once the state is "live": attach the stream then
  useEffect(() => {
    if (state === "live" && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
      void videoRef.current.play().catch(() => undefined);
    }
  }, [state]);

  const open = async () => {
    setError("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("This browser cannot open a camera on this page (it needs https or localhost). Upload a photo instead.");
      return;
    }
    setState("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 720 }, height: { ideal: 720 } },
        audio: false,
      });
      if (!mounted.current) {
        // the dialog was closed while the browser was still opening the camera: switch it straight back off
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      setState("live");
    } catch (e) {
      if (!mounted.current) return;
      setError(cameraErrorMessage(e));
      setState("idle");
    }
  };

  const capture = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) {
      setError("The camera has not started showing yet. Wait a second and try again.");
      return;
    }
    try {
      onChange(captureFrame(video));
      stop();
      setState("idle");
    } catch (e) {
      setError(e instanceof Error ? e.message : "The photo could not be taken.");
    }
  };

  const cancel = () => {
    stop();
    setState("idle");
  };

  const upload = async (file: File) => {
    setBusy(true);
    setError("");
    try {
      onChange(
        await compressImageToDataUrl(file, { maxWidth: SIZE, maxHeight: SIZE, format: "image/jpeg", quality: 0.85 }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "That image could not be used.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-start gap-4" data-testid="photo-capture">
      <div
        className={cn(
          "relative h-40 w-40 shrink-0 overflow-hidden rounded-2xl border bg-slate-50",
          state === "live" && "ring-2 ring-[#006496]/40",
        )}
      >
        {state === "live" ? (
          <video
            ref={videoRef}
            muted
            playsInline
            className="h-full w-full -scale-x-100 object-cover"
            data-testid="photo-video"
          />
        ) : value ? (
          <img src={value} alt="Captured" className="h-full w-full object-cover" data-testid="photo-preview" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-slate-300">
            {state === "starting" || busy ? <Loader2 size={28} className="animate-spin" /> : <User size={44} />}
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1 space-y-2">
        {state === "live" ? (
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" className="gap-1.5" onClick={capture} data-testid="photo-capture-button">
              <Camera size={14} /> Take the photo
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={cancel}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={open}
              disabled={disabled || state === "starting"}
              data-testid="photo-open-camera"
            >
              {value ? <RefreshCw size={14} /> : <Camera size={14} />} {value ? "Take again" : "Use the camera"}
            </Button>
            <label
              className={cn(
                "inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-md border bg-white px-3 text-sm font-medium hover:bg-slate-50",
                (disabled || busy) && "pointer-events-none opacity-50",
              )}
            >
              <Upload size={14} /> Choose a photo
              <input
                type="file"
                accept="image/*"
                className="hidden"
                disabled={disabled || busy}
                data-testid="photo-upload-input"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void upload(file);
                  e.target.value = "";
                }}
              />
            </label>
            {value && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="gap-1.5 text-red-600 hover:text-red-700"
                onClick={() => onChange(null)}
                data-testid="photo-remove"
              >
                <Trash2 size={14} /> Remove
              </Button>
            )}
          </div>
        )}
        {error && (
          <p className="text-xs leading-snug text-red-600" role="alert" data-testid="photo-error">
            {error}
          </p>
        )}
        <p className="text-[11px] leading-snug text-slate-400">
          Look straight at the camera in good light. The photo is cropped to a square.
        </p>
      </div>
    </div>
  );
}

import { useState } from "react";
import { Upload, X, User, Loader2 } from "lucide-react";
import { compressImageToDataUrl } from "@/lib/image-compression";
import { useToast } from "@/hooks/use-toast";

/**
 * Circular profile-photo uploader. Stores the image as a base64 data URL,
 * consistent with how Settings stores the company logo/signature -no file
 * server needed. Used for employee profile photos across the HR portal.
 *
 * Every upload is automatically resized/re-encoded (JPEG, no transparency
 * needed for a photo) before it ever becomes a data URL -large phone-camera
 * photos used to go in at full resolution, which could trip the backend's
 * request-size limit; this compresses in the background with no action
 * needed from HR, the same fix applied to Settings' logo/signature uploads.
 */
export default function PhotoUpload({
  value,
  onChange,
  size = 96,
}: {
  value: string | null | undefined;
  onChange: (dataUrl: string | null) => void;
  size?: number;
}) {
  const { toast } = useToast();
  const [compressing, setCompressing] = useState(false);

  const handleFile = async (file: File) => {
    setCompressing(true);
    try {
      const dataUrl = await compressImageToDataUrl(file, { maxWidth: 640, maxHeight: 640, format: "image/jpeg", quality: 0.85 });
      onChange(dataUrl);
    } catch (err) {
      toast({ title: "Couldn't process that image", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally {
      setCompressing(false);
    }
  };

  return (
    <div className="flex items-center gap-4">
      <div
        className="relative rounded-full overflow-hidden border-2 border-gray-200 bg-gray-50 flex items-center justify-center shrink-0"
        style={{ width: size, height: size }}
      >
        {compressing ? (
          <Loader2 size={size * 0.35} className="text-gray-300 animate-spin" />
        ) : value ? (
          <img src={value} alt="Profile" className="w-full h-full object-cover" />
        ) : (
          <User size={size * 0.45} className="text-gray-300" />
        )}
      </div>
      <div className="space-y-1.5">
        <label className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border cursor-pointer hover:bg-gray-50 transition-colors">
          <Upload size={12} />
          {value ? "Change Photo" : "Upload Photo"}
          <input
            type="file"
            accept="image/*"
            className="hidden"
            disabled={compressing}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
              e.target.value = "";
            }}
          />
        </label>
        {value && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="flex items-center gap-1 text-xs text-red-500 hover:text-red-600"
          >
            <X size={11} /> Remove
          </button>
        )}
        <p className="text-[11px] text-gray-400">JPG or PNG, square photo recommended.</p>
      </div>
    </div>
  );
}

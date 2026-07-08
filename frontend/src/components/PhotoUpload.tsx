import { Upload, X, User } from "lucide-react";

/**
 * Circular profile-photo uploader. Stores the image as a base64 data URL,
 * consistent with how Settings stores the company logo/signature — no file
 * server needed. Used for employee profile photos across the HR portal.
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
  const handleFile = (file: File) => {
    if (!file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = (ev) => onChange(ev.target?.result as string);
    reader.readAsDataURL(file);
  };

  return (
    <div className="flex items-center gap-4">
      <div
        className="relative rounded-full overflow-hidden border-2 border-gray-200 bg-gray-50 flex items-center justify-center shrink-0"
        style={{ width: size, height: size }}
      >
        {value ? (
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

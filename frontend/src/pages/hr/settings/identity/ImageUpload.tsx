import { useId } from "react";
import { Upload, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { compressImageToDataUrl } from "@/lib/image-compression";
import { cn } from "@/lib/utils";

// Logo / signature uploads are compressed with compressImageToDataUrl before they become the base64 data URI sent in
// the JSON PUT (see config/settings.py DATA_UPLOAD_MAX_MEMORY_SIZE), so a large photo of a signature never trips the
// request-size limit. PNG keeps the transparency a logo or signature needs.

/**
 * One image setting (a logo or a signature): the picture with a Remove button, or an "Upload" box when there is none.
 * Removing only clears the form; the parent sends `null` on Save, which is how the server learns it was removed.
 */
export function ImageUpload({
  value,
  onChange,
  noun,
  disabled,
  tall = false,
  id,
}: {
  value: string | null | undefined;
  onChange: (next: string | null) => void;
  /** What it is, in lower case: "logo", "signature". Names the buttons ("Remove logo"). */
  noun: string;
  disabled?: boolean;
  tall?: boolean;
  id?: string;
}) {
  const { toast } = useToast();
  const autoId = useId();
  const inputId = id ?? `upload-${autoId}`;

  const pick = async (file: File | undefined) => {
    if (!file) return;
    try {
      onChange(await compressImageToDataUrl(file, { maxWidth: 600, maxHeight: 600 }));
    } catch (err) {
      toast({
        title: "Couldn't process that image",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    }
  };

  const file = (
    <input
      id={inputId}
      type="file"
      accept="image/*"
      className="hidden"
      disabled={disabled}
      data-testid={`${inputId}-file`}
      onChange={(e) => {
        void pick(e.target.files?.[0]);
        e.target.value = "";
      }}
    />
  );

  if (!value) {
    return (
      <label
        htmlFor={inputId}
        className={cn(
          "flex w-44 flex-col items-center justify-center rounded-lg border-2 border-dashed border-gray-300 transition-colors",
          tall ? "h-24" : "h-20",
          disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:border-blue-400 hover:bg-blue-50",
        )}
      >
        <Upload size={18} className="mb-1 text-gray-400" />
        <span className="text-xs text-gray-500">Upload {noun}</span>
        {file}
      </label>
    );
  }

  return (
    <div className="flex items-start gap-3">
      <div className="relative">
        <img
          src={value}
          alt={`Saved ${noun}`}
          className={cn("rounded-lg border border-gray-200 bg-white object-contain p-2", tall ? "h-24" : "h-20")}
        />
        <button
          type="button"
          aria-label={`Remove ${noun}`}
          title={`Remove ${noun}`}
          disabled={disabled}
          onClick={() => onChange(null)}
          className="absolute -right-2 -top-2 rounded-full bg-red-500 p-0.5 text-white disabled:opacity-50"
        >
          <X size={12} />
        </button>
      </div>
      <label
        htmlFor={inputId}
        className={cn(
          "mt-1 inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-semibold text-slate-700",
          disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-slate-100",
        )}
      >
        <Upload size={12} /> Replace {noun}
        {file}
      </label>
    </div>
  );
}

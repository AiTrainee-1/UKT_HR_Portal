/**
 * Client-side image resize/re-encode (Canvas API, no dependency) so an
 * uploaded image stays well under the backend's request-size limit before
 * it's ever turned into a base64 data URL -every image upload in this app
 * (company logo/signature in Settings, employee profile photos) goes into
 * a JSON body as base64 text, not a multipart file upload, so an
 * unreasonably large source image can otherwise trip Django's
 * DATA_UPLOAD_MAX_MEMORY_SIZE guard with a bare, unhelpful 400 (see
 * config/settings.py's own comment on that setting for the incident this
 * came from). Runs automatically, with no size-based rejection for any
 * normal photo -only a generous sanity ceiling on the raw file even being
 * read at all.
 */

export const MAX_RAW_UPLOAD_BYTES = 25 * 1024 * 1024; // sanity ceiling before we even try to decode

export interface CompressImageOptions {
  maxWidth?: number;
  maxHeight?: number;
  /** 0-1, JPEG only -PNG is always lossless at whatever dimensions are chosen. */
  quality?: number;
  /** PNG (default) preserves transparency, which logos/signatures often need.
   *  Use JPEG for photographic content (employee photos) -no transparency
   *  needed there, and JPEG compresses photos far better than PNG does. */
  format?: "image/png" | "image/jpeg";
}

/**
 * Resize `file` to fit within maxWidth x maxHeight (preserving aspect ratio,
 * never upscaling) and re-encode it, returning a base64 data URL. Rejects
 * only if the file isn't an image, can't be decoded, or exceeds
 * MAX_RAW_UPLOAD_BYTES outright -every other size is handled by resizing.
 */
export function compressImageToDataUrl(file: File, options: CompressImageOptions = {}): Promise<string> {
  const { maxWidth = 800, maxHeight = 800, quality = 0.85, format = "image/png" } = options;

  if (!file.type.startsWith("image/")) {
    return Promise.reject(new Error("Please select an image file."));
  }
  if (file.size > MAX_RAW_UPLOAD_BYTES) {
    return Promise.reject(new Error("That file is too large to process (over 25 MB)."));
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the file."));
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => reject(new Error("Could not decode the image."));
      img.onload = () => {
        const ratio = Math.min(1, maxWidth / img.width, maxHeight / img.height);
        const width = Math.max(1, Math.round(img.width * ratio));
        const height = Math.max(1, Math.round(img.height * ratio));

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Image processing isn't supported in this browser."));
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        resolve(format === "image/jpeg" ? canvas.toDataURL(format, quality) : canvas.toDataURL(format));
      };
      img.src = e.target?.result as string;
    };
    reader.readAsDataURL(file);
  });
}

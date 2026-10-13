import { useEffect, useState } from "react";

/** The PDF builders draw a logo into a box this shape (2.6 cm x 1.5 cm) without keeping the picture's own proportions. */
export const LOGO_BOX_RATIO = 2.6 / 1.5;

/**
 * How badly a logo of `width` x `height` pixels is distorted by the fixed letter / salary slip logo box: 1 means it fits
 * exactly, 1.7 means it is stretched or squashed by 70% in one direction. A logo about 1.7 : 1 (wide) prints undistorted.
 */
export function logoDistortion(width: number, height: number): number {
  if (!(width > 0) || !(height > 0)) return 1;
  const ratio = width / height;
  return Math.max(LOGO_BOX_RATIO / ratio, ratio / LOGO_BOX_RATIO);
}

/** What the fixed letter / slip logo box does to a logo of this shape, in words. */
export function logoFitText(width: number, height: number): { text: string; tone: "good" | "warn" } {
  const factor = logoDistortion(width, height);
  if (factor <= 1.1) return { text: "Prints true to its shape", tone: "good" };
  const widened = width / height < LOGO_BOX_RATIO;
  return {
    text: widened
      ? `Prints squashed: ${factor.toFixed(1)} times wider than it really is`
      : `Prints stretched: ${factor.toFixed(1)} times taller than it really is`,
    tone: "warn",
  };
}

/** Natural size of an image given as a data URL, once the browser has decoded it (null before that or if it is unreadable). */
export function useImageSize(src: string | null | undefined): { width: number; height: number } | null {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    if (!src) {
      setSize(null);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled) setSize({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      if (!cancelled) setSize(null);
    };
    img.src = src;
    return () => {
      cancelled = true;
    };
  }, [src]);
  return size;
}

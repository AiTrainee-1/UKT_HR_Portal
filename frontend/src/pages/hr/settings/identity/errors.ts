import { ApiError } from "@/lib/api-client/custom-fetch";

/** The server's own words for a failed save ("message", else "error"), else the error's text. */
export function errorText(e: unknown): string | undefined {
  if (e instanceof ApiError && e.data && typeof e.data === "object") {
    const data = e.data as Record<string, unknown>;
    if (typeof data.message === "string" && data.message) return data.message;
    if (typeof data.error === "string" && data.error) return data.error;
  }
  return e instanceof Error ? e.message : undefined;
}

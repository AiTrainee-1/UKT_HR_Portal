/**
 * Global connectivity state — set by the shared fetch layer (custom-fetch.ts)
 * whenever a request fails at the network level (backend/server/domain
 * unreachable) or the backend reports its database is down. Read anywhere
 * via useConnectivity(); ConnectivityOverlay renders the full-screen takeover
 * when offline, mounted once at the app root so it works regardless of which
 * page is active.
 */

export type OfflineReason = "network" | "database" | null;

let reason: OfflineReason = null;
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

export function markOffline(next: Exclude<OfflineReason, null>) {
  // "database" is a more specific diagnosis than a generic network failure —
  // don't let a later generic network error downgrade it.
  if (reason === "database" && next === "network") return;
  if (reason === next) return;
  reason = next;
  notify();
}

export function markOnline() {
  if (reason === null) return;
  reason = null;
  notify();
}

export function getOfflineReason(): OfflineReason {
  return reason;
}

export function subscribeConnectivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

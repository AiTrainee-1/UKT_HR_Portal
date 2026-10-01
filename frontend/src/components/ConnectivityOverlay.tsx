import * as React from "react";
import { WifiOff, Database, RefreshCw } from "lucide-react";
import SupportContactCard from "@/components/SupportContactCard";
import { ConnectionPath, StatusActions, StatusButton, StatusScreen } from "@/components/status/StatusScreen";
import { useSupportContact } from "@/lib/api-client/custom-hooks";
import { customFetch } from "@/lib/api-client/custom-fetch";
import { getOfflineReason, subscribeConnectivity, markOnline, type OfflineReason } from "@/lib/connectivity";

const POLL_INTERVAL_MS = 4000;

type NodeState = "ok" | "bad" | "unknown";

const COPY: Record<
  Exclude<OfflineReason, null>,
  {
    icon: typeof WifiOff;
    badge: string;
    title: string;
    description: string;
    component: string;
    path: Record<"device" | "network" | "server" | "database", NodeState>;
  }
> = {
  network: {
    icon: WifiOff,
    badge: "Connection lost",
    title: "Can't Reach the Server",
    description:
      "We can't connect to the UKTextiles server right now. The server may be offline, your network may have dropped, or the domain is temporarily unreachable. We'll reconnect on our own the moment it's back.",
    component: "Backend / Network",
    path: { device: "ok", network: "bad", server: "unknown", database: "unknown" },
  },
  database: {
    icon: Database,
    badge: "Database unavailable",
    title: "Database Server Offline",
    description:
      "The application server is reachable, but its database is down, so no data can be loaded right now. We'll reconnect on our own once the database is back online.",
    component: "PostgreSQL (On-Premise)",
    path: { device: "ok", network: "ok", server: "ok", database: "bad" },
  },
};

/**
 * Full-screen takeover shown whenever the backend/server/domain is
 * unreachable, or the backend reports its database is down. Mounted once at
 * the app root (App.tsx) so it activates regardless of which page is open —
 * every API failure of this kind is detected centrally in custom-fetch.ts.
 * Auto-recovers: polls /api/healthz in the background and dismisses itself
 * the moment the server responds again.
 */
export default function ConnectivityOverlay() {
  // Mounted on every page, so this also keeps the Software Support contact (Settings -> HR Contact) up to date on
  // this device -it is shown below when the server can't be reached, which is when it could no longer be fetched.
  useSupportContact();
  const [reason, setReason] = React.useState<OfflineReason>(getOfflineReason());
  const [checking, setChecking] = React.useState(false);
  const [lastCheckedAt, setLastCheckedAt] = React.useState<Date | null>(null);
  const [attempts, setAttempts] = React.useState(0);
  const [nextIn, setNextIn] = React.useState(POLL_INTERVAL_MS / 1000);

  React.useEffect(() => subscribeConnectivity(() => setReason(getOfflineReason())), []);

  const checkNow = React.useCallback(async () => {
    setChecking(true);
    try {
      // /api/healthz deliberately bypasses the DB check (so it stays up even
      // when the database is down -useful for infra monitoring, wrong for
      // us here). To confirm the database is actually back, poll an endpoint
      // that touches it instead; DatabaseHealthMiddleware intercepts that
      // with a 503 for every path except /api/healthz.
      const probe = getOfflineReason() === "database" ? "/api/departments" : "/api/healthz";
      await customFetch(probe);
      // A successful call already triggers markOnline() inside customFetch,
      // which updates `reason` via the subscription above.
    } catch {
      // Still down -the interceptor already recorded why.
    } finally {
      setChecking(false);
      setAttempts((n) => n + 1);
      setLastCheckedAt(new Date());
    }
  }, []);

  React.useEffect(() => {
    if (!reason) return;
    const interval = setInterval(checkNow, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [reason, checkNow]);

  // The visible countdown to the next automatic check restarts after every check.
  React.useEffect(() => {
    if (!reason) return;
    setNextIn(POLL_INTERVAL_MS / 1000);
    const tick = setInterval(() => setNextIn((n) => Math.max(0, n - 1)), 1000);
    return () => clearInterval(tick);
  }, [reason, lastCheckedAt]);

  if (!reason) return null;

  const copy = COPY[reason];

  return (
    <StatusScreen
      overlay
      tone="danger"
      icon={copy.icon}
      badge={copy.badge}
      title={copy.title}
      description={copy.description}
      above={<ConnectionPath states={copy.path} />}
      details={[
        { label: "Application", value: "UKTextiles HR & ERP" },
        { label: "Component", value: copy.component, tone: "bad" },
        { label: "Status", value: "Unreachable", tone: "bad" },
        { label: "Checks so far", value: attempts },
        { label: "Last checked", value: lastCheckedAt ? lastCheckedAt.toLocaleTimeString("en-IN") : "—" },
      ]}
    >
      {/* Who to contact: the Software Support details HR set in Settings -> HR Contact */}
      <SupportContactCard situation="server" tone="dark" className="mb-3" />

      <StatusActions>
        <StatusButton onClick={checkNow} disabled={checking} icon={RefreshCw}>
          {checking ? "Checking connection…" : "Retry now"}
        </StatusButton>
      </StatusActions>

      <div className="ss-check" aria-live="polite">
        <div className="ss-check-row">
          <span>{checking ? "Checking…" : `Next automatic check in ${nextIn}s`}</span>
          <span>This screen closes itself once reconnected</span>
        </div>
        <div className="ss-check-bar">
          <i key={lastCheckedAt?.getTime() ?? 0} style={{ ["--ss-interval" as string]: `${POLL_INTERVAL_MS}ms` }} />
        </div>
      </div>
    </StatusScreen>
  );
}

// Exported for tests / manual dismissal from dev tools if ever needed.
export { markOnline as dismissConnectivityOverlay };

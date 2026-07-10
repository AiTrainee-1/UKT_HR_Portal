import * as React from "react";
import { WifiOff, Database, RefreshCw, Phone, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { customFetch } from "@/lib/api-client/custom-fetch";
import { getOfflineReason, subscribeConnectivity, markOnline, type OfflineReason } from "@/lib/connectivity";

const POLL_INTERVAL_MS = 4000;

const COPY: Record<Exclude<OfflineReason, null>, {
  icon: typeof WifiOff;
  badge: string;
  title: string;
  description: string;
  contacts: string[];
  statusRows: { label: string; value: string }[];
}> = {
  network: {
    icon: WifiOff,
    badge: "Connection Lost",
    title: "Can't Reach the Server",
    description:
      "We can't connect to the UKTextiles server right now — this usually means the server is offline, the network connection dropped, or the domain is temporarily unreachable. We'll reconnect automatically as soon as it's back.",
    contacts: ["Contact your Server Team", "Contact your Backend Team"],
    statusRows: [
      { label: "Component", value: "Backend / Network" },
      { label: "Status", value: "Unreachable" },
    ],
  },
  database: {
    icon: Database,
    badge: "Database Unavailable",
    title: "Database Server Offline",
    description:
      "The application server is reachable, but its database is currently unavailable. Data cannot be retrieved right now. We'll reconnect automatically once the database is back online.",
    contacts: ["Contact your Database Management Team"],
    statusRows: [
      { label: "Component", value: "PostgreSQL (On-Premise)" },
      { label: "Status", value: "Unreachable" },
    ],
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
  const [reason, setReason] = React.useState<OfflineReason>(getOfflineReason());
  const [checking, setChecking] = React.useState(false);
  const [lastCheckedAt, setLastCheckedAt] = React.useState<Date | null>(null);

  React.useEffect(() => subscribeConnectivity(() => setReason(getOfflineReason())), []);

  const checkNow = React.useCallback(async () => {
    setChecking(true);
    try {
      // /api/healthz deliberately bypasses the DB check (so it stays up even
      // when the database is down — useful for infra monitoring, wrong for
      // us here). To confirm the database is actually back, poll an endpoint
      // that touches it instead; DatabaseHealthMiddleware intercepts that
      // with a 503 for every path except /api/healthz.
      const probe = getOfflineReason() === "database" ? "/api/departments" : "/api/healthz";
      await customFetch(probe);
      // A successful call already triggers markOnline() inside customFetch,
      // which updates `reason` via the subscription above.
    } catch {
      // Still down — the interceptor already recorded why.
    } finally {
      setChecking(false);
      setLastCheckedAt(new Date());
    }
  }, []);

  React.useEffect(() => {
    if (!reason) return;
    const interval = setInterval(checkNow, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [reason, checkNow]);

  if (!reason) return null;

  const copy = COPY[reason];
  const Icon = copy.icon;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-6"
      style={{ background: "linear-gradient(135deg, #0f1923 0%, #1a2a3a 100%)" }}
      role="alertdialog"
      aria-live="assertive"
    >
      <div className="max-w-lg w-full text-center">
        <div
          className="w-20 h-20 rounded-2xl flex items-center justify-center mx-auto mb-6"
          style={{ background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.3)" }}
        >
          <Icon size={36} className="text-red-400" />
        </div>

        <div
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full mb-6"
          style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)" }}
        >
          <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
          <span className="text-red-400 text-xs font-bold uppercase tracking-wide">{copy.badge}</span>
        </div>

        <h1 className="text-2xl font-black text-white mb-3">{copy.title}</h1>
        <p className="text-white/50 text-sm leading-relaxed mb-5">{copy.description}</p>

        {/* Who to contact */}
        <div className="flex flex-col sm:flex-row gap-2 justify-center mb-8">
          {copy.contacts.map((c) => (
            <span
              key={c}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold"
              style={{ background: "rgba(59,130,246,0.12)", border: "1px solid rgba(59,130,246,0.25)", color: "#93c5fd" }}
            >
              <Phone size={11} /> {c}
            </span>
          ))}
        </div>

        <div className="flex flex-col sm:flex-row gap-3 justify-center mb-8">
          <Button
            onClick={checkNow}
            disabled={checking}
            className="gap-2"
            style={{ background: "linear-gradient(135deg, #3b82f6, #6366f1)", border: "none" }}
          >
            <RefreshCw size={16} className={checking ? "animate-spin" : ""} />
            {checking ? "Checking Connection…" : "Retry Now"}
          </Button>
          <Button
            variant="outline"
            className="gap-2"
            style={{ border: "1px solid rgba(255,255,255,0.2)", color: "white", background: "transparent" }}
            onClick={() => (window.location.href = "tel:+919876543210")}
          >
            <Phone size={16} />
            Contact Administrator
          </Button>
        </div>

        <div className="flex items-center gap-2 justify-center text-white/30 text-xs mb-6">
          <AlertTriangle size={13} />
          Checking automatically every few seconds — this page will close itself once reconnected.
        </div>

        <div
          className="rounded-xl p-4 text-left text-xs space-y-2"
          style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}
        >
          <p className="font-bold text-white/50 uppercase tracking-wide text-[10px] mb-3">System Information</p>
          <div className="flex items-center justify-between text-white/40">
            <span>Application</span>
            <span className="font-medium text-white/70">UKTextiles HR & ERP</span>
          </div>
          {copy.statusRows.map((row) => (
            <div key={row.label} className="flex items-center justify-between text-white/40">
              <span>{row.label}</span>
              <span className="font-medium text-red-400">{row.value}</span>
            </div>
          ))}
          <div className="flex items-center justify-between text-white/40">
            <span>Last checked</span>
            <span className="font-medium text-white/70">
              {lastCheckedAt ? lastCheckedAt.toLocaleTimeString("en-IN") : "—"}
            </span>
          </div>
        </div>

        <p className="text-white/20 text-xs mt-6">UKTextiles Enterprise Platform · On-Premise Infrastructure</p>
      </div>
    </div>
  );
}

// Exported for tests / manual dismissal from dev tools if ever needed.
export { markOnline as dismissConnectivityOverlay };

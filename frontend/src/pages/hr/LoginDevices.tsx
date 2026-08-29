import HrLayout from "@/components/HrLayout";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  MonitorSmartphone, RefreshCw, LogOut, ShieldCheck, Wifi, Globe, Clock,
} from "lucide-react";
import { useListLoginSessions, useRevokeLoginSession } from "@/lib/api-client/custom-hooks";
import { CircleLoader } from "@/components/ui/CircleLoader";

function fmtTime(iso: string) {
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function relativeTime(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function StatCard({ label, value, sub, icon: Icon, color }: {
  label: string; value: number | string; sub?: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  color: string;
}) {
  return (
    <div className={`rounded-2xl p-4 flex items-start gap-3 ${color}`}>
      <div className="mt-0.5 opacity-80">
        <Icon size={18} />
      </div>
      <div>
        <p className="text-xs font-medium opacity-70">{label}</p>
        <p className="text-2xl font-black">{value}</p>
        {sub && <p className="text-xs opacity-60 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

export default function LoginDevices() {
  const { user } = useAuth();
  const { toast } = useToast();
  const { data, isLoading, refetch, isFetching } = useListLoginSessions();
  const revoke = useRevokeLoginSession();

  const sessions = data?.results ?? [];
  const total = data?.total ?? 0;
  const uniqueUsers = new Set(sessions.map((s) => s.hrUserId)).size;
  const currentSession = sessions.find((s) => s.isCurrent);

  const handleRevoke = (sessionId: number, label: string) => {
    revoke.mutate(sessionId, {
      onSuccess: () => toast({ title: "Session revoked", description: `${label} has been logged out.` }),
      onError: () => toast({ title: "Failed to revoke session", variant: "destructive" }),
    });
  };

  return (
    <HrLayout>
      <div className="space-y-6">

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-2xl font-black text-gray-900">Login Devices</h2>
            <p className="text-muted-foreground text-sm mt-0.5">
              Every device currently signed in to the HRMS -monitor sessions and log out remotely
            </p>
          </div>
          <Button
            variant="outline" size="sm"
            className="gap-1.5 text-xs"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            <RefreshCw size={13} className={isFetching ? "animate-spin" : ""} /> Refresh
          </Button>
        </div>

        {/* ── Stats ──────────────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <StatCard
            label="Active Sessions" value={total}
            sub="devices currently logged in"
            icon={MonitorSmartphone}
            color="bg-blue-50 text-blue-800"
          />
          <StatCard
            label="Unique Accounts" value={uniqueUsers}
            sub="distinct users signed in"
            icon={ShieldCheck}
            color="bg-emerald-50 text-emerald-800"
          />
          <StatCard
            label="This Device"
            value={currentSession ? currentSession.deviceLabel : "—"}
            sub={currentSession ? "your current session" : ""}
            icon={Wifi}
            color="bg-indigo-50 text-indigo-800"
          />
        </div>

        {!user?.isSuperAdmin && (
          <div className="clay-card rounded-2xl px-5 py-3 text-xs text-gray-500 flex items-center gap-2">
            <ShieldCheck size={14} className="text-gray-400" />
            Only Super Admins can remotely log out a device. You have read-only access to this page.
          </div>
        )}

        {/* ── Session list ───────────────────────────────────────────────── */}
        <div className="clay-card rounded-2xl overflow-hidden">
          <div className="px-5 py-3 flex items-center justify-between" style={{ borderBottom: "1px solid rgba(0,100,150,0.07)" }}>
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              {isLoading ? "Loading…" : `${total.toLocaleString()} active session${total !== 1 ? "s" : ""}`}
            </span>
          </div>

          {isLoading ? (
            <CircleLoader texts={["UK Textiles", "Login Devices", "Loading"]} />
          ) : sessions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-gray-400">
              <MonitorSmartphone size={40} className="opacity-20 mb-3" />
              <p className="text-sm font-medium text-gray-500">No active sessions</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-50">
              {sessions.map((s) => (
                <div key={s.id} className="flex items-center gap-4 px-5 py-3.5 hover:bg-gray-50/60 transition-colors">
                  <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 border ${
                    s.isCurrent ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-blue-50 text-blue-700 border-blue-200"
                  }`}>
                    <MonitorSmartphone size={15} />
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-sm text-gray-900">{s.fullName}</span>
                      {s.roleName && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 border bg-gray-50 text-gray-600">
                          {s.roleName}
                        </Badge>
                      )}
                      {s.isCurrent && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 border bg-emerald-50 text-emerald-700 border-emerald-200">
                          This device
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">{s.deviceLabel} · @{s.username}</p>
                    <div className="flex items-center gap-3 mt-0.5 text-[10px] text-gray-400">
                      {s.ipAddress && (
                        <span className="flex items-center gap-1"><Globe size={10} /> {s.ipAddress}</span>
                      )}
                      <span className="flex items-center gap-1" title={fmtTime(s.createdAt)}>
                        <Clock size={10} /> Signed in {fmtTime(s.createdAt)}
                      </span>
                      <span>Last seen {relativeTime(s.lastSeenAt)}</span>
                    </div>
                  </div>

                  {user?.isSuperAdmin && (
                    <Button
                      variant="outline" size="sm"
                      className="gap-1.5 text-xs text-red-600 border-red-200 hover:bg-red-50 shrink-0"
                      disabled={revoke.isPending}
                      onClick={() => handleRevoke(s.id, s.deviceLabel)}
                    >
                      <LogOut size={12} /> {s.isCurrent ? "Log out" : "Revoke"}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </HrLayout>
  );
}

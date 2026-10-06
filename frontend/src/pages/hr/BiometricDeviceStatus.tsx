import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { ArrowLeft, ChevronDown, Fingerprint, Loader2, Radar, Search, Settings2 } from "lucide-react";
import HrLayout from "@/components/HrLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useDeviceStatus, useRunDeviceCheck } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import DeviceCard from "./device-status/DeviceCard";
import ServerPanel from "./device-status/ServerPanel";
import SummaryCards from "./device-status/SummaryCards";
import UnknownSenders from "./device-status/UnknownSenders";
import {
  FILTERS,
  TONE_CLASSES,
  overallVerdict,
  summarizeCheck,
  visibleDevices,
  type StatusFilter,
} from "./device-status/logic";

/**
 * Biometric Device Status (Attendance → Biometric Device Status): one place to see whether every punching machine is
 * connected to the server, and if one is not, why.
 *
 * Two kinds of evidence, side by side. What the server RECEIVES from each device (it polls, pushes attendance) is the
 * truth about "connected to the deployed API". What the server can REACH (ping, port, the device's own settings) is a
 * connection check the user runs; from the cloud it cannot see the factory network, which the page says plainly
 * instead of calling every device broken. See backend api/device_status.py.
 */
export default function BiometricDeviceStatus() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [autoRefresh, setAutoRefresh] = useState(true);
  const status = useDeviceStatus(autoRefresh);
  const check = useRunDeviceCheck();
  const [pinging, setPinging] = useState<number[]>([]);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");
  const [showHelp, setShowHelp] = useState(false);

  const data = status.data;
  const rows = useMemo(() => (data ? visibleDevices(data.devices, filter, query) : []), [data, filter, query]);

  // The server and firewall panel opens by itself when something is wrong, and stays out of the way when all is well.
  const [showServer, setShowServer] = useState<boolean | null>(null);
  const decided = useRef(false);
  useEffect(() => {
    if (data && !decided.current) {
      decided.current = true;
      setShowServer(data.summary.connected < data.summary.enabled || data.server.deployment === "local");
    }
  }, [data]);

  const run = (ids?: number[]) => {
    if (!data) return;
    setPinging(ids ?? data.devices.filter((d) => d.isActive).map((d) => d.id));
    check.mutate(ids, {
      onSuccess: (res) =>
        toast({
          title: "Connection check finished",
          description: summarizeCheck(res.status.devices, res.ranDeviceIds),
        }),
      onError: (e) => toast({ title: "Connection check failed", description: e.message, variant: "destructive" }),
      onSettled: () => setPinging([]),
    });
  };

  const verdict = data ? overallVerdict(data.devices) : null;
  const updated = data ? new Date(data.generatedAt).toLocaleTimeString() : null;

  return (
    <HrLayout>
      <div className="space-y-5 pb-8" data-testid="device-status-page">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => navigate("/hr/attendance")}
              aria-label="Back to Attendance"
            >
              <ArrowLeft size={18} />
            </Button>
            <div>
              <h2 className="text-2xl font-black text-gray-900">Biometric Device Status</h2>
              <p className="text-sm text-muted-foreground">
                Is every punching machine connected to the server — and if not, why?
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
              <Switch
                checked={autoRefresh}
                onCheckedChange={setAutoRefresh}
                aria-label="Auto-refresh every 15 seconds"
              />
              Auto-refresh
            </label>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => navigate("/hr/settings")}>
              <Settings2 size={14} /> Manage devices
            </Button>
            <Button
              size="sm"
              className="gap-1.5 bg-gradient-to-br from-[#006496] to-[#0080bf] text-white hover:brightness-105"
              onClick={() => run(undefined)}
              disabled={!data || check.isPending || data.summary.enabled === 0}
              data-testid="device-run-check"
            >
              {check.isPending ? <Loader2 size={14} className="animate-spin" /> : <Radar size={14} />}
              Run connection check
            </Button>
          </div>
        </div>

        {verdict && data && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" data-testid="device-verdict">
            <span className={cn("h-2.5 w-2.5 rounded-full", TONE_CLASSES[verdict.tone].dot)} />
            <span className={cn("font-bold", TONE_CLASSES[verdict.tone].text)}>{verdict.text}</span>
            <span className="text-xs text-slate-400">Updated {updated}</span>
          </div>
        )}

        {status.isLoading && (
          <div className="space-y-3">
            <Skeleton className="h-24 w-full rounded-2xl" />
            <Skeleton className="h-48 w-full rounded-2xl" />
            <Skeleton className="h-48 w-full rounded-2xl" />
          </div>
        )}

        {status.isError && (
          <Card className="border-0 shadow-sm ring-1 ring-red-200">
            <CardContent
              className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm text-red-700"
              data-testid="device-status-error"
            >
              <span>
                The device status could not be loaded: {(status.error as Error)?.message || "the server did not answer"}
                .
              </span>
              <Button size="sm" variant="outline" onClick={() => status.refetch()}>
                Try again
              </Button>
            </CardContent>
          </Card>
        )}

        {data && (
          <>
            <SummaryCards summary={data.summary} active={filter} onPick={setFilter} />

            <div>
              <button
                type="button"
                onClick={() => setShowServer((v) => !v)}
                aria-expanded={Boolean(showServer)}
                className="mb-2 flex items-center gap-1.5 text-sm font-bold text-slate-700"
                data-testid="device-server-toggle"
              >
                <ChevronDown size={15} className={cn("transition-transform", !showServer && "-rotate-90")} />
                Server &amp; firewall setup
              </button>
              {showServer && <ServerPanel server={data.server} />}
            </div>

            <UnknownSenders senders={data.unknownPushers} />

            <div className="flex flex-wrap items-center gap-3">
              <div className="relative min-w-[220px] flex-1">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by name, IP address or serial number"
                  className="h-9 pl-8 text-sm"
                  aria-label="Search devices"
                  data-testid="device-search"
                />
              </div>
              <PillTabs size="sm" items={FILTERS} value={filter} onChange={(v) => setFilter(v as StatusFilter)} />
            </div>

            {data.devices.length === 0 ? (
              <Card className="border-0 shadow-sm">
                <CardContent className="flex flex-col items-center gap-3 p-10 text-center" data-testid="device-empty">
                  <Fingerprint size={28} className="text-slate-300" />
                  <p className="text-sm font-semibold text-slate-700">No biometric devices are configured yet.</p>
                  <p className="max-w-md text-xs text-slate-500">
                    Add each punching machine in Settings → Devices (its IP address and serial number), then point the
                    machine at this server in its Cloud Server settings.
                  </p>
                  <Button size="sm" variant="outline" onClick={() => navigate("/hr/settings")}>
                    Open Settings → Devices
                  </Button>
                </CardContent>
              </Card>
            ) : rows.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground" data-testid="device-no-match">
                No device matches this filter.
              </p>
            ) : (
              <div className="space-y-4" data-testid="device-list">
                {rows.map((device) => (
                  <DeviceCard
                    key={device.id}
                    device={device}
                    server={data.server}
                    slowMs={data.thresholds.slowLatencyMs}
                    pinging={pinging.includes(device.id)}
                    busy={check.isPending}
                    onCheck={(id) => run([id])}
                    defaultOpen={data.devices.length === 1}
                  />
                ))}
              </div>
            )}

            <div>
              <button
                type="button"
                onClick={() => setShowHelp((v) => !v)}
                aria-expanded={showHelp}
                className="flex items-center gap-1.5 text-sm font-bold text-slate-700"
              >
                <ChevronDown size={15} className={cn("transition-transform", !showHelp && "-rotate-90")} />
                How to read this page
              </button>
              {showHelp && (
                <div
                  className="mt-2 grid gap-3 text-xs leading-relaxed text-slate-600 md:grid-cols-2"
                  data-testid="device-help"
                >
                  <Card className="border-0 shadow-sm">
                    <CardContent className="space-y-1.5 p-4">
                      <p className="font-bold text-slate-800">Connected / Disconnected / Error</p>
                      <p>
                        This is what the server <b>receives</b>. A working device calls the server about every 10
                        seconds, so one that has been silent for{" "}
                        {Math.round(data.thresholds.heartbeatFreshSeconds / 60)} minutes counts as Disconnected. A
                        device that never calls shows “Never connected”. Error means something was recorded as going
                        wrong, such as attendance lines the server could not read.
                      </p>
                    </CardContent>
                  </Card>
                  <Card className="border-0 shadow-sm">
                    <CardContent className="space-y-1.5 p-4">
                      <p className="font-bold text-slate-800">Reachable / Unreachable / Pinging</p>
                      <p>
                        This is what the server can <b>reach</b>, found by “Run connection check”: a ping, the
                        device&apos;s port and a read of its own settings. A server in the cloud cannot see the factory
                        network, so a device on a 192.168.x.x address is Unreachable from it by design; that does not
                        mean the device is broken. Run the check from the local app on a computer in the factory to read
                        each device&apos;s settings.
                      </p>
                    </CardContent>
                  </Card>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </HrLayout>
  );
}

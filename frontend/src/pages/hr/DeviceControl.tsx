import { useState } from "react";
import { useLocation } from "wouter";
import { Cable, CloudDownload, Cpu, Loader2, RefreshCw, UsersRound } from "lucide-react";
import HrLayout from "@/components/HrLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useDeviceControlOverview, useRecheckDevices, useRefreshDeviceUsers } from "@/lib/api-client/custom-hooks";
import { relativeTime } from "./device-status/logic";
import ConnectorsTab from "./device-control/ConnectorsTab";
import FetchTab from "./device-control/FetchTab";
import OverviewTab from "./device-control/OverviewTab";
import PushTab from "./device-control/PushTab";
import { pathForTab, tabFromPath, type DeviceControlTab } from "./device-control/logic";

/**
 * Device Control (Attendance → Device Control): everything about the biometric machines in one place.
 *
 *   Overview    how many devices there are, how many this server can reach right now, and each one's health
 *   Data Fetch  pull punches off the devices by hand and update the HRMS (preview first)
 *   Data Push   see everyone on every device, who they are in the HRMS, and add, change and delete them from here
 *
 * It talks to the devices directly, the way the Sync Biometric button does, so it works wherever this server can reach
 * them (the HRMS on a factory computer; on the cloud only through a forwarded port). It does not change how attendance
 * is recorded or calculated.
 */
export default function DeviceControl() {
  const [location, navigate] = useLocation();
  const { toast } = useToast();
  const tab = tabFromPath(location);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const overview = useDeviceControlOverview(autoRefresh);
  const recheck = useRecheckDevices();
  const refreshUsers = useRefreshDeviceUsers();
  const [readingId, setReadingId] = useState<number | null>(null);

  const readOne = async (id: number) => {
    setReadingId(id);
    try {
      const res = await refreshUsers.mutateAsync([id]);
      const r = res.results[0];
      toast(
        r?.ok
          ? { title: `Read ${r.deviceName}`, description: `${(r.count ?? 0).toLocaleString("en-IN")} user records.` }
          : { title: `Could not read ${r?.deviceName ?? "the device"}`, description: r?.error, variant: "destructive" },
      );
    } catch (e) {
      toast({
        title: "Could not read the device",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setReadingId(null);
    }
  };

  const data = overview.data;
  const checkedAt = data ? relativeTime(data.generatedAt) : null;

  return (
    <HrLayout>
      <div className="space-y-5 pb-8" data-testid="device-control-page">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="rounded-2xl bg-blue-600 p-2.5 text-white shadow-sm">
              <Cpu size={22} />
            </div>
            <div>
              <h2 className="text-2xl font-black text-gray-900">Device Control</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                The biometric machines: who is connected, the punches they hold, and the people on them.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {checkedAt && (
              <span className="text-xs text-slate-400" data-testid="dc-checked-at">
                Checked {checkedAt}
              </span>
            )}
            <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
              <Switch
                checked={autoRefresh}
                onCheckedChange={setAutoRefresh}
                aria-label="Check the devices every 30 seconds"
              />
              Auto-check
            </label>
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={() =>
                recheck.mutate(undefined, {
                  onSuccess: (fresh) => {
                    // a device behind a Site Connector is looked at by the connector: its answer is a few seconds away
                    // (it picks the job up within 5 seconds and then checks each device), so look again as it answers
                    if (fresh.devices.some((d) => d.via))
                      for (const ms of [3000, 7000, 12000, 20000]) setTimeout(() => overview.refetch(), ms);
                  },
                  onError: (e) =>
                    toast({ title: "Could not check the devices", description: e.message, variant: "destructive" }),
                })
              }
              disabled={recheck.isPending}
              data-testid="dc-recheck"
            >
              {recheck.isPending ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              Check connections
            </Button>
          </div>
        </div>

        <div className="max-w-full overflow-x-auto">
          <PillTabs
            items={[
              { value: "overview", label: "Overview", icon: <Cpu size={14} /> },
              { value: "fetch", label: "Data Fetch", icon: <CloudDownload size={14} /> },
              { value: "push", label: "Data Push", icon: <UsersRound size={14} /> },
              { value: "connectors", label: "Site connectors", icon: <Cable size={14} /> },
            ]}
            value={tab}
            onChange={(v) => navigate(pathForTab(v as DeviceControlTab))}
          />
        </div>

        {tab === "overview" && (
          <OverviewTab
            overview={data}
            loading={overview.isLoading}
            error={overview.isError ? (overview.error as Error) : null}
            readingId={readingId}
            onRead={readOne}
          />
        )}
        {tab === "connectors" ? (
          <ConnectorsTab />
        ) : tab !== "overview" && overview.isError && !data ? (
          <Card className="rounded-2xl ring-1 ring-red-200">
            <CardContent
              className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm text-red-700"
              data-testid="dc-error"
            >
              <span>
                The devices could not be loaded: {(overview.error as Error)?.message ?? "the server did not answer"}.
              </span>
              <Button size="sm" variant="outline" onClick={() => overview.refetch()}>
                Try again
              </Button>
            </CardContent>
          </Card>
        ) : (
          <>
            {tab === "fetch" && <FetchTab overview={data} loading={overview.isLoading} />}
            {tab === "push" && <PushTab overview={data} loading={overview.isLoading} />}
          </>
        )}
      </div>
    </HrLayout>
  );
}

import { useState } from "react";
import { Cloud, Globe2, Info, Loader2, Monitor, Router, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { getApiOrigin } from "@/lib/api-client/custom-fetch";
import type { DeviceStatusServer } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { CopyButton, TonePill } from "./parts";
import { TONE_CLASSES, describePath, formatLatency, measureApiPath, type PathResult } from "./logic";

function Row({ label, value, copy }: { label: string; value: string; copy?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-[13px]">
      <span className="text-slate-500">{label}</span>
      <span className="flex items-center gap-1 font-semibold text-slate-800">
        <span className="break-all text-right">{value}</span>
        {copy && <CopyButton value={value} label={label} />}
      </span>
    </div>
  );
}

/**
 * The server and the path to it: what the server is, what every device must be set to, and a measurement from THIS
 * computer to the server. Run on a computer inside the factory network, that measurement goes through the same
 * firewall as the devices' own traffic.
 */
export default function ServerPanel({ server }: { server: DeviceStatusServer }) {
  const [measuring, setMeasuring] = useState(false);
  const [path, setPath] = useState<PathResult | null>(null);
  const origin = getApiOrigin();
  const shownOrigin = origin || (typeof window !== "undefined" ? window.location.origin : "");

  const measure = async () => {
    setMeasuring(true);
    try {
      setPath(await measureApiPath({ origin }));
    } finally {
      setMeasuring(false);
    }
  };

  const verdict = path ? describePath(path) : null;
  const settings = server.deviceSettings;
  const local = server.deployment === "local";

  return (
    <div className="space-y-3" data-testid="device-server-panel">
      {local && (
        <div
          className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50/70 p-3 text-xs text-amber-900"
          data-testid="device-local-notice"
        >
          <Info size={14} className="mt-0.5 shrink-0 text-amber-600" />
          <p>
            <b>This is a local server, not the Railway deployment.</b> Devices send their attendance to the server set
            on the device itself (usually the deployed one), so what you see here is only what <i>this</i> server has
            received and what it can reach on this network. Open this page on the deployed site to see what Railway
            receives.
          </p>
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="border-0 shadow-sm">
          <CardContent className="p-4">
            <p className="mb-1 flex items-center gap-2 text-sm font-bold text-slate-800">
              <Server size={15} className="text-cyan-600" /> This server
            </p>
            <div className="divide-y divide-slate-100">
              <div className="flex items-center justify-between py-1.5 text-[13px]">
                <span className="text-slate-500">Running on</span>
                <TonePill tone={local ? "warn" : "good"}>
                  <Cloud size={11} />{" "}
                  {local ? "Local server" : `Railway${server.environment ? ` · ${server.environment}` : ""}`}
                </TonePill>
              </div>
              <Row label="Address" value={server.host || "–"} />
              {server.commit && <Row label="Version" value={server.commit} />}
              <Row label="Server time (IST)" value={server.serverTimeIst.replace("T", " ")} />
              <div className="flex items-center justify-between py-1.5 text-[13px]">
                <span className="text-slate-500">Can reach the factory network</span>
                <span className="font-semibold">
                  {server.canReachLan === null ? (
                    <span className="text-slate-400">Not tested</span>
                  ) : server.canReachLan ? (
                    <span className="text-emerald-700">Yes</span>
                  ) : (
                    <span className="text-indigo-700">No</span>
                  )}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-0 shadow-sm">
          <CardContent className="p-4">
            <p className="mb-1 flex items-center gap-2 text-sm font-bold text-slate-800">
              <Router size={15} className="text-cyan-600" /> What each device must be set to
            </p>
            <p className="mb-1 text-[11px] text-slate-500">On the device: Menu → COMM. → Cloud Server Setting</p>
            {settings.note && <p className="mb-1 text-[11px] font-medium text-amber-700">{settings.note}</p>}
            <div className="divide-y divide-slate-100">
              <Row label="Server mode" value={settings.serverMode} />
              <Row
                label="Server address"
                value={settings.serverAddress || "the deployed server's address"}
                copy={Boolean(settings.serverAddress)}
              />
              <Row label="Server port" value={`${settings.serverPort}${settings.https ? " (HTTPS on)" : ""}`} />
              <Row label="DNS (Ethernet)" value={`${settings.dnsHint} or the router`} />
              <Row label="Gateway (Ethernet)" value="the router, e.g. 192.168.0.254" />
            </div>
          </CardContent>
        </Card>

        <Card className="border-0 shadow-sm">
          <CardContent className="space-y-3 p-4">
            <p className="flex items-center gap-2 text-sm font-bold text-slate-800">
              <Monitor size={15} className="text-cyan-600" /> Path from this computer
            </p>
            <p className="text-[11px] leading-relaxed text-slate-500">
              Times a few requests from this computer to the server at <b>{shownOrigin || "this site"}</b>. On a
              computer inside the factory network this crosses the same firewall as the devices&apos; traffic.
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={measure}
              disabled={measuring}
              className="gap-1.5"
              data-testid="device-path-test"
            >
              {measuring ? <Loader2 size={13} className="animate-spin" /> : <Globe2 size={13} />}
              {measuring ? "Testing…" : path ? "Test again" : "Test the path"}
            </Button>
            {path && verdict && (
              <div className="space-y-2" data-testid="device-path-result">
                {path.stats && path.stats.sent > path.stats.lost && (
                  <div className="grid grid-cols-3 gap-2 text-center">
                    {(
                      [
                        ["Fastest", formatLatency(path.stats.min)],
                        ["Average", formatLatency(path.stats.avg)],
                        ["Slowest", formatLatency(path.stats.max)],
                      ] as const
                    ).map(([label, value]) => (
                      <div key={label} className="rounded-lg bg-slate-50 py-1.5">
                        <p className="text-sm font-black text-slate-700">{value}</p>
                        <p className="text-[10px] text-slate-400">{label}</p>
                      </div>
                    ))}
                  </div>
                )}
                <p className={cn("text-xs font-medium leading-snug", TONE_CLASSES[verdict.tone].text)}>
                  {verdict.text}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

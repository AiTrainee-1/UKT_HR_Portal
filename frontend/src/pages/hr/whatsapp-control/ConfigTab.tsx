import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle, CheckCircle2, Copy, Info } from "lucide-react";
import { useWhatsAppControlSettings } from "@/lib/api-client/custom-hooks";
import { Row } from "./shared";

// A link WAClient's servers can't reach (this machine, a LAN address) means every
// document send fails with an opaque 403 -flag it before anyone tries.
const PRIVATE_HOST =
  /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[?::1\]?)|\.local$|\.internal$/i;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function Check({ ok, label, hint }: { ok: boolean; label: string; hint?: string }) {
  return (
    <li className="flex items-start gap-2 py-2">
      {ok ? (
        <CheckCircle2 size={15} className="text-emerald-500 mt-0.5 shrink-0" />
      ) : (
        <AlertTriangle size={15} className="text-amber-500 mt-0.5 shrink-0" />
      )}
      <div>
        <p className="text-sm font-semibold text-gray-800">{label}</p>
        {hint && <p className="text-xs text-gray-500 mt-0.5">{hint}</p>}
      </div>
    </li>
  );
}

export default function ConfigTab() {
  const { toast } = useToast();
  const { data, isLoading } = useWhatsAppControlSettings();
  const [copied, setCopied] = useState(false);

  if (isLoading || !data) return <Skeleton className="h-80 rounded-2xl" />;
  const c = data.config;
  const publicOk = !PRIVATE_HOST.test(hostOf(c.publicBaseUrl));

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(c.webhookUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast({
        title: "Couldn't copy",
        description: "Select the address and copy it manually.",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="space-y-4">
      <Card className="border-0 shadow-sm">
        <CardHeader className="pb-1">
          <CardTitle className="text-sm font-bold">Setup checklist</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-y">
            <Check
              ok={c.configured}
              label="WAClient credentials are set on the server"
              hint={
                c.configured
                  ? `Instance ${c.instanceId}.`
                  : "Set WACLIENT_INSTANCE_ID and WACLIENT_ACCESS_TOKEN in the server's environment (Railway → Variables) and redeploy."
              }
            />
            <Check
              ok={publicOk}
              label="Documents can be downloaded by WAClient"
              hint={
                publicOk
                  ? `Documents are fetched from ${c.publicBaseUrl}.`
                  : `${c.publicBaseUrl} isn't reachable from the internet, so salary slips, ID cards and letters can't be sent from here. Set BACKEND_PUBLIC_URL to a public address (a tunnel when testing locally).`
              }
            />
            <Check
              ok={Boolean(c.employeePortalUrl)}
              label="Approval messages link to the Employee Web App"
              hint={
                c.employeePortalUrl
                  ? `"View request" links open ${c.employeePortalUrl}.`
                  : 'Optional. Set EMPLOYEE_PORTAL_URL (for example https://employee.uktextiles.in) to add a "View request" link to approval messages.'
              }
            />
            <Check
              ok={c.webhookTokenSet}
              label="Webhook is protected with a token (recommended)"
              hint={
                c.webhookTokenSet
                  ? "The webhook URL must include ?token=… to be accepted."
                  : "Optional. Set WHATSAPP_WEBHOOK_TOKEN and add ?token=<value> to the URL below so only WAClient can post to it."
              }
            />
          </ul>
        </CardContent>
      </Card>

      <Card className="border-0 shadow-sm">
        <CardHeader className="pb-1">
          <CardTitle className="text-sm font-bold">Delivery status webhook</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-gray-500">
            Paste this address as the webhook URL on your instance in the WAClient dashboard. It's how Delivered and
            Read appear here; without it messages stay at "Sent".
          </p>
          <div className="flex items-center gap-2">
            <code
              className="flex-1 min-w-0 truncate rounded-lg border bg-slate-50 px-3 py-2 text-xs"
              data-testid="webhook-url"
            >
              {c.webhookUrl}
            </code>
            <Button variant="outline" size="sm" className="gap-1.5 text-xs" onClick={copy}>
              <Copy size={12} /> {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="border-0 shadow-sm">
        <CardHeader className="pb-1">
          <CardTitle className="text-sm font-bold">Configuration</CardTitle>
        </CardHeader>
        <CardContent className="divide-y">
          <Row label="Provider">{c.provider}</Row>
          <Row label="Status">
            {c.configured ? (
              <span className="text-emerald-700 font-semibold">Configured</span>
            ) : (
              <span className="text-red-700 font-semibold">Not configured</span>
            )}
          </Row>
          <Row label="Instance">{c.instanceId ?? "—"}</Row>
          <Row label="API address">
            <code className="text-xs">{c.apiUrl}</code>
          </Row>
          <Row label="Default country code">+{c.defaultCountryCode}</Row>
          <Row label="Pause between bulk sends">{c.sendDelaySeconds} s</Row>
          <Row label="Public address">
            <code className="text-xs">{c.publicBaseUrl}</code>
          </Row>
          <Row label="Employee Web App">
            {c.employeePortalUrl ? <code className="text-xs">{c.employeePortalUrl}</code> : "Not set (no links)"}
          </Row>
          <Row label="Delivery">
            {c.backgroundSending
              ? "Approvals, visitor and gate messages are sent by a background worker, so nobody waits on WhatsApp. Codes and attendance alerts are sent immediately."
              : "Every message is sent immediately, while the request is being processed."}
          </Row>
          <Row label="Link previews">{c.linkPreview ? "On (falls back to plain text if refused)" : "Off"}</Row>
        </CardContent>
      </Card>

      <div className="flex items-start gap-2 rounded-xl border bg-slate-50 p-3 text-xs text-slate-600">
        <Info size={14} className="mt-0.5 shrink-0" />
        <span>
          Credentials are deliberately not shown or editable here: they live only in the server's environment, so they
          can't leak through this page, a database backup or a screenshot. This is the WhatsApp Web (linked device)
          route: keep the linked phone online, send only to your own employees, and don't blast bulk messages, or
          WhatsApp may restrict the number.
        </span>
      </div>
    </div>
  );
}

import { useState } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle, CheckCircle2, Info, Send } from "lucide-react";
import { useGmailControlSettings, useGmailTestEmail, type GmailTestResult } from "@/lib/api-client/custom-hooks";
import { Row, StatusPill } from "./shared";

function Check({ ok, label, hint }: { ok: boolean; label: string; hint?: React.ReactNode }) {
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

function TestEmail({ disabledReason }: { disabledReason: string | null }) {
  const { toast } = useToast();
  const test = useGmailTestEmail();
  const [to, setTo] = useState("");
  const [result, setResult] = useState<GmailTestResult | null>(null);

  const send = () => {
    setResult(null);
    test.mutate(to.trim(), {
      onSuccess: (r) => setResult(r),
      onError: (e) =>
        toast({ title: "Couldn't send the test", description: (e as Error).message, variant: "destructive" }),
    });
  };

  return (
    <Card className="border-0 shadow-sm">
      <CardHeader className="pb-1">
        <CardTitle className="text-sm font-bold">Send a test email</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-gray-500">
          Sends one short email through the Gmail account in Settings, the same way every other email goes out, and
          records it on the Messages tab. Use your own address, then check the inbox (and Spam).
        </p>
        {disabledReason && (
          <p className="text-xs text-amber-800 rounded-lg bg-amber-50 border border-amber-200 p-2">
            {disabledReason} The test will say so instead of sending.
          </p>
        )}
        <div className="flex items-end gap-2 flex-wrap">
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="test-email-to">
              Send the test to
            </Label>
            <Input
              id="test-email-to"
              type="email"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && to.trim() && !test.isPending && send()}
              placeholder="you@company.com"
              className="w-72"
            />
          </div>
          <Button size="sm" className="gap-1.5" onClick={send} disabled={!to.trim() || test.isPending}>
            <Send size={12} /> {test.isPending ? "Sending…" : "Send test email"}
          </Button>
        </div>
        {result && (
          <div
            className={`flex items-start gap-2 rounded-lg border p-3 text-xs ${
              result.ok
                ? "border-green-200 bg-green-50 text-green-900"
                : result.status === "blocked"
                  ? "border-amber-200 bg-amber-50 text-amber-900"
                  : "border-red-200 bg-red-50 text-red-900"
            }`}
            role="status"
            data-testid="test-email-result"
          >
            <StatusPill status={result.status} />
            <span>
              {result.ok
                ? `Gmail accepted the email to ${result.sentTo}. It should arrive within a minute — check Spam if it doesn't.`
                : result.error}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function ConfigTab() {
  const { data, isLoading } = useGmailControlSettings();

  if (isLoading || !data) return <Skeleton className="h-80 rounded-2xl" />;
  const c = data.config;

  return (
    <div className="space-y-4">
      <Card className="border-0 shadow-sm">
        <CardHeader className="pb-1">
          <CardTitle className="text-sm font-bold">Setup checklist</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-y">
            <Check
              ok={c.smtpConfigured}
              label="The Gmail account is saved in Settings"
              hint={
                c.smtpConfigured ? (
                  `Sending as ${c.fromName} <${c.fromEmail}> through ${c.host}:${c.port} (${c.security}), signed in as ${c.username}.`
                ) : (
                  <>
                    The SMTP host, user or app password is missing.{" "}
                    <Link href={c.settingsPath} className="underline font-semibold">
                      Open Settings → SMTP
                    </Link>{" "}
                    and save them.
                  </>
                )
              }
            />
            <Check
              ok={c.sendingAllowedHere}
              label="This server is allowed to send"
              hint={
                c.sendingAllowedHere
                  ? "This is a live server, so emails go out."
                  : "This is a development machine (DEBUG on, or running under runserver), so it will not email employees from the live Gmail account. Set EMAIL_ALLOW_SENDING=true in the server's environment only if you really mean to."
              }
            />
            <Check
              ok={c.dailyLimit > 0}
              label="A daily limit protects the Gmail account"
              hint={
                c.dailyLimit > 0
                  ? `Limited to ${c.dailyLimit} a day; ${c.sentToday} sent today.`
                  : `Optional. Gmail stops a regular account at about ${c.gmailLimits.regular} emails a day. Set a limit under Feature Controls so a big bulk send can't get the account blocked.`
              }
            />
          </ul>
        </CardContent>
      </Card>

      <TestEmail disabledReason={c.sendingBlockedReason} />

      <Card className="border-0 shadow-sm">
        <CardHeader className="pb-1">
          <CardTitle className="text-sm font-bold">Configuration</CardTitle>
        </CardHeader>
        <CardContent className="divide-y">
          <Row label="Provider">{c.provider}</Row>
          <Row label="Status">
            {c.configured ? (
              <span className="text-emerald-700 font-semibold">Ready to send</span>
            ) : (
              <span className="text-red-700 font-semibold">Can't send</span>
            )}
          </Row>
          <Row label="Mail server">
            <code className="text-xs">{c.host || "—"}</code>
          </Row>
          <Row label="Port">
            {c.port} <span className="text-gray-400">({c.security})</span>
          </Row>
          <Row label="Signed in as">{c.username || "—"}</Row>
          <Row label="App password">
            {c.passwordSet ? (
              <span className="text-emerald-700 font-semibold">Saved (hidden)</span>
            ) : (
              <span className="text-red-700 font-semibold">Not saved</span>
            )}
          </Row>
          <Row label="Sent from">{c.fromEmail ? `${c.fromName} <${c.fromEmail}>` : "—"}</Row>
          <Row label="Company name in emails">{c.companyName}</Row>
          <Row label="Today">
            {c.sentToday} sent{c.dailyLimit > 0 ? ` of ${c.dailyLimit}` : " (no limit set)"}
          </Row>
        </CardContent>
      </Card>

      <div className="flex items-start gap-2 rounded-xl border bg-slate-50 p-3 text-xs text-slate-600">
        <Info size={14} className="mt-0.5 shrink-0" />
        <span>
          The Gmail login is kept in{" "}
          <Link href={c.settingsPath} className="underline font-semibold">
            Settings → SMTP
          </Link>{" "}
          and is deliberately not shown or editable here; the password is never sent to this page. Gmail needs 2-Step
          Verification switched on and a 16-character <b>App Password</b> (Google Account → Security → 2-Step
          Verification → App passwords) in place of the account's normal password.
        </span>
      </div>
    </div>
  );
}

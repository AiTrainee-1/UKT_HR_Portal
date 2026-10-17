import type { ReactNode } from "react";
import { Link } from "wouter";
import { BookOpen, Check, KeyRound, ShieldCheck } from "lucide-react";
import { useSmsOverview, type SmsOverview } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import {
  DOCS_FILE,
  ENV_VARS,
  isEnvSet,
  PROVIDER_NAME,
  TWOFACTOR_SENDER_ID,
  TWOFACTOR_TEMPLATE_NAME,
  TWOFACTOR_TEMPLATE_TEXT,
} from "./logic";
import { smsPath } from "./routes";
import { CopyButton, CopyLine, Notice, Panel } from "./ui";

function Step({
  n,
  title,
  done,
  children,
  testId,
}: {
  n: number;
  title: string;
  /** True when the server says this step is finished; null when that is not known. */
  done: boolean | null;
  children: ReactNode;
  testId: string;
}) {
  return (
    <li className="flex gap-3" data-testid={testId} data-done={done === null ? "unknown" : String(done)}>
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-bold",
          done ? "border-emerald-500 bg-emerald-500 text-white" : "border-border bg-muted/40 text-muted-foreground",
        )}
      >
        {done ? <Check size={13} /> : n}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <h4 className="text-sm font-semibold leading-snug">
          {title}
          {done !== null && (
            <span
              className={cn(
                "ml-2 text-[11px] font-bold",
                done ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground",
              )}
            >
              {done ? "Done" : "Not done yet"}
            </span>
          )}
        </h4>
        <div className="space-y-2 text-[13px] leading-relaxed text-muted-foreground">{children}</div>
      </div>
    </li>
  );
}

function EnvState({
  o,
  flag,
  required,
}: {
  o: SmsOverview | undefined;
  flag?: "authKey" | "senderId" | "templateName";
  required: boolean;
}) {
  if (!required) return <span className="text-[11px] font-semibold text-muted-foreground">Optional</span>;
  if (!o || !flag) return null;
  const set = isEnvSet(o.env, flag);
  return (
    <span
      className={cn(
        "rounded-full border px-2 py-0.5 text-[11px] font-bold",
        set
          ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300"
          : "border-red-200 bg-red-50 text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300",
      )}
      data-testid={`sms-env-state-${flag}`}
    >
      {set ? "Set" : "Not set"}
    </span>
  );
}

/**
 * Setup: the short, exact list of what has to be done once for SMS to work: the 2Factor account, the approved message text, the
 * environment values on the server (their NAMES and what they are, never their values), a test, and the switch. The steps tick
 * themselves from the state of the server. The auth key is only ever put in the server's environment: this page says so.
 */
export default function SetupTab() {
  const { data: o } = useSmsOverview();
  const name = PROVIDER_NAME;

  return (
    <div className="space-y-4" data-testid="sms-setup">
      <Notice tone="info" testId="sms-setup-secret">
        <span className="flex items-start gap-1.5">
          <ShieldCheck size={14} className="mt-0.5 shrink-0" />
          <span>
            <b>The 2Factor API key is only ever kept on the server.</b> It lives in the server's environment file and
            nowhere else: this page never asks for it, never shows it and never sends it. Nobody can read it through the
            HRMS, and it is never written to any log.
          </span>
        </span>
      </Notice>

      <Panel
        title="Set up SMS in six steps"
        description="You do this once. The steps tick themselves when the server shows they are done."
        icon={KeyRound}
      >
        <ol className="space-y-6">
          <Step n={1} title="Get your 2Factor API key" done={o ? o.env.authKey : null} testId="sms-step-account">
            <p>
              Create or open your 2Factor account. In its panel copy the <b>API key</b>. It goes into the server's
              environment only, never into this page or any form.
            </p>
          </Step>

          <Step
            n={2}
            title="Create the OTP template"
            done={o ? o.env.templateName !== "" : null}
            testId="sms-step-template"
          >
            <p>
              In the 2Factor panel open <b>SMS OTP &gt; OTP Templates</b> and add a template. The text must contain{" "}
              <code>XXXX</code> exactly once (the code goes there) and be under 150 characters. Use exactly this text:
            </p>
            <CopyLine text={TWOFACTOR_TEMPLATE_TEXT} what="the template text" testId="sms-2f-template-text" />
            <p>Give the template this name (it goes in the server's environment, not a number):</p>
            <CopyLine text={TWOFACTOR_TEMPLATE_NAME} what="the template name" testId="sms-2f-template-name" />
            <p>and this sender ID:</p>
            <CopyLine text={TWOFACTOR_SENDER_ID} what="the sender ID" testId="sms-2f-sender-id" />
            <p className="text-xs">
              <code>XXXX</code> is replaced by the code. Do not change a word: a different text is refused. One template
              serves login, reset and activation codes.
            </p>
          </Step>

          <Step n={3} title="Put the values on the server" done={o ? o.configured : null} testId="sms-step-env">
            <p>
              Add these lines to the file <code>backend/.env</code> on the server, then <b>restart the server</b>. The
              three marked required have to be real values: an example value (it starts with <code>your_</code> or
              contains <code>here</code>) is treated as not set, so a demo value can never send anything.{" "}
              <code>SMS_ALLOW_SENDING</code> is the development guard: a development machine never sends, so nothing
              leaves it by accident, unless it is set to <code>true</code>.
            </p>
            <ul className="divide-y rounded-xl border bg-card text-foreground" data-testid="sms-env-list">
              {ENV_VARS.map((v) => (
                <li key={v.name} className="space-y-1.5 p-3" data-testid={`sms-env-${v.name}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="break-all rounded bg-muted/60 px-1.5 py-0.5 text-[12px] font-semibold">
                      {v.name}
                    </code>
                    <CopyButton text={v.name} what={v.name} />
                    <EnvState o={o} flag={v.flag} required={v.required} />
                  </div>
                  <p className="text-xs leading-snug text-muted-foreground">{v.what}</p>
                  {v.example && (
                    <p className="text-xs text-muted-foreground">
                      Example: <code className="break-all">{v.example}</code>
                    </p>
                  )}
                  {v.name === "TWOFACTOR_API_BASE" && o?.env.apiBase && (
                    <p className="break-all text-xs text-muted-foreground">
                      The server uses: <code>{o.env.apiBase}</code>
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </Step>

          <Step
            n={4}
            title="Send a test SMS to your own phone"
            done={o ? o.lastSentAt !== null : null}
            testId="sms-step-test"
          >
            <p>
              Open the{" "}
              <Link
                href={smsPath("test")}
                className="font-semibold text-sky-700 underline underline-offset-2 dark:text-sky-400"
              >
                Test tab
              </Link>{" "}
              and send one message. It should arrive in a few seconds and read exactly like the text above.
            </p>
          </Step>

          <Step n={5} title="Choose SMS as the channel" done={o ? o.channel === "sms" : null} testId="sms-step-channel">
            <p>
              Under{" "}
              <Link
                href={smsPath("settings", "channel")}
                className="font-semibold text-sky-700 underline underline-offset-2 dark:text-sky-400"
              >
                Settings &gt; Channel
              </Link>{" "}
              switch the codes from WhatsApp to SMS. You can switch back at any time, and password sign-in keeps working
              either way.
            </p>
          </Step>

          <Step n={6} title="Watch the first few messages" done={null} testId="sms-step-watch">
            <p>
              The{" "}
              <Link
                href={smsPath("overview")}
                className="font-semibold text-sky-700 underline underline-offset-2 dark:text-sky-400"
              >
                Overview
              </Link>{" "}
              shows the balance, the day's usage and anything that needs attention, and{" "}
              <Link
                href={smsPath("messages")}
                className="font-semibold text-sky-700 underline underline-offset-2 dark:text-sky-400"
              >
                Messages
              </Link>{" "}
              lists every SMS with its outcome.
            </p>
          </Step>
        </ol>
      </Panel>

      <Panel title="The full guide" icon={BookOpen} testId="sms-setup-docs">
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
          <span>The whole integration is written up, with the {name} API used and why, in the project's docs file</span>
          <code className="rounded bg-muted/60 px-1.5 py-0.5 text-[12px] font-semibold text-foreground">
            {DOCS_FILE}
          </code>
          <CopyButton text={DOCS_FILE} what="the docs file name" />
        </div>
      </Panel>
    </div>
  );
}

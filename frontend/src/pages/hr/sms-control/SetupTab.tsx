import type { ReactNode } from "react";
import { Link } from "wouter";
import { BookOpen, Check, KeyRound, PhoneCall, ServerCog, ShieldCheck } from "lucide-react";
import { useSmsOverview, type SmsOverview } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import {
  CODES_ONLY_TEXT,
  DOCS_FILE,
  ENV_VARS,
  PROVIDER_NAME,
  TWOFACTOR_SENDER_ID,
  TWOFACTOR_TEMPLATE_NAME,
  TWOFACTOR_TEMPLATE_TEXT,
  isEnvSet,
  type EnvVar,
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
          "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-bold",
          done ? "border-emerald-500 bg-emerald-500 text-white" : "border-border bg-muted text-muted-foreground",
        )}
      >
        {done ? <Check size={14} /> : n}
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

/** Set / Not set / Optional beside an environment variable: never its value. */
function EnvState({ o, v }: { o: SmsOverview | undefined; v: EnvVar }) {
  if (!v.required) return <span className="text-[11px] font-semibold text-muted-foreground">Optional</span>;
  if (!o || !v.flag) return null;
  const set = isEnvSet(o.env, v.flag);
  return (
    <span
      className={cn(
        "rounded-full border px-2 py-0.5 text-[11px] font-bold",
        set
          ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
          : "border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300",
      )}
      data-testid={`sms-env-state-${v.flag}`}
      data-set={set ? "true" : "false"}
    >
      {set ? "Set" : "Not set"}
    </span>
  );
}

/** What the server uses now (names and addresses only: never a secret). */
function InUse({ o }: { o: SmsOverview | undefined }) {
  const rows: [string, string, string][] = [
    ["Template name", o?.env.templateName ?? "", "sms-in-use-template"],
    ["Sender ID", o?.env.senderId ?? "", "sms-in-use-sender"],
    ["API address", o?.env.apiBase ?? "", "sms-in-use-api"],
  ];
  return (
    <Panel
      title="What this server uses"
      description="Read from the server's environment. The API key is never shown: only whether it is set."
      icon={ServerCog}
      testId="sms-in-use"
    >
      <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {rows.map(([label, value, testId]) => (
          <div key={label} className="min-w-0 rounded-xl border bg-muted p-3" data-testid={testId}>
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</dt>
            <dd className={cn("mt-1 break-all text-sm font-semibold", !value && "text-muted-foreground")}>
              {value || "Not set"}
            </dd>
          </div>
        ))}
        <div className="min-w-0 rounded-xl border bg-muted p-3" data-testid="sms-in-use-key">
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">API key</dt>
          <dd
            className={cn(
              "mt-1 text-sm font-semibold",
              o?.env.authKey ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground",
            )}
          >
            {o ? (o.env.authKey ? "Set (hidden)" : "Not set") : "—"}
          </dd>
        </div>
      </dl>
    </Panel>
  );
}

/**
 * Setup: the short, exact list of what has to be done once for SMS codes to work: the 2Factor account, the approved OTP
 * template, the environment values on the server (their NAMES and whether each is set, never a value), a test, and the
 * switch. The steps tick themselves from the state of the server. Below: what the server uses now, and the voice-call note.
 */
export default function SetupTab() {
  const { data: o } = useSmsOverview();
  const name = PROVIDER_NAME;

  return (
    <div className="space-y-4" data-testid="sms-setup">
      <div className="grid gap-2 lg:grid-cols-2">
        <Notice tone="info" icon={ShieldCheck} testId="sms-setup-secret">
          <b>The {name} API key is only ever kept on the server.</b> It lives in the server's environment file and
          nowhere else: this page never asks for it, never shows it and never sends it, and it is never written to any
          log.
        </Notice>
        <Notice tone="good" icon={ShieldCheck} testId="sms-setup-codes-only">
          {CODES_ONLY_TEXT} The only text that can go out is the OTP template below, with a code in it.
        </Notice>
      </div>

      <InUse o={o} />

      <Panel
        title="Set up SMS codes in six steps"
        description="You do this once. The steps tick themselves when the server shows they are done."
        icon={KeyRound}
      >
        <ol className="space-y-6">
          <Step n={1} title={`Get your ${name} API key`} done={o ? o.env.authKey : null} testId="sms-step-account">
            <p>
              Create or open your {name} account. In its panel copy the <b>API key</b>. It goes into the server's
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
              In the {name} panel open <b>SMS OTP &gt; OTP Templates</b> and add a template. The text must contain{" "}
              <code>XXXX</code> exactly once (the code goes there) and be under 150 characters. Use exactly this text:
            </p>
            <CopyLine text={TWOFACTOR_TEMPLATE_TEXT} what="the template text" testId="sms-2f-template-text" />
            <p>Give the template this name (it goes in the server's environment, not a number):</p>
            <CopyLine text={TWOFACTOR_TEMPLATE_NAME} what="the template name" testId="sms-2f-template-name" />
            <p>and this sender ID:</p>
            <CopyLine text={TWOFACTOR_SENDER_ID} what="the sender ID" testId="sms-2f-sender-id" />
            <p className="text-xs">
              <code>XXXX</code> is replaced by the code. Do not change a word: a different text is refused. One template
              serves sign-in, password-reset and activation codes.
            </p>
          </Step>

          <Step n={3} title="Put the values on the server" done={o ? o.configured : null} testId="sms-step-env">
            <p>
              Add these lines to the file <code>backend/.env</code> on the server, then <b>restart the server</b>. The
              three marked required have to be real values: an example value (it starts with <code>your_</code> or
              contains <code>here</code>) is treated as not set, so a demo value can never send anything.
            </p>
            <ul className="divide-y rounded-xl border bg-card text-foreground" data-testid="sms-env-list">
              {ENV_VARS.map((v) => (
                <li key={v.name} className="space-y-1.5 p-3" data-testid={`sms-env-${v.name}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="break-all rounded bg-muted px-1.5 py-0.5 text-[12px] font-semibold">{v.name}</code>
                    <CopyButton text={v.name} what={v.name} />
                    <EnvState o={o} v={v} />
                    {v.secret && (
                      <span className="text-[11px] font-semibold text-muted-foreground">Secret: never shown</span>
                    )}
                  </div>
                  <p className="text-xs leading-snug text-muted-foreground">{v.what}</p>
                  {v.example && (
                    <p className="text-xs text-muted-foreground">
                      Example: <code className="break-all">{v.example}</code>
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </Step>

          <Step n={4} title="Send a test code" done={o ? o.lastSentAt !== null : null} testId="sms-step-test">
            <p>
              Open the{" "}
              <Link
                href={smsPath("test")}
                className="font-semibold text-sky-700 underline underline-offset-2 dark:text-sky-400"
              >
                Test tab
              </Link>{" "}
              and send one code to yourself or to an employee. It should arrive in a few seconds and read exactly like
              the text above. A test works while SMS codes are still off.
            </p>
          </Step>

          <Step n={5} title="Switch SMS codes on" done={o ? o.otpEnabled : null} testId="sms-step-switch">
            <p>
              Under{" "}
              <Link
                href={smsPath("settings", "switches")}
                className="font-semibold text-sky-700 underline underline-offset-2 dark:text-sky-400"
              >
                Settings &gt; OTP Switches
              </Link>{" "}
              switch SMS codes on, and choose what they may be used for. WhatsApp codes are not touched: either one is
              enough, and the apps pick the change up at once.
            </p>
          </Step>

          <Step n={6} title="Watch the first few days" done={null} testId="sms-step-watch">
            <p>
              The{" "}
              <Link
                href={smsPath("overview")}
                className="font-semibold text-sky-700 underline underline-offset-2 dark:text-sky-400"
              >
                Overview
              </Link>{" "}
              shows the balance, the month's codes and cost and anything that needs attention, and{" "}
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

      <Panel title="Codes that arrive as a phone call" icon={PhoneCall} testId="sms-setup-voice">
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          {name} sometimes delivers the code as a <b>voice call</b> instead of a text message. That happens at {name}'s
          end: the HRMS always asks for an SMS with the OTP template, and nothing in it can change how {name} delivers
          it. If employees report calls, check in the {name} panel that the OTP template and the sender ID are approved
          for SMS, or ask {name} support.
        </p>
      </Panel>

      <Panel title="The full guide" icon={BookOpen} testId="sms-setup-docs">
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
          <span>The whole integration is written up, with the {name} API used and why, in the project's docs file</span>
          <code className="rounded bg-muted px-1.5 py-0.5 text-[12px] font-semibold text-foreground">{DOCS_FILE}</code>
          <CopyButton text={DOCS_FILE} what="the docs file name" />
        </div>
      </Panel>
    </div>
  );
}

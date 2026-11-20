import { useState, type FormEvent } from "react";
import { Link } from "wouter";
import { FlaskConical, Hash, Lock, Send, Smartphone, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useSendSmsTest,
  useSmsOverview,
  type SmsOverview,
  type SmsTestInput,
  type SmsTestResult,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import {
  MOBILE_HELP,
  PROVIDER_NAME,
  TEST_CODE,
  TWOFACTOR_SENDER_ID,
  VIEW_ONLY_TEXT,
  codesText,
  failureText,
  hidePhone,
  missingEnv,
  normalizeMobile,
  templatePreview,
} from "./logic";
import { smsPath } from "./routes";
import { Notice, Panel, useLockedWhy } from "./ui";

/** Why a test cannot be sent from here, in a sentence (null when it can). Worked out from the overview. A test does not need
 *  SMS codes to be switched on: it is how HR checks the set-up before switching them on. */
function whyNot(o: SmsOverview | undefined): { text: string; to?: string; linkLabel?: string } | null {
  if (!o) return null;
  const name = PROVIDER_NAME;
  if (!o.configured) {
    const missing = missingEnv(o);
    return {
      text:
        missing.length > 0
          ? `${name} is not set up on the server yet. Not set: ${missing.join(", ")}.`
          : `${name} is not set up on the server yet: a value still looks like the example text.`,
      to: smsPath("setup"),
      linkLabel: "Open the setup steps",
    };
  }
  if (!o.sendingAllowed) {
    return { text: o.sendingNote || "This machine is not allowed to send SMS." };
  }
  if (o.paused) {
    return {
      text: o.pauseReason || `SMS sending is paused after repeated ${name} failures.`,
      to: smsPath("messages", undefined, "status=failed"),
      linkLabel: "See the failures",
    };
  }
  return null;
}

type Mode = "employee" | "phone";

const MODES: { value: Mode; label: string; icon: typeof UserRound }[] = [
  { value: "employee", label: "An employee", icon: UserRound },
  { value: "phone", label: "A mobile number", icon: Smartphone },
];

/** The SMS as a phone shows it: the sender's name over one incoming bubble. */
function SmsPreview({ sender, text }: { sender: string; text: string }) {
  return (
    <div className="mx-auto w-full max-w-xs rounded-[1.75rem] border-4 border-slate-800 bg-slate-100 p-3 shadow-sm dark:border-slate-600 dark:bg-slate-900">
      <p className="text-center text-[11px] font-semibold text-slate-500 dark:text-slate-400">{sender}</p>
      <p className="text-center text-[10px] text-slate-400">Text message · now</p>
      <div
        className="mt-3 rounded-2xl rounded-bl-sm bg-white px-3.5 py-2.5 text-[13px] leading-relaxed text-slate-900 shadow-sm dark:bg-slate-800 dark:text-slate-100"
        data-testid="sms-test-preview"
      >
        {text}
      </div>
    </div>
  );
}

/**
 * Test: send one test CODE through the real OTP template (the made-up code 1234; there is no free text, here or anywhere) to
 * an employee's registered number (by employee code) or to a typed number. It counts against the caps and is logged as a test
 * like any other SMS. On a development machine only the employees in SMS_ONLY_TO_EMPLOYEES can get one. What the server says
 * is shown as it says it, including why it refused.
 */
export default function TestTab({ readOnly }: { readOnly: boolean }) {
  const lockedWhy = useLockedWhy();
  const overview = useSmsOverview();
  const send = useSendSmsTest();
  const [mode, setMode] = useState<Mode>("employee");
  const [code, setCode] = useState("");
  const [phone, setPhone] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<
    { to: string; result: SmsTestResult } | { to: string; failure: string } | null
  >(null);

  const o = overview.data;
  const blocked = whyNot(o);
  const devLock = o?.devLock ?? [];
  const name = PROVIDER_NAME;
  const sender = o?.env.senderId || TWOFACTOR_SENDER_ID;

  const pick = (next: Mode) => {
    setMode(next);
    setProblem(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (readOnly || blocked || send.isPending) return;
    let input: SmsTestInput;
    let to: string;
    if (mode === "employee") {
      const typed = code.trim();
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(typed)) {
        setProblem("Enter the employee's code, for example 30020.");
        return;
      }
      input = { employeeCode: typed };
      to = `employee ${typed}`;
    } else {
      const mobile = normalizeMobile(phone);
      if (!mobile.ok) {
        setProblem(mobile.error);
        return;
      }
      input = { phone: mobile.phone };
      to = hidePhone(mobile.phone);
    }
    setProblem(null);
    setOutcome(null);
    try {
      const result = await send.mutateAsync(input);
      setOutcome({ to, result });
    } catch (err) {
      setOutcome({ to, failure: failureText(err, "send the test code") });
    }
  };

  const inputId = mode === "employee" ? "sms-test-employee" : "sms-test-phone";

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]" data-testid="sms-test">
      <Panel
        title="Send a test code"
        description={`Sends one real SMS through ${name} with the OTP template and the made-up code ${TEST_CODE}, so you can see that ${name} accepts it and how it reads.`}
        icon={FlaskConical}
      >
        <form onSubmit={(e) => void submit(e)} className="space-y-4" noValidate>
          <fieldset className="space-y-2" disabled={readOnly || send.isPending}>
            <legend className="text-xs font-semibold">Send it to</legend>
            <div role="radiogroup" aria-label="Send it to" className="flex flex-wrap gap-2" data-testid="sms-test-mode">
              {MODES.map((m) => {
                const on = mode === m.value;
                return (
                  <button
                    key={m.value}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => pick(m.value)}
                    data-testid={`sms-test-mode-${m.value}`}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors",
                      on
                        ? "border-sky-600 bg-sky-600 text-white"
                        : "border-border bg-card text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <m.icon size={13} /> {m.label}
                  </button>
                );
              })}
            </div>
          </fieldset>

          <div className="space-y-1.5">
            <Label htmlFor={inputId} className="text-xs font-semibold">
              {mode === "employee" ? "Employee code" : "Mobile number"}
            </Label>
            <div className="flex flex-wrap items-start gap-2">
              <div className="relative min-w-0 flex-1 basis-48">
                {mode === "employee" ? (
                  <Hash
                    size={14}
                    className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                  />
                ) : (
                  <Smartphone
                    size={14}
                    className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                  />
                )}
                <Input
                  key={mode}
                  id={inputId}
                  type={mode === "employee" ? "text" : "tel"}
                  inputMode={mode === "employee" ? "text" : "tel"}
                  autoComplete="off"
                  value={mode === "employee" ? code : phone}
                  onChange={(e) => {
                    if (mode === "employee") setCode(e.target.value);
                    else setPhone(e.target.value);
                    if (problem) setProblem(null);
                  }}
                  placeholder={mode === "employee" ? (devLock[0] ?? "30020") : "9876543210"}
                  disabled={readOnly || send.isPending}
                  aria-invalid={problem ? true : undefined}
                  aria-describedby="sms-test-help"
                  className="pl-8"
                  data-testid={inputId}
                />
              </div>
              <Button
                type="submit"
                disabled={readOnly || send.isPending || blocked !== null}
                data-testid="sms-test-send"
                className="shrink-0"
              >
                <Send size={14} /> {send.isPending ? "Sending…" : "Send a test code"}
              </Button>
            </div>
            {problem ? (
              <p id="sms-test-help" role="alert" className="text-xs font-medium text-red-600 dark:text-red-400">
                {problem}
              </p>
            ) : (
              <p id="sms-test-help" className="text-xs text-muted-foreground">
                {mode === "employee"
                  ? "The code goes to the mobile number on the employee's record."
                  : `${MOBILE_HELP} Try your own phone first.`}
              </p>
            )}
          </div>

          {devLock.length > 0 && (
            <Notice tone="info" icon={Lock} testId="sms-test-dev-lock">
              <p>
                This development machine texts only employee {codesText(devLock)} (SMS_ONLY_TO_EMPLOYEES). Any other
                employee or number is refused, so a test can never reach a real employee by mistake.
              </p>
              {mode === "employee" && !readOnly && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {devLock.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => {
                        setCode(c);
                        setProblem(null);
                      }}
                      className="rounded-full border border-sky-300 bg-card px-2.5 py-0.5 text-xs font-semibold text-sky-800 hover:bg-sky-100 dark:border-sky-700 dark:text-sky-200 dark:hover:bg-sky-900"
                      data-testid={`sms-test-pick-${c}`}
                    >
                      Use {c}
                    </button>
                  ))}
                </div>
              )}
            </Notice>
          )}
          {readOnly && (
            <Notice tone="info" testId="sms-test-view-only">
              {lockedWhy ?? VIEW_ONLY_TEXT}
            </Notice>
          )}
          {blocked && (
            <Notice tone="warn" testId="sms-test-blocked">
              {blocked.text}{" "}
              {blocked.to && (
                <Link href={blocked.to} className="font-semibold underline underline-offset-2">
                  {blocked.linkLabel}
                </Link>
              )}
            </Notice>
          )}
          {outcome && (
            <div aria-live="polite" data-testid="sms-test-outcome">
              {"failure" in outcome ? (
                <Notice tone="bad" role="alert" testId="sms-test-failed">
                  <p className="font-semibold">The test was not sent to {outcome.to}.</p>
                  <p>{outcome.failure}</p>
                </Notice>
              ) : outcome.result.ok ? (
                <Notice tone="good" role="status" testId="sms-test-ok">
                  <p className="font-semibold">Sent to {outcome.to}.</p>
                  <p>{outcome.result.message}</p>
                </Notice>
              ) : (
                <Notice tone="bad" role="alert" testId="sms-test-refused">
                  <p className="font-semibold">The test was not sent to {outcome.to}.</p>
                  <p>{outcome.result.message}</p>
                </Notice>
              )}
            </div>
          )}
        </form>

        <ul className="mt-4 list-disc space-y-1 pl-5 text-xs leading-snug text-muted-foreground">
          <li>You can send 3 tests an hour. Each one counts against the hourly and daily caps and costs a real SMS.</li>
          <li>A test works while SMS codes are off, so the set-up can be checked before they are switched on.</li>
          <li>
            It is saved in the{" "}
            <Link href={smsPath("messages")} className="font-semibold underline underline-offset-2">
              Messages
            </Link>{" "}
            list as a test code, with the number hidden except its last four digits.
          </li>
          <li>
            The code in a test is always {TEST_CODE}. It is not a real code and opens nothing. Only the OTP template can
            be sent: the HRMS has no way to send any other SMS text.
          </li>
        </ul>
      </Panel>

      <Panel
        title="What the SMS looks like"
        description={`The approved ${name} OTP template, with the test code.`}
        testId="sms-test-preview-panel"
      >
        <SmsPreview sender={sender} text={templatePreview(TEST_CODE)} />
        <p className="mt-3 text-xs text-muted-foreground">
          The words must match the template approved with {name} exactly, or {name} refuses the message. They are on the
          Setup tab, with a Copy button.
        </p>
      </Panel>
    </div>
  );
}

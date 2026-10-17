import { useState, type FormEvent } from "react";
import { Link } from "wouter";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSendSmsTest, useSmsOverview, type SmsOverview, type SmsTestResult } from "@/lib/api-client/custom-hooks";
import {
  MOBILE_HELP,
  TEST_CODE,
  VIEW_ONLY_TEXT,
  failureText,
  formatClock,
  missingEnv,
  normalizeMobile,
  PROVIDER_NAME,
  templatePreview,
} from "./logic";
import { smsPath } from "./routes";
import { Notice, Panel, useLockedWhy } from "./ui";

/** Why a test cannot be sent from here, in a sentence (null when it can). Worked out from the overview. */
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
  if (o.circuit.paused) {
    return {
      text: `SMS sending is paused after repeated ${name} failures${o.circuit.until ? ` until ${formatClock(o.circuit.until)}` : ""}.`,
      to: smsPath("messages", undefined, "status=failed"),
      linkLabel: "See the failures",
    };
  }
  return null;
}

/** "9876543210" -> "••••••3210", the way the log shows it. */
const hide = (phone: string) => `••••••${phone.slice(-4)}`;

/**
 * Test: send one SMS through the real template, with the code 123456, to a number typed here. It counts against the caps and is
 * logged (as a test message) like any other. What the server says is shown as it says it, including why it refused.
 */
export default function TestTab({ readOnly }: { readOnly: boolean }) {
  const lockedWhy = useLockedWhy();
  const overview = useSmsOverview();
  const send = useSendSmsTest();
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<
    { to: string; result: SmsTestResult } | { to: string; failure: string } | null
  >(null);

  const blocked = whyNot(overview.data);
  const name = PROVIDER_NAME;
  const preview = templatePreview(TEST_CODE);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (readOnly || blocked || send.isPending) return;
    const mobile = normalizeMobile(value);
    if (!mobile.ok) {
      setProblem(mobile.error);
      return;
    }
    setProblem(null);
    setOutcome(null);
    try {
      const result = await send.mutateAsync(mobile.phone);
      setOutcome({ to: hide(mobile.phone), result });
    } catch (err) {
      setOutcome({ to: hide(mobile.phone), failure: failureText(err, "send the test SMS") });
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]" data-testid="sms-test">
      <Panel
        title="Send a test SMS"
        description={`Sends one real SMS through ${name}, with its approved template, to the number below, with the code 123456, so you can see that ${name} accepts it and how it reads.`}
        icon={Send}
      >
        <form onSubmit={(e) => void submit(e)} className="space-y-3" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="sms-test-phone" className="text-xs font-semibold">
              Mobile number
            </Label>
            <div className="flex flex-wrap items-start gap-2">
              <div className="min-w-0 flex-1 basis-48">
                <Input
                  id="sms-test-phone"
                  type="tel"
                  inputMode="tel"
                  autoComplete="off"
                  value={value}
                  onChange={(e) => {
                    setValue(e.target.value);
                    if (problem) setProblem(null);
                  }}
                  placeholder="9876543210"
                  disabled={readOnly || send.isPending}
                  aria-invalid={problem ? true : undefined}
                  aria-describedby="sms-test-help"
                  data-testid="sms-test-phone"
                />
              </div>
              <Button
                type="submit"
                disabled={readOnly || send.isPending || blocked !== null}
                data-testid="sms-test-send"
                className="shrink-0"
              >
                <Send size={14} /> {send.isPending ? "Sending…" : "Send a test SMS"}
              </Button>
            </div>
            {problem ? (
              <p id="sms-test-help" role="alert" className="text-xs font-medium text-red-600 dark:text-red-400">
                {problem}
              </p>
            ) : (
              <p id="sms-test-help" className="text-xs text-muted-foreground">
                {MOBILE_HELP} Try your own phone first.
              </p>
            )}
          </div>

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
          <li>
            It is saved in the{" "}
            <Link href={smsPath("messages")} className="font-semibold underline underline-offset-2">
              Messages
            </Link>{" "}
            list as a test message, with the number hidden except its last four digits.
          </li>
          <li>The code in a test is always {TEST_CODE}. It is not a real code and opens nothing.</li>
        </ul>
      </Panel>

      <Panel
        title="What the SMS looks like"
        description={`The approved ${name} template, with a made-up code.`}
        testId="sms-test-preview-panel"
      >
        <div
          className="rounded-2xl rounded-bl-sm border bg-muted/40 px-3.5 py-3 text-sm leading-relaxed"
          data-testid="sms-test-preview"
        >
          {preview}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          The words must match the template approved with {name} exactly, or {name} refuses the message. They are on the
          Setup tab, with a Copy button.
        </p>
      </Panel>
    </div>
  );
}

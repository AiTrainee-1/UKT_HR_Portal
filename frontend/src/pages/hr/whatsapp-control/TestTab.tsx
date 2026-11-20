import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Eye,
  FlaskConical,
  Loader2,
  MessageCircle,
  Search,
  Send,
  ShieldAlert,
  UserRound,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useWhatsAppTestMessage,
  useWhatsAppTestOptions,
  whatsAppErrorMessage,
  type WhatsAppTestRecipient,
  type WhatsAppTestResult,
  type WhatsAppTestType,
} from "@/lib/api-client/custom-hooks";
import { ApiError } from "@/lib/api-client/custom-fetch";
import { cn } from "@/lib/utils";
import { Fact, Notice, Panel, RawJson, TemplateStatusChip, WhatsAppPreview } from "./kit";
import { employeeCodesText, groupTestTypes, metaErrorHelp, recipientLabel } from "./logic";
import { useDebounced } from "./shared";

const SELECT =
  "h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-ring";

/** One employee who can receive the test: a row to pick (or the picked one, with a way to change it). */
function RecipientRow({ r, picked, onPick }: { r: WhatsAppTestRecipient; picked: boolean; onPick?: () => void }) {
  const blocked = !r.hasPhone || !!r.blockedReason;
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={!onPick || blocked}
      aria-pressed={picked}
      data-testid={`wa-test-recipient-${r.id}`}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors",
        picked
          ? "border-emerald-400 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-950"
          : "bg-card hover:border-emerald-300",
        blocked && "cursor-not-allowed opacity-70 hover:border-border",
        !onPick && "cursor-default",
      )}
    >
      <span
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
          picked ? "bg-emerald-600 text-white" : "bg-muted text-muted-foreground",
        )}
      >
        {picked ? <Check size={15} /> : <UserRound size={15} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{r.name}</span>
        <span className="block text-[11px] text-muted-foreground">
          {r.code} · {r.phone ?? "no phone"}
        </span>
        {(r.blockedReason || !r.hasPhone) && (
          <span className="mt-0.5 block text-[11px] font-medium text-amber-700 dark:text-amber-300">
            {r.blockedReason ?? "No phone number on file"}
          </span>
        )}
      </span>
    </button>
  );
}

/** The template and parameters the preview would send, as Meta receives them. */
function TemplateFacts({ preview }: { preview: WhatsAppTestResult }) {
  return (
    <div className="rounded-xl border bg-muted/40 px-3 py-1" data-testid="wa-test-template">
      <Fact label="Template">
        <code className="font-mono text-xs" data-testid="wa-test-template-name">
          {preview.templateName ?? "—"}
        </code>
        {preview.language && <span className="ml-1.5 text-xs text-muted-foreground">({preview.language})</span>}
      </Fact>
      {preview.header && <Fact label="Attachment">{preview.header === "image" ? "Photo" : "Document (PDF)"}</Fact>}
      {preview.params.length > 0 && (
        <div className="border-t py-2" data-testid="wa-test-params">
          <p className="mb-1 text-[13px] text-muted-foreground">Parameters</p>
          <dl className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            {preview.params.map((p, i) => (
              <div key={`${p.name}-${i}`} className="contents">
                <dt className="truncate font-mono text-muted-foreground">{p.name ? `{{${p.name}}}` : `#${i + 1}`}</dt>
                <dd className="min-w-0 break-words">{p.value || "—"}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}

/** What happened to a real send: Meta's message id, or its error code and sentence, or this machine's rule. */
function TestOutcome({ result }: { result: WhatsAppTestResult }) {
  const who = result.employee ? recipientLabel(result.employee) : (result.to ?? "the employee");
  if (result.status === "sent") {
    return (
      <div className="space-y-2" data-testid="wa-test-result" data-status="sent">
        <Notice tone="good" title={`Sent to ${who}`} role="status">
          <p>
            Meta accepted it
            {result.providerMessageId && (
              <>
                {" "}
                (message id{" "}
                <code className="break-all rounded bg-card px-1 py-0.5 text-[11px]" data-testid="wa-test-provider-id">
                  {result.providerMessageId}
                </code>
                )
              </>
            )}
            . It should arrive in a few seconds.
          </p>
          {result.testCode && (
            <p className="mt-1" data-testid="wa-test-code-sent">
              The test code sent is <code className="rounded bg-card px-1 py-0.5 font-mono">{result.testCode}</code>: it
              signs nobody in.
            </p>
          )}
          <p className="mt-1">
            It is saved on the Messages tab{result.logId !== null ? ` (#${result.logId})` : ""}; Delivered and Read show
            there when Meta reports them.
          </p>
        </Notice>
        {result.providerResponse !== null && (
          <RawJson summary="Meta's answer" value={result.providerResponse} testId="wa-test-provider-response" />
        )}
      </div>
    );
  }
  if (result.status === "blocked") {
    return (
      <div data-testid="wa-test-result" data-status="blocked">
        <Notice tone="warn" title="Not sent: held back before it reached Meta" role="alert">
          {result.error ?? "No reason was given."}
        </Notice>
      </div>
    );
  }
  const help = metaErrorHelp(result.errorCode);
  return (
    <div className="space-y-2" data-testid="wa-test-result" data-status="failed">
      <Notice tone="bad" title={`Meta did not send it to ${who}`} role="alert">
        <p className="font-semibold" data-testid="wa-test-error">
          {result.error ?? "No reason was given."}
        </p>
        {(result.errorCode !== null || result.httpStatus !== null) && (
          <p className="mt-0.5 text-xs" data-testid="wa-test-code">
            {result.errorCode !== null ? `Meta error ${result.errorCode}` : ""}
            {result.errorCode !== null && result.httpStatus !== null ? " · " : ""}
            {result.httpStatus !== null ? `HTTP ${result.httpStatus}` : ""}
          </p>
        )}
        {help && (
          <p className="mt-1 text-xs" data-testid="wa-test-help">
            {help}
          </p>
        )}
      </Notice>
      {result.providerResponse !== null && (
        <RawJson summary="Meta's answer" value={result.providerResponse} testId="wa-test-provider-response" />
      )}
    </div>
  );
}

/**
 * Send a test: one message of any type to one employee, sent at once (not queued) as its approved Meta template, with
 * Meta's real answer. It is previewed first (a dry run: the template, its parameters and the text, nothing sent) and
 * sent only after an in-page confirmation. A test ignores the switches, quiet hours and pacing, but never this machine's
 * safety rules (the server enforces them).
 */
export default function TestTab({ viewOnly = false }: { viewOnly?: boolean }) {
  const [search, setSearch] = useState("");
  const term = useDebounced(search, 350).trim();
  // the types, this machine's block and limit, and on a limited machine the allowed employees
  const base = useWhatsAppTestOptions("");
  const limitedTo = base.data?.limitedTo ?? null;
  const found = useWhatsAppTestOptions(term, !!base.data && !limitedTo && term !== "");

  const [documentType, setDocumentType] = useState("");
  const [recipient, setRecipient] = useState<WhatsAppTestRecipient | null>(null);
  const [preview, setPreview] = useState<WhatsAppTestResult | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<WhatsAppTestResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const previewer = useWhatsAppTestMessage();
  const sender = useWhatsAppTestMessage();
  // the type and employee the preview on its way is for: an answer for an earlier choice is dropped
  const asked = useRef("");

  const allowed = useMemo(() => (limitedTo ? (base.data?.recipients ?? []) : []), [limitedTo, base.data]);
  // a limited machine with one allowed employee: they are the only possible recipient
  useEffect(() => {
    if (!recipient && allowed.length === 1) setRecipient(allowed[0]);
  }, [allowed, recipient]);

  const groups = useMemo(() => groupTestTypes(base.data?.types ?? []), [base.data?.types]);
  const type: WhatsAppTestType | undefined = base.data?.types.find((t) => t.documentType === documentType);

  const startOver = () => {
    asked.current = "";
    setPreview(null);
    setConfirming(false);
    setResult(null);
    setProblem(null);
  };
  const pickType = (key: string) => {
    setDocumentType(key);
    startOver();
  };
  const pickRecipient = (r: WhatsAppTestRecipient | null) => {
    setRecipient(r);
    startOver();
  };

  const runPreview = () => {
    if (!recipient || !documentType) return;
    setProblem(null);
    setResult(null);
    setConfirming(false);
    const key = `${documentType}:${recipient.id}`;
    asked.current = key;
    previewer.mutate(
      { documentType, employeeId: recipient.id, dryRun: true },
      {
        onSuccess: (r) => {
          if (asked.current === key) setPreview(r);
        },
        onError: (e) =>
          setProblem(
            viewOnly && e instanceof ApiError && e.status === 403
              ? "The server refused the preview: it counts a preview as a change, and your role may only view this tab. Ask for edit access to Send a test to preview here."
              : `The preview could not be made: ${whatsAppErrorMessage(e, "try again.")}`,
          ),
      },
    );
  };

  const blockReason = base.data?.blockReason ?? preview?.blockReason ?? null;
  const why = viewOnly
    ? "View only: you can preview a test, but your role can't send one."
    : blockReason
      ? "Nothing can be sent: see the reason above."
      : !preview
        ? "Preview the message first."
        : null;
  const canSend = why === null && !sender.isPending;

  const send = () => {
    if (!recipient || !preview || !canSend) return;
    setProblem(null);
    sender.mutate(
      { documentType, employeeId: recipient.id },
      {
        onSuccess: (r) => {
          setResult(r);
          setConfirming(false);
        },
        onError: (e) => {
          setConfirming(false);
          setProblem(`The test was not sent: ${whatsAppErrorMessage(e, "try again.")}`);
        },
      },
    );
  };

  if (base.isError && !base.data) {
    return (
      <Notice tone="bad" title="Send a test isn't available right now" testId="wa-test-unavailable" role="alert">
        {whatsAppErrorMessage(base.error, "The server did not answer. Try again.")}
      </Notice>
    );
  }
  if (!base.data) return <Skeleton className="h-96 rounded-2xl" />;

  const searchHits = term ? (found.data?.recipients ?? []) : [];

  return (
    <div className="space-y-4" data-testid="wa-test-tab">
      <Notice tone="info" icon={FlaskConical} title="A test goes out at once, to one employee" testId="wa-test-rules">
        It skips the queue and ignores the switches, quiet hours and sending limits, so you can check a template even
        while its message is switched off. It never skips this machine's safety rules (the Meta keys, the
        development-machine lock, the employees it may message), and it needs the type's template to be approved by
        Meta. Every test is saved on the Messages tab and counts towards the month's cost.
      </Notice>

      {base.data.blockReason && (
        <Notice
          tone="bad"
          icon={ShieldAlert}
          title="Nothing can be sent from this machine"
          testId="wa-test-block"
          role="alert"
        >
          {base.data.blockReason}
        </Notice>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="1. What and to whom"
          icon={MessageCircle}
          description="The type's Meta template, filled with sample values and the employee's own name."
          testId="wa-test-form"
        >
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="wa-test-type" className="text-xs font-semibold">
                Message type
              </Label>
              <select
                id="wa-test-type"
                value={documentType}
                onChange={(e) => pickType(e.target.value)}
                className={SELECT}
                data-testid="wa-test-type"
              >
                <option value="">Choose a message type…</option>
                {groups.map((g) => (
                  <optgroup key={g.module} label={g.label}>
                    {g.types.map((t) => (
                      <option key={t.documentType} value={t.documentType}>
                        {t.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              {type && (type.templateName || type.templateStatus) && (
                <p
                  className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground"
                  data-testid="wa-test-type-template"
                >
                  Sent as <code className="font-mono">{type.templateName ?? "its template"}</code>
                  {type.templateStatus && <TemplateStatusChip status={type.templateStatus} />}
                </p>
              )}
            </div>

            <div className="space-y-1.5" data-view-safe>
              <p className="text-xs font-semibold">Send it to</p>
              {limitedTo ? (
                <>
                  <Notice tone="warn" testId="wa-test-limited">
                    This machine may only message {employeeCodesText(limitedTo)} (WHATSAPP_ONLY_TO_EMPLOYEES), so{" "}
                    {allowed.length === 1 ? "they are the only one who can get a test here." : "only they are listed."}
                  </Notice>
                  {allowed.length === 0 ? (
                    <p className="text-xs text-red-700 dark:text-red-300">
                      None of those employees is active in your branches, so no test can be sent from here.
                    </p>
                  ) : (
                    <div className="space-y-1.5">
                      {allowed.map((r) => (
                        <RecipientRow
                          key={r.id}
                          r={r}
                          picked={recipient?.id === r.id}
                          onPick={allowed.length > 1 ? () => pickRecipient(r) : undefined}
                        />
                      ))}
                    </div>
                  )}
                </>
              ) : recipient ? (
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <RecipientRow r={recipient} picked />
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 shrink-0 gap-1 text-xs"
                    onClick={() => pickRecipient(null)}
                    data-testid="wa-test-change-recipient"
                  >
                    <X size={12} /> Change
                  </Button>
                </div>
              ) : (
                <>
                  <div className="relative">
                    <Search size={14} className="pointer-events-none absolute left-2.5 top-2.5 text-muted-foreground" />
                    <Input
                      type="search"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search by name or employee code"
                      className="pl-8"
                      aria-label="Search employees"
                      data-testid="wa-test-search"
                    />
                  </div>
                  {term === "" ? (
                    <p className="text-[11px] text-muted-foreground">
                      Type a name or code to find the employee (up to 20 shown).
                    </p>
                  ) : found.isFetching && searchHits.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground">Searching…</p>
                  ) : searchHits.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground">No active employee matches "{term}".</p>
                  ) : (
                    <div className="max-h-72 space-y-1.5 overflow-y-auto pr-0.5" data-testid="wa-test-hits">
                      {searchHits.map((r) => (
                        <RecipientRow key={r.id} r={r} picked={false} onPick={() => pickRecipient(r)} />
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            <Button
              onClick={runPreview}
              disabled={!documentType || !recipient || previewer.isPending}
              variant="outline"
              className="w-full gap-1.5 sm:w-auto"
              data-testid="wa-test-preview"
            >
              {previewer.isPending ? <Loader2 size={14} className="animate-spin" /> : <Eye size={14} />}
              {preview ? "Preview again" : "Preview"}
            </Button>
          </div>
        </Panel>

        <Panel
          title="2. Check it, then send"
          icon={Send}
          description="Exactly what Meta is asked to send. Nothing goes out until you confirm."
          testId="wa-test-send-panel"
        >
          <div className="space-y-3">
            {preview ? (
              <>
                <WhatsAppPreview body={preview.text} header={preview.header} testId="wa-test-bubble" />
                <TemplateFacts preview={preview} />
              </>
            ) : (
              <p
                className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground"
                data-testid="wa-test-empty"
              >
                Pick a message type and who gets it, then press Preview.
              </p>
            )}

            {problem && (
              <Notice tone="bad" testId="wa-test-problem" role="alert">
                {problem}
              </Notice>
            )}

            {preview?.blockReason && !base.data.blockReason && (
              <Notice tone="warn" title="This test would not be sent" testId="wa-test-preview-block">
                {preview.blockReason}
              </Notice>
            )}

            {preview &&
              (confirming && recipient ? (
                <div
                  className="space-y-2 rounded-xl border-2 border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950"
                  data-testid="wa-test-confirm-box"
                  role="alertdialog"
                  aria-label="Confirm the test"
                >
                  <p className="text-sm font-bold">Send this to {recipientLabel(recipient)} now?</p>
                  <p className="text-xs">
                    It goes out at once from the company WhatsApp number as{" "}
                    <code className="font-mono">{preview.templateName ?? "its template"}</code>. A sent message can't be
                    called back.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
                      onClick={send}
                      disabled={!canSend}
                      data-testid="wa-test-confirm"
                    >
                      {sender.isPending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
                      {sender.isPending ? "Sending…" : "Yes, send now"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setConfirming(false)}
                      disabled={sender.isPending}
                      data-testid="wa-test-cancel"
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Button
                    onClick={() => {
                      setResult(null);
                      setConfirming(true);
                    }}
                    disabled={!canSend}
                    className="w-full gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700 sm:w-auto"
                    data-testid="wa-test-send"
                  >
                    <Send size={14} /> Send test message
                  </Button>
                  {why && (
                    <p className="text-[11px] text-muted-foreground" data-testid="wa-test-why">
                      {why}
                    </p>
                  )}
                </div>
              ))}

            {result && <TestOutcome result={result} />}
          </div>
        </Panel>
      </div>
    </div>
  );
}

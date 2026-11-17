import { useEffect, useMemo, useRef, useState } from "react";
import { Eye, FileText, MessageCircle, Pencil, Search } from "lucide-react";
import { useUrlParams } from "@/components/payroll/kit/url-state";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { Textarea } from "@/components/ui/textarea";
import { useDebounced, useDraft } from "@/hooks/use-debounced";
import { useToast } from "@/hooks/use-toast";
import {
  usePreviewPushTemplate,
  usePushTemplates,
  useSavePushTemplate,
  type PushTemplate,
  type PushTemplatePreview,
  type PushTemplateVariable,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import {
  bodyCount,
  errorText,
  formatNumber,
  formatWhen,
  groupTemplates,
  insertAt,
  isWordingDirty,
  placeholderToken,
  templateStatus,
  titleCount,
  wordingBody,
  wordingProblem,
  type CountTone,
} from "./logic";
import { PhoneNotificationCard } from "./PhonePreview";
import { FilterChips, InlineConfirm, LoadError, Notice, Panel, useLockedWhy } from "./ui";

// The search and the "custom only" filter live in the address (?q=salary&custom=1), like the other tabs' filters.
type TemplatesUrl = { q: string; custom: string };
const URL_DEFAULTS: TemplatesUrl = { q: "", custom: "" };

const COUNT_TONE: Record<CountTone, string> = {
  ok: "text-muted-foreground",
  long: "font-semibold text-amber-700 dark:text-amber-400",
  over: "font-semibold text-red-700 dark:text-red-400",
};

type Field = "title" | "body";

// ── the editor ────────────────────────────────────────────────────────────────

/**
 * The editor of one kind's wording: the title and the message with their counters, the placeholders (a click puts one where
 * the cursor is in the field used last), the built-in wording (and a way to start from it), and a live preview drawn as the
 * phone shows it (the server fills in the sample values and says what is wrong). Save, Reset to the built-in wording (asks
 * first), and closing with unsaved changes (asks first). A View-only login sees it all, with nothing it can change.
 */
function TemplateEditor({ t, locked, onClose }: { t: PushTemplate; locked: string | null; onClose: () => void }) {
  const { toast } = useToast();
  const save = useSavePushTemplate();
  const previewer = usePreviewPushTemplate();
  const [title, setTitle] = useState(t.title);
  const [body, setBody] = useState(t.body);
  const [preview, setPreview] = useState<PushTemplatePreview>({ ...t.preview, error: null });
  const [previewFailed, setPreviewFailed] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [ask, setAsk] = useState<"reset" | "discard" | null>(null);
  const [hint, setHint] = useState<PushTemplateVariable | null>(null);
  const [field, setField] = useState<Field>("body");
  const titleRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  // a field never used yet has no cursor of its own: a placeholder goes at its end
  const used = useRef<Record<Field, boolean>>({ title: false, body: false });

  const readOnly = locked !== null;
  const dirty = isWordingDirty(t, title, body);
  const problem = wordingProblem(title, body);
  const tCount = titleCount(title);
  const bCount = bodyCount(body);

  // the preview follows the fields once typing pauses; what is saved already is the row's own preview
  const shownTitle = useDebounced(title);
  const shownBody = useDebounced(body);
  const asked = useRef(`${t.title}\u0000${t.body}`);
  const seq = useRef(0);
  useEffect(() => {
    const pair = `${shownTitle}\u0000${shownBody}`;
    if (pair === asked.current) return;
    asked.current = pair;
    const n = ++seq.current;
    previewer.mutate(
      { key: t.key, title: shownTitle, body: shownBody },
      {
        onSuccess: (r) => {
          if (n !== seq.current) return;
          setPreview(r);
          setPreviewFailed(false);
        },
        onError: () => {
          if (n === seq.current) setPreviewFailed(true);
        },
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownTitle, shownBody, t.key]);

  const edit = (which: Field, value: string) => {
    setSaveError(null);
    if (ask === "reset") setAsk(null);
    if (which === "title") setTitle(value);
    else setBody(value);
  };

  const insert = (name: string) => {
    if (readOnly) return;
    const token = placeholderToken(name);
    const el = field === "title" ? titleRef.current : bodyRef.current;
    const value = field === "title" ? title : body;
    const r = used.current[field]
      ? insertAt(value, token, el?.selectionStart, el?.selectionEnd)
      : insertAt(value, token);
    used.current[field] = true;
    edit(field, r.value);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(r.caret, r.caret);
    });
  };

  const startFromDefault = () => {
    edit("title", t.defaultTitle);
    edit("body", t.defaultBody);
  };

  const doSave = (wording: { title: string; body: string }) => {
    setSaveError(null);
    save.mutate(
      { key: t.key, ...wording },
      {
        onSuccess: () => {
          toast({
            title:
              wording.title || wording.body
                ? `${t.label}: phone wording saved`
                : `${t.label}: back to the built-in wording`,
            description: "It applies to the next notification of this kind.",
          });
          onClose();
        },
        onError: (e) => {
          setAsk(null);
          setSaveError(errorText(e, "Try again."));
        },
      },
    );
  };

  const requestClose = () => {
    if (dirty && !readOnly) setAsk("discard");
    else onClose();
  };

  const fieldName = field === "title" ? "the title" : "the message";

  return (
    <Dialog open onOpenChange={(open) => !open && requestClose()}>
      <DialogContent
        className="max-h-[92vh] w-[calc(100%-1rem)] max-w-5xl overflow-y-auto p-4 dark:border-slate-700 dark:bg-slate-900 sm:p-6"
        data-testid="pn-template-editor"
      >
        <DialogHeader className="pr-8 text-left">
          <DialogTitle className="flex flex-wrap items-center gap-2 text-base">
            {t.label}
            {t.customised ? (
              <StatusBadge tone="accent">Custom</StatusBadge>
            ) : (
              <StatusBadge tone="neutral">Default</StatusBadge>
            )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t.categoryLabel}
            {t.description ? ` · ${t.description}` : ""}
          </DialogDescription>
        </DialogHeader>

        {readOnly && (
          <Notice tone="neutral" testId="pn-template-locked">
            {locked}
          </Notice>
        )}

        <div className="grid min-w-0 gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
          <div className="min-w-0 space-y-4">
            <Notice tone="neutral" testId="pn-template-origin">
              {t.origin === "whatsapp" ? (
                <>
                  This message also goes by WhatsApp. Until a phone version is saved here, the phone shows
                  WhatsApp&apos;s wording; a version saved here changes the phone notification only. The placeholders
                  are WhatsApp&apos;s for this message.
                </>
              ) : (
                <>
                  <code>{"{{headline}}"}</code> is the built-in title and <code>{"{{message}}"}</code> the built-in
                  sentence: use them to wrap the built-in text, for example <i>Action needed: {"{{message}}"}</i>.
                </>
              )}
            </Notice>

            <div className="space-y-1">
              <label htmlFor="pn-template-title" className="text-xs font-semibold">
                Title
              </label>
              <Input
                id="pn-template-title"
                ref={titleRef}
                value={title}
                onChange={(e) => edit("title", e.target.value)}
                onFocus={() => {
                  used.current.title = true;
                  setField("title");
                }}
                placeholder={`Blank: ${t.defaultTitle}`}
                disabled={readOnly}
                data-testid="pn-template-title"
                className="text-sm"
              />
              <div className="flex flex-wrap items-start justify-between gap-x-3 text-[11px]">
                <span className="text-muted-foreground">
                  Phones show about 40 to 60 characters of it. Blank keeps the built-in title.
                </span>
                <span className={cn("tabular-nums", COUNT_TONE[tCount.tone])} data-testid="pn-template-title-count">
                  {tCount.text}
                </span>
              </div>
            </div>

            <div className="space-y-1">
              <label htmlFor="pn-template-body" className="text-xs font-semibold">
                Message
              </label>
              <Textarea
                id="pn-template-body"
                ref={bodyRef}
                value={body}
                onChange={(e) => edit("body", e.target.value)}
                onFocus={() => {
                  used.current.body = true;
                  setField("body");
                }}
                rows={6}
                placeholder={`Blank: ${t.defaultBody}`}
                disabled={readOnly}
                data-testid="pn-template-body"
                className="text-sm"
              />
              <div className="flex flex-wrap items-start justify-between gap-x-3 text-[11px]">
                <span className="text-muted-foreground">
                  Blank keeps the built-in message. A line whose placeholders are all empty is left out.
                </span>
                <span className={cn("tabular-nums", COUNT_TONE[bCount.tone])} data-testid="pn-template-body-count">
                  {bCount.text}
                </span>
              </div>
            </div>

            {t.variables.length > 0 && (
              <div className="space-y-1.5" data-testid="pn-template-chips">
                <p className="text-xs font-semibold">
                  Placeholders{" "}
                  <span className="font-normal text-muted-foreground">
                    (a click puts one where the cursor is in {fieldName})
                  </span>
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {t.variables.map((v) => (
                    <button
                      key={v.name}
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => insert(v.name)}
                      onMouseEnter={() => setHint(v)}
                      onFocus={() => setHint(v)}
                      onTouchStart={() => setHint(v)}
                      disabled={readOnly}
                      title={`${v.help}. Example: ${v.sample || "(empty)"}`}
                      data-testid={`pn-chip-${v.name}`}
                      className="rounded-md border bg-muted px-2 py-1 font-mono text-[11px] text-foreground transition-colors hover:border-indigo-300 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-60 dark:hover:bg-indigo-950"
                    >
                      {placeholderToken(v.name)}
                    </button>
                  ))}
                </div>
                <p className="min-h-4 text-[11px] text-muted-foreground" data-testid="pn-chip-hint">
                  {hint ? (
                    <>
                      <code className="text-foreground">{placeholderToken(hint.name)}</code>: {hint.help}. Example:{" "}
                      <b className="text-foreground">{hint.sample || "(empty)"}</b>
                    </>
                  ) : (
                    "Point at a placeholder, or touch and hold it, to see what it stands for."
                  )}
                </p>
              </div>
            )}

            <div className="rounded-xl border bg-muted p-3" data-testid="pn-template-default">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Built-in wording
              </p>
              <p className="mt-1 break-words text-sm font-semibold" data-testid="pn-template-default-title">
                {t.defaultTitle}
              </p>
              <p
                className="mt-0.5 whitespace-pre-line break-words font-mono text-xs"
                data-testid="pn-template-default-body"
              >
                {t.defaultBody}
              </p>
              {t.defaultNote && <p className="mt-2 text-[11px] text-muted-foreground">{t.defaultNote}</p>}
              <Button
                size="sm"
                variant="outline"
                className="mt-2 h-7 text-xs"
                disabled={readOnly}
                title={locked ?? "Copy the built-in title and message into the fields above"}
                onClick={startFromDefault}
                data-testid="pn-template-start-default"
              >
                Start from the built-in wording
              </Button>
            </div>
          </div>

          {/* beside a long form, the preview stays in view while it scrolls */}
          <div className="min-w-0 space-y-2 md:sticky md:top-0 md:self-start">
            <p className="text-xs font-semibold">
              Preview <span className="font-normal text-muted-foreground">(with sample values)</span>
            </p>
            <PhoneNotificationCard title={preview.title} body={preview.body} testId="pn-template-preview" />
            {preview.error && (
              <Notice tone="bad" role="alert" testId="pn-template-preview-error">
                {preview.error}
              </Notice>
            )}
            {previewFailed && (
              <p className="text-[11px] text-muted-foreground" data-testid="pn-template-preview-stale">
                The preview could not be updated; it shows the last wording that could be.
              </p>
            )}
            <p className="text-[11px] text-muted-foreground">
              {t.enabled
                ? "This kind is switched on, so phones get it with this wording."
                : "This kind is switched off on the Controls tab: nothing of it is pushed until it is switched on."}
            </p>
          </div>
        </div>

        {(problem || saveError) && (
          <Notice tone="bad" role="alert" testId="pn-template-save-error">
            {saveError ?? problem}
          </Notice>
        )}

        {ask === "reset" && (
          <InlineConfirm
            testId="pn-confirm-reset"
            stacked
            destructive
            confirmLabel="Reset to the built-in wording"
            pending={save.isPending}
            onConfirm={() => doSave({ title: "", body: "" })}
            onCancel={() => setAsk(null)}
          >
            Go back to the built-in wording of <b>{t.label}</b>? The custom title and message are deleted, and phones
            get the built-in wording (shown above) from the next notification.
          </InlineConfirm>
        )}
        {ask === "discard" && (
          <InlineConfirm
            testId="pn-confirm-discard"
            stacked
            confirmLabel="Discard changes"
            cancelLabel="Keep editing"
            onConfirm={onClose}
            onCancel={() => setAsk(null)}
          >
            Your changes to <b>{t.label}</b> are not saved. Close and lose them?
          </InlineConfirm>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
          <div>
            {t.customised && (
              <Button
                variant="ghost"
                size="sm"
                className="text-xs text-red-700 dark:text-red-400"
                disabled={readOnly || save.isPending}
                title={locked ?? undefined}
                onClick={() => setAsk("reset")}
                data-testid="pn-template-reset"
              >
                Reset to the built-in wording
              </Button>
            )}
          </div>
          <div className="ml-auto flex gap-2">
            <Button variant="outline" size="sm" onClick={requestClose} data-view-safe data-testid="pn-template-cancel">
              {readOnly ? "Close" : "Cancel"}
            </Button>
            <Button
              size="sm"
              onClick={() => doSave(wordingBody(title, body))}
              disabled={readOnly || save.isPending || !dirty || problem !== null}
              title={locked ?? (dirty ? undefined : "Nothing has changed yet")}
              data-testid="pn-template-save"
            >
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── the list ──────────────────────────────────────────────────────────────────

function TemplateRow({ t, locked, onOpen }: { t: PushTemplate; locked: string | null; onOpen: () => void }) {
  const status = templateStatus(t);
  return (
    <li
      className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3"
      data-testid={`pn-template-${t.key}`}
      data-custom={t.customised ? "true" : "false"}
    >
      <div className="min-w-0 flex-1 basis-64">
        <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold">
          {t.label}
          {t.origin === "whatsapp" && (
            <span title="The same message also goes by WhatsApp (WhatsApp Control has its own wording)">
              <StatusBadge tone="success">
                <MessageCircle size={10} className="mr-1" />
                Also by WhatsApp
              </StatusBadge>
            </span>
          )}
        </p>
        {t.description && (
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground" title={t.description}>
            {t.description}
          </p>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-1 text-[11px] sm:w-56" data-testid={`pn-template-state-${t.key}`}>
        <span className="flex flex-wrap items-center gap-1.5">
          <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
          {t.customised ? (
            <StatusBadge tone="accent">Custom</StatusBadge>
          ) : (
            <StatusBadge tone="neutral">Default</StatusBadge>
          )}
        </span>
        {t.customised && t.updatedBy && (
          <span className="text-muted-foreground">
            Edited by {t.updatedBy} on {formatWhen(t.updatedAt)}
          </span>
        )}
      </div>
      <div className="min-w-0 text-[11px] text-muted-foreground sm:w-48" data-testid={`pn-template-counts-${t.key}`}>
        <p>
          <b className="text-foreground">{formatNumber(t.total)}</b> sent · {formatNumber(t.sent)} pushed
          {t.failed > 0 ? (
            <span className="font-semibold text-red-700 dark:text-red-400"> · {formatNumber(t.failed)} failed</span>
          ) : (
            " · none failed"
          )}
        </p>
        <p>Last sent: {t.lastSentAt ? formatWhen(t.lastSentAt) : "never"}</p>
      </div>
      <Button
        size="sm"
        variant="outline"
        className="h-8 gap-1 text-xs"
        onClick={onOpen}
        data-view-safe
        aria-label={`${locked ? "View" : "Edit"} the wording of ${t.label}`}
        data-testid={`pn-template-edit-${t.key}`}
      >
        {locked ? <Eye size={12} /> : <Pencil size={12} />}
        {locked ? "View" : "Edit"}
      </Button>
    </li>
  );
}

/**
 * Message Text: the title and wording of every kind of automatic phone notification, by category, in the shape of WhatsApp
 * Control's Message Text. Each kind says whether it is switched on (Controls), whether its wording is the built-in one or
 * HR's, and how many were sent; Edit opens the editor with a live phone preview. HR's own messages (Send a message), notices
 * from the notifications API and Attendance Notify reports are not here: their words are written when they are sent.
 */
export default function MessageTextTab() {
  const locked = useLockedWhy();
  const { data, isLoading, isError, refetch } = usePushTemplates();
  const [url, setUrl] = useUrlParams(URL_DEFAULTS);
  const [text, setText] = useDraft(url.q, (next) => setUrl({ q: next }));
  const [openKey, setOpenKey] = useState<string | null>(null);
  const customOnly = url.custom === "1";
  const groups = useMemo(() => groupTemplates(data ?? [], { search: url.q, customOnly }), [data, url.q, customOnly]);

  if (isLoading) return <Skeleton className="h-96 rounded-2xl" />;
  if (isError || !data) {
    return <LoadError what="The message texts" onRetry={() => void refetch()} testId="pn-templates-error" />;
  }

  const custom = data.filter((t) => t.customised).length;
  const open = data.find((t) => t.key === openKey) ?? null;

  return (
    <div className="space-y-4" data-testid="pn-templates">
      <Notice tone="info">
        The title and wording of every kind of automatic phone notification. Placeholders such as{" "}
        <code>{"{{employee_name}}"}</code> or <code>{"{{date}}"}</code> are filled in when it is sent, and a line whose
        placeholders are all empty is left out. A kind that also goes by WhatsApp shows WhatsApp&apos;s wording on the
        phone until a phone version is saved here. Changes apply to the next notification.
      </Notice>
      <p className="text-xs text-muted-foreground" data-testid="pn-templates-not-listed">
        Not listed, on purpose: the messages HR writes on the Send a message tab, notices from the notifications API,
        and Attendance Notify reports. Their words are written when they are sent.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full sm:w-72">
          <Search
            size={13}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search the kinds of notification"
            aria-label="Search the kinds of notification"
            data-testid="pn-templates-search"
            className="h-8 w-full pl-8 text-xs"
          />
        </div>
        <FilterChips
          label="Wording"
          testId="pn-templates-filter"
          value={customOnly ? "1" : ""}
          onChange={(v) => setUrl({ custom: v })}
          items={[
            { value: "", label: "Every kind", count: data.length },
            { value: "1", label: "Custom only", count: custom },
          ]}
        />
      </div>

      {groups.length === 0 ? (
        <p
          className="rounded-2xl border bg-card py-10 text-center text-sm text-muted-foreground"
          data-testid="pn-templates-empty"
        >
          {customOnly && !url.q
            ? "No kind has a custom wording yet: every notification uses the built-in wording."
            : "No kind of notification matches."}
        </p>
      ) : (
        groups.map((g) => (
          <Panel
            key={g.key}
            title={g.label}
            icon={FileText}
            testId={`pn-template-group-${g.key}`}
            description={`${g.rows.length} ${g.rows.length === 1 ? "kind" : "kinds"}${g.custom ? `, ${g.custom} with a custom wording` : ""}`}
          >
            <ul className="divide-y">
              {g.rows.map((t) => (
                <TemplateRow key={t.key} t={t} locked={locked} onOpen={() => setOpenKey(t.key)} />
              ))}
            </ul>
          </Panel>
        ))
      )}

      {open && <TemplateEditor key={open.key} t={open} locked={locked} onClose={() => setOpenKey(null)} />}
    </div>
  );
}

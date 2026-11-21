import { Fragment, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FilePlus2, FileText, RefreshCw, Search, Trash2, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  useCreateMissingMetaTemplates,
  useDeleteMetaTemplate,
  useMetaTemplates,
  useSyncMetaTemplates,
  useWhatsAppControlSettings,
  whatsAppErrorMessage,
  type WhatsAppCreateMissingResult,
  type WhatsAppMetaTemplate,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { Chip, Empty, Notice, Panel, TemplateStatusChip, WhatsAppPreview } from "./kit";
import {
  TEMPLATE_STATE_INFO,
  controlSections,
  missingTemplateRows,
  plural,
  pricingLabel,
  templateExamples,
  templateParts,
  renderTemplate,
  templateState,
  timeAgo,
  type TemplateState,
  type TypeRow,
} from "./logic";
import TemplateEditorDialog from "./TemplateEditor";
import { ConfirmDialog, fmtDateTime } from "./shared";
import type { WaAccess, WaTab } from "./tabs";

type Filter = "all" | "approved" | "pending" | "problem";

const FILTERS: { value: Filter; label: string; states: TemplateState[] }[] = [
  { value: "all", label: "All", states: [] },
  { value: "approved", label: "Approved", states: ["approved"] },
  { value: "pending", label: "In review", states: ["pending"] },
  { value: "problem", label: "Rejected / paused", states: ["rejected", "paused", "disabled", "unknown"] },
];

const QUALITY_TONE: Record<string, "good" | "warn" | "bad"> = { GREEN: "good", YELLOW: "warn", RED: "bad" };

/** A stored template drawn on the phone, from Meta's components and examples. */
function StoredPreview({ t }: { t: WhatsAppMetaTemplate }) {
  const parts = templateParts(t.components);
  const examples = templateExamples(t.components);
  const auth = t.category === "AUTHENTICATION";
  const body = auth
    ? "*482913* is your verification code. For your security, do not share this code."
    : renderTemplate(parts.body, examples);
  return (
    <WhatsAppPreview
      body={body || "(Meta sent no text for this template)"}
      header={parts.header?.format === "DOCUMENT" ? "document" : parts.header?.format === "IMAGE" ? "image" : ""}
      footer={parts.footer}
      buttons={parts.buttons.length ? parts.buttons : auth ? ["Copy code"] : []}
      testId={`wa-stored-preview-${t.id}`}
      className="max-w-sm"
    />
  );
}

function MissingPanel({
  rows,
  canEdit,
  onCreate,
  onCreateAll,
  busy,
}: {
  rows: TypeRow[];
  canEdit: boolean;
  onCreate: (row: TypeRow) => void;
  onCreateAll: () => void;
  busy: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <Panel
      title="Message types without an approved template"
      description="Each of these is skipped until Meta approves a template for it. Create one from the HRMS wording, check it, and submit."
      icon={Wand2}
      testId="wa-templates-missing-panel"
      actions={
        canEdit ? (
          <Button size="sm" className="gap-1.5" onClick={onCreateAll} disabled={busy} data-testid="wa-create-missing">
            <Wand2 size={13} /> Create all missing
          </Button>
        ) : undefined
      }
    >
      <ul className="divide-y">
        {rows.map((r) => (
          <li
            key={r.type}
            className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5"
            data-testid={`wa-missing-${r.type}`}
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{r.feature.label}</p>
              <p className="font-mono text-[11px] text-muted-foreground">{r.templateName}</p>
            </div>
            <TemplateStatusChip state={r.templateState ?? "missing"} />
            {r.template?.rejectedReason && (
              <p className="w-full text-xs text-red-700 dark:text-red-300">Meta: {r.template.rejectedReason}</p>
            )}
            {canEdit && (
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 text-xs"
                onClick={() => onCreate(r)}
                data-testid={`wa-missing-create-${r.type}`}
              >
                <FilePlus2 size={13} /> Create template
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function ResultsNotice({ results, onClose }: { results: WhatsAppCreateMissingResult[]; onClose: () => void }) {
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  return (
    <Notice
      tone={failed.length ? "warn" : "good"}
      role="status"
      testId="wa-create-missing-results"
      title={
        results.length === 0
          ? "Nothing was missing"
          : `${plural(ok.length, "template")} submitted${failed.length ? `, ${failed.length} not` : ""}`
      }
      action={
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onClose}>
          Close
        </Button>
      }
    >
      {failed.length > 0 && (
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          {failed.map((r) => (
            <li key={`${r.type}-${r.name}`}>
              <b>{r.label}</b>: {r.error ?? "Meta did not accept it."}
            </li>
          ))}
        </ul>
      )}
    </Notice>
  );
}

/** Templates: every Meta template with its status, category, quality and the message types that use it; Sync now;
 *  create one from a message type (or from scratch), or all the missing ones at once; delete with a confirmation. */
export default function TemplatesTab({ access, go }: { access: WaAccess; go: (tab: WaTab) => void }) {
  const { toast } = useToast();
  const canEdit = access.canEdit("templates");
  const { data, isLoading, error } = useMetaTemplates();
  const settings = useWhatsAppControlSettings().data;
  const sync = useSyncMetaTemplates();
  const createMissing = useCreateMissingMetaTemplates();
  const remove = useDeleteMetaTemplate();
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [editor, setEditor] = useState<{ type: string | null; label: string | null } | null>(null);
  const [deleting, setDeleting] = useState<WhatsAppMetaTemplate | null>(null);
  const [askAll, setAskAll] = useState(false);
  const [results, setResults] = useState<WhatsAppCreateMissingResult[] | null>(null);

  const templates = useMemo(() => data?.templates ?? [], [data]);
  const typeLabel = useMemo(() => {
    const out: Record<string, string> = {};
    if (!settings) return out;
    for (const s of controlSections(settings, null, null)) for (const r of s.types) out[r.type] = r.feature.label;
    return out;
  }, [settings]);
  // every message type sent through Meta, for "New template -> Start from" (the three code types share one template)
  const typeOptions = useMemo(() => {
    if (!settings) return [];
    return controlSections(settings, null, null)
      .flatMap((sec) => sec.types)
      .filter((r) => r.templateState !== "none" && !(r.type !== "otp_login" && r.templateName === "hrms_otp"))
      .map((r) => ({ type: r.type, label: r.type === "otp_login" ? "Sign-in codes (hrms_otp)" : r.feature.label }));
  }, [settings]);
  // the switched-on types whose template is missing, rejected, paused or disabled (in review is on its way): the same
  // rule as the server's "Create all missing" (every switch it needs ON, the WhatsApp OTP master for the codes)
  const missing = useMemo(() => {
    if (!settings || !data) return [];
    return missingTemplateRows(controlSections(settings, templates, null));
  }, [settings, data, templates]);

  const counts = Object.fromEntries(
    FILTERS.map((f) => [
      f.value,
      f.value === "all" ? templates.length : templates.filter((t) => f.states.includes(templateState(t.status))).length,
    ]),
  ) as Record<Filter, number>;
  const term = search.trim().toLowerCase();
  const shown = templates
    .filter(
      (t) => filter === "all" || FILTERS.find((f) => f.value === filter)!.states.includes(templateState(t.status)),
    )
    .filter(
      (t) =>
        !term ||
        t.name.includes(term) ||
        t.messageTypes.some((m) => m.includes(term) || (typeLabel[m] ?? "").toLowerCase().includes(term)),
    );

  const doSync = () =>
    sync.mutate(undefined, {
      onSuccess: (r) =>
        toast({
          title: "Templates synced with Meta",
          description: r.message ?? (r.synced !== null ? `${plural(r.synced, "template")} read from Meta.` : undefined),
        }),
      onError: (e) =>
        toast({
          title: "Couldn't sync with Meta",
          description: whatsAppErrorMessage(e, "Try again."),
          variant: "destructive",
        }),
    });

  const doCreateAll = () =>
    createMissing.mutate(undefined, {
      onSuccess: (r) => {
        setAskAll(false);
        setResults(r);
      },
      onError: (e) => {
        setAskAll(false);
        toast({
          title: "Couldn't create the missing templates",
          description: whatsAppErrorMessage(e, "Try again."),
          variant: "destructive",
        });
      },
    });

  const doDelete = () => {
    if (!deleting) return;
    const t = deleting;
    remove.mutate(t.id, {
      onSuccess: () => {
        setDeleting(null);
        toast({ title: `${t.name} deleted`, description: "It is gone at Meta too." });
      },
      onError: (e) => {
        setDeleting(null);
        toast({
          title: `Couldn't delete ${t.name}`,
          description: whatsAppErrorMessage(e, "Try again."),
          variant: "destructive",
        });
      },
    });
  };

  if (isLoading) return <Skeleton className="h-96 rounded-2xl" />;
  if (!data) {
    return (
      <Notice tone="bad" role="alert" title="The templates could not be loaded" testId="wa-templates-error">
        {whatsAppErrorMessage(error, "Try Refresh in a moment.")}
      </Notice>
    );
  }

  return (
    <div className="space-y-4" data-testid="wa-templates">
      {!data.configured && (
        <Notice
          tone="warn"
          testId="wa-templates-not-configured"
          title="The Meta keys are not set on this server"
          action={
            access.canOpen("config") ? (
              <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => go("config")}>
                Open Settings
              </Button>
            ) : undefined
          }
        >
          Templates can't be synced or submitted until WHATSAPP_CLOUD_PHONE_NUMBER_ID,
          WHATSAPP_CLOUD_BUSINESS_ACCOUNT_ID and WHATSAPP_CLOUD_ACCESS_TOKEN are set.
        </Notice>
      )}

      {results && <ResultsNotice results={results} onClose={() => setResults(null)} />}

      <MissingPanel
        rows={missing}
        canEdit={canEdit && data.configured}
        onCreate={(r) => setEditor({ type: r.type, label: r.feature.label })}
        onCreateAll={() => setAskAll(true)}
        busy={createMissing.isPending}
      />

      <Panel
        title="Meta templates"
        description={
          data.lastSyncedAt
            ? `Synced with Meta ${timeAgo(data.lastSyncedAt) ?? fmtDateTime(data.lastSyncedAt)}. Status changes arrive by themselves through the webhook.`
            : "Not synced with Meta yet."
        }
        icon={FileText}
        testId="wa-templates-list"
        actions={
          <>
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 text-xs"
              onClick={doSync}
              disabled={sync.isPending || !data.configured || !canEdit}
              data-testid="wa-templates-sync"
            >
              <RefreshCw size={13} className={sync.isPending ? "animate-spin" : ""} /> Sync now
            </Button>
            {canEdit && (
              <Button
                size="sm"
                className="h-8 gap-1.5 text-xs"
                onClick={() => setEditor({ type: null, label: null })}
                disabled={!data.configured}
                data-testid="wa-templates-new"
              >
                <FilePlus2 size={13} /> New template
              </Button>
            )}
          </>
        }
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Show" className="flex flex-wrap gap-1.5">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                aria-pressed={filter === f.value}
                onClick={() => setFilter(f.value)}
                data-testid={`wa-templates-filter-${f.value}`}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs font-semibold transition-colors",
                  filter === f.value
                    ? "border-emerald-600 bg-emerald-600 text-white"
                    : "bg-card text-muted-foreground hover:border-emerald-300",
                )}
              >
                {f.label} <span className="tabular-nums opacity-80">{counts[f.value]}</span>
              </button>
            ))}
          </div>
          <div className="relative ml-auto w-full sm:w-60">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name or message type"
              className="h-8 pl-8 text-xs"
              aria-label="Search templates"
            />
          </div>
        </div>

        {shown.length === 0 ? (
          <Empty testId="wa-templates-empty">
            {templates.length === 0
              ? "No template yet. Sync now reads the ones already at Meta."
              : "No template matches."}
          </Empty>
        ) : (
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full min-w-[720px] text-[13px]">
              <thead className="bg-muted text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="w-8 px-2 py-2" />
                  <th className="px-2 py-2 font-semibold">Template</th>
                  <th className="px-2 py-2 font-semibold">Category</th>
                  <th className="px-2 py-2 font-semibold">Status</th>
                  <th className="px-2 py-2 font-semibold">Quality</th>
                  <th className="px-2 py-2 font-semibold">Used by</th>
                  <th className="px-2 py-2 text-right font-semibold" />
                </tr>
              </thead>
              <tbody>
                {shown.map((t) => {
                  const expanded = open === t.id;
                  const state = templateState(t.status);
                  return (
                    <Fragment key={t.id}>
                      <tr className="border-t align-top" data-testid={`wa-template-${t.name}`} data-state={state}>
                        <td className="px-2 py-2.5">
                          <button
                            type="button"
                            onClick={() => setOpen(expanded ? null : t.id)}
                            aria-expanded={expanded}
                            aria-label={`Preview ${t.name}`}
                            className="rounded p-0.5 text-muted-foreground hover:bg-muted"
                            data-testid={`wa-template-toggle-${t.id}`}
                          >
                            {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                          </button>
                        </td>
                        <td className="px-2 py-2.5">
                          <p className="font-mono text-[12.5px] font-semibold">{t.name}</p>
                          <p className="text-[11px] text-muted-foreground">{t.language}</p>
                          {t.rejectedReason && state !== "approved" && (
                            <p
                              className="mt-1 max-w-xs text-xs text-red-700 dark:text-red-300"
                              data-testid={`wa-template-reason-${t.id}`}
                            >
                              Meta: {t.rejectedReason}
                            </p>
                          )}
                        </td>
                        <td className="px-2 py-2.5 text-muted-foreground">{pricingLabel(t.category.toLowerCase())}</td>
                        <td className="px-2 py-2.5">
                          <TemplateStatusChip status={t.status} />
                        </td>
                        <td className="px-2 py-2.5">
                          {t.qualityScore && QUALITY_TONE[t.qualityScore] ? (
                            <Chip tone={QUALITY_TONE[t.qualityScore]}>
                              {t.qualityScore.charAt(0) + t.qualityScore.slice(1).toLowerCase()}
                            </Chip>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-2 py-2.5">
                          {t.messageTypes.length === 0 ? (
                            <span className="text-xs text-muted-foreground">No message type</span>
                          ) : (
                            <ul className="space-y-0.5 text-xs">
                              {t.messageTypes.map((m) => (
                                <li key={m}>{typeLabel[m] ?? m}</li>
                              ))}
                            </ul>
                          )}
                        </td>
                        <td className="px-2 py-2.5 text-right">
                          {canEdit && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 gap-1 px-2 text-xs text-red-700 hover:text-red-800 dark:text-red-300"
                              onClick={() => setDeleting(t)}
                              aria-label={`Delete ${t.name}`}
                              data-testid={`wa-template-delete-${t.id}`}
                            >
                              <Trash2 size={13} /> Delete
                            </Button>
                          )}
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="border-t bg-muted/40">
                          <td />
                          <td colSpan={6} className="px-2 py-3">
                            <div className="flex flex-wrap items-start gap-4">
                              <StoredPreview t={t} />
                              <div className="min-w-0 space-y-1 text-xs text-muted-foreground">
                                <p>{TEMPLATE_STATE_INFO[state].help}</p>
                                {t.metaId && <p>Meta id: {t.metaId}</p>}
                                <p>Last read from Meta: {fmtDateTime(t.lastSyncedAt)}</p>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <TemplateEditorDialog
        open={editor !== null}
        onClose={() => setEditor(null)}
        messageType={editor?.type ?? null}
        label={editor?.label ?? null}
        types={typeOptions}
      />

      <ConfirmDialog
        open={deleting !== null}
        title={`Delete ${deleting?.name ?? "the template"}?`}
        confirmLabel="Delete at Meta"
        destructive
        pending={remove.isPending}
        onConfirm={doDelete}
        onCancel={() => setDeleting(null)}
        testId="wa-template-delete-confirm"
      >
        <p>
          The template is deleted at Meta and here. This can't be undone, and Meta may not accept the same name again
          for up to 30 days.
        </p>
        {deleting && deleting.messageTypes.length > 0 && (
          <p>
            <b>{deleting.messageTypes.map((m) => typeLabel[m] ?? m).join(", ")}</b>{" "}
            {deleting.messageTypes.length === 1 ? "is" : "are"} skipped until a new template is approved.
          </p>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={askAll}
        title="Create all missing templates?"
        confirmLabel="Create and submit"
        pending={createMissing.isPending}
        onConfirm={doCreateAll}
        onCancel={() => setAskAll(false)}
        testId="wa-create-missing-confirm"
      >
        <p>
          A template is made from the HRMS wording for every switched-on message type without one ({missing.length} now)
          and submitted to Meta for review.
        </p>
        <p>Messages of those types start going out as soon as Meta approves them.</p>
      </ConfirmDialog>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { ApiError } from "@/lib/api-client/custom-fetch";
import {
  isStaleEndpointError,
  useCreateSharedEndpoint,
  useDeleteSharedEndpoint,
  useSharedEndpoint,
  useUpdateSharedEndpoint,
  type SharedCatalog,
  type SharedEndpoint,
} from "@/lib/api-client/custom-hooks";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useDraft } from "../attendance/useDraft";
import { SaveBar } from "../kit/SaveBar";
import { SaveDock } from "../kit/SaveDock";
import { setUnsavedGuard } from "../kit/leaveGuard";
import { saveErrorText } from "../payroll/form";
import type { Section } from "./address";
import { AccessSection } from "./AccessSection";
import { BasicsSection } from "./BasicsSection";
import { DataSection } from "./DataSection";
import {
  blankDraft,
  datasetOf,
  draftFrom,
  newSensitiveFields,
  plural,
  publicUrl,
  sameDraft,
  toInput,
  validateDraft,
} from "./form";
import { GuideSection } from "./GuideSection";
import type { SectionProps } from "./sectionProps";
import { NestedStrip, Notice, Pill, SensitivityPill } from "./ui";

const SECTION_ITEMS: { value: Section; label: string }[] = [
  { value: "basics", label: "Basics" },
  { value: "data", label: "Data" },
  { value: "access", label: "Access" },
  { value: "guide", label: "Guide" },
];

export type EditorNav = {
  openSection: (section: Section) => void;
  /** Back to the list; asks first when there is unsaved work. */
  back: () => void;
  /** A create went through: open the new endpoint (without asking). */
  openCreated: (id: number) => void;
  /** The endpoint was deleted: back to the list (without asking). */
  afterDelete: () => void;
  /** Tell the tab whether there is unsaved work. */
  setDirty: (dirty: boolean) => void;
};

const STALE_TEXT =
  "Someone else saved this endpoint while you were editing. Reload to see their changes; your edits are kept until you reload.";

function failureText(err: unknown): string {
  if (isStaleEndpointError(err)) return STALE_TEXT;
  const fromServer = saveErrorText(err);
  if (fromServer) return fromServer;
  if (err instanceof ApiError && err.status === 403) return "Only the super admin can change shared endpoints.";
  return "The endpoint could not be saved. Check the connection and try again.";
}

/**
 * The endpoint editor: opens one saved endpoint (or a new one) as four sections, one at a time. The form lives here, above
 * the sections, so moving between them never loses what was typed. ONE Save at the bottom saves everything or nothing.
 */
export function EndpointEditor({
  target,
  section,
  catalog,
  readOnly,
  origin,
  nav,
}: {
  target: number | "new";
  section: Section;
  catalog: SharedCatalog;
  readOnly: boolean;
  origin: string;
  nav: EditorNav;
}) {
  const query = useSharedEndpoint(typeof target === "number" ? target : null);

  if (target === "new") {
    return (
      <EditorBody
        key="new"
        saved={null}
        section={section}
        catalog={catalog}
        readOnly={readOnly}
        origin={origin}
        nav={nav}
      />
    );
  }
  if (query.isLoading) {
    return (
      <div className="space-y-3" data-testid="endpoint-loading">
        <Skeleton className="h-16 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }
  if (query.isError || !query.data) {
    const missing = query.error instanceof ApiError && query.error.status === 404;
    return (
      <div
        className="flex flex-wrap items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"
        data-testid="endpoint-load-error"
      >
        {missing ? "This endpoint no longer exists. It may have been deleted." : "The endpoint could not be loaded."}
        {!missing && (
          <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
            Try again
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={nav.afterDelete}>
          Back to all endpoints
        </Button>
      </div>
    );
  }
  return (
    <EditorBody
      key={query.data.id}
      saved={query.data}
      section={section}
      catalog={catalog}
      readOnly={readOnly}
      origin={origin}
      nav={nav}
    />
  );
}

function EditorBody({
  saved,
  section,
  catalog,
  readOnly,
  origin,
  nav,
}: {
  saved: SharedEndpoint | null;
  section: Section;
  catalog: SharedCatalog;
  readOnly: boolean;
  origin: string;
  nav: EditorNav;
}) {
  const { toast } = useToast();
  const creating = saved === null;
  const create = useCreateSharedEndpoint();
  const update = useUpdateSharedEndpoint(saved?.id ?? 0);
  const remove = useDeleteSharedEndpoint();
  const query = useSharedEndpoint(saved?.id ?? null);

  const savedDraft = useMemo(() => (saved ? draftFrom(saved) : blankDraft()), [saved]);
  const { draft, setDraft, update: patch, dirty, discard } = useDraft(savedDraft, sameDraft);
  const dataset = datasetOf(catalog, draft?.dataset ?? "");
  const validation = useMemo(
    () => (draft ? validateDraft(draft, { creating, dataset, limits: catalog.limits }) : null),
    [draft, creating, dataset, catalog.limits],
  );

  // the `version` the draft was started from: a save sends it back so a copy somebody else outdated is refused
  const [baseVersion, setBaseVersion] = useState<string | null>(saved?.version ?? null);
  const [seenSaved, setSeenSaved] = useState(savedDraft);
  if (savedDraft !== seenSaved) {
    setSeenSaved(savedDraft);
    if (draft === null || sameDraft(draft, seenSaved)) setBaseVersion(saved?.version ?? null);
  }

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [confirmingSensitive, setConfirmingSensitive] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingReload, setConfirmingReload] = useState(false);

  // tell the tab (and the Settings page, and the browser) about unsaved work
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const { setDirty } = nav;
  useEffect(() => {
    setDirty(dirty);
  }, [dirty, setDirty]);
  useEffect(() => {
    setUnsavedGuard(() => dirtyRef.current);
    const warn = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
      setUnsavedGuard(null);
      setDirty(false);
    };
  }, [setDirty]);

  if (!draft || !validation) return null;

  const newSensitive = newSensitiveFields(draft, saved?.fields ?? [], dataset);
  const canSave = !readOnly && validation.ok && (creating || dirty);

  const save = async (acknowledgeSensitive: boolean) => {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    setStale(false);
    const body = toInput(draft, { creating, dataset, version: baseVersion, acknowledgeSensitive });
    try {
      if (creating) {
        const made = await create.mutateAsync(body);
        toast({
          title: "Endpoint created",
          description: "Nothing is shared yet: make an API key on the Access section so an application can call it.",
        });
        nav.openCreated(made.id);
      } else {
        const next = await update.mutateAsync(body);
        setDraft(draftFrom(next));
        setBaseVersion(next.version);
        toast({
          title: "Endpoint saved",
          description: "The change is used by the next call. Keys and the activity log are not affected.",
        });
      }
    } catch (err) {
      const message = failureText(err);
      if (isStaleEndpointError(err)) setStale(true);
      setSaveError(message);
      toast({ title: "Failed to save the endpoint", description: message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const begin = () => {
    if (!canSave) return;
    if (newSensitive.length > 0) {
      setUnderstood(false);
      setConfirmingSensitive(true);
    } else void save(false);
  };

  const reload = async () => {
    setConfirmingReload(false);
    const fresh = (await query.refetch()).data;
    if (!fresh) return;
    setDraft(draftFrom(fresh));
    setBaseVersion(fresh.version);
    setSaveError(null);
    setStale(false);
  };

  const doDelete = async () => {
    setConfirmingDelete(false);
    if (!saved) return;
    try {
      await remove.mutateAsync(saved.id);
      toast({
        title: "Endpoint deleted",
        description: `${saved.name} and its keys are gone. Its activity log is kept.`,
      });
      nav.afterDelete();
    } catch (err) {
      toast({
        title: "Failed to delete the endpoint",
        description: saveErrorText(err) ?? "Check the connection and try again.",
        variant: "destructive",
      });
    }
  };

  const props: SectionProps = {
    draft,
    patch,
    readOnly,
    errors: validation.errors,
    creating,
    saved,
    savedEnabled: saved?.enabled ?? false,
    catalog,
    dataset,
    limits: catalog.limits,
    origin,
    dirty,
  };

  const live = !creating && saved.fields.length > 0 && saved.liveKeyCount > 0;
  const hint = readOnly
    ? "View only: nothing can be saved."
    : validation.first
      ? `Fix this first: ${validation.first}`
      : creating
        ? "Nothing is created until you press Create."
        : undefined;

  return (
    <div className="space-y-4" data-testid="endpoint-editor" data-mode={creating ? "new" : "edit"}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={nav.back}
            data-testid="editor-back"
          >
            <ArrowLeft size={13} /> All endpoints
          </Button>
          <div className="min-w-0">
            <h4 className="truncate text-base font-semibold text-slate-900" data-testid="editor-title">
              {creating ? "New endpoint" : saved.name}
            </h4>
            <p className="break-all font-mono text-xs text-slate-500" data-testid="editor-address">
              {publicUrl(origin, draft.slug)}
            </p>
          </div>
          {!creating && (saved.enabled ? <Pill tone="good">On</Pill> : <Pill tone="muted">Switched off</Pill>)}
        </div>
        {!creating && !readOnly && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="gap-1.5 text-red-700"
            onClick={() => setConfirmingDelete(true)}
            data-testid="editor-delete"
          >
            <Trash2 size={13} /> Delete endpoint
          </Button>
        )}
      </div>

      {live ? (
        <Notice tone="good" testId="sharing-state">
          This endpoint is live: {plural(saved.fields.length, "field")} can be read with{" "}
          {plural(saved.liveKeyCount, "live key")}.
        </Notice>
      ) : (
        <Notice tone="warn" testId="sharing-state" title="Nothing is shared until you select fields and create a key">
          An endpoint shares nothing by itself. It starts sharing only when it has at least one ticked field (Data
          section) and at least one API key (Access section).
        </Notice>
      )}

      <NestedStrip
        items={SECTION_ITEMS}
        value={section}
        onChange={(next) => nav.openSection(next as Section)}
        testId="endpoint-sections"
        label="Sections of this endpoint"
      />
      <div
        role="tabpanel"
        id="endpoint-sections-panel"
        aria-labelledby={`endpoint-sections-tab-${section}`}
        className="space-y-4"
        data-testid="endpoint-sections-panel"
      >
        {section === "basics" && <BasicsSection {...props} />}
        {section === "data" && <DataSection {...props} />}
        {section === "access" && <AccessSection {...props} />}
        {section === "guide" && <GuideSection {...props} />}
      </div>

      <SaveDock>
        {saveError && (
          <div
            role="alert"
            className="mb-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
            data-testid="endpoint-save-error"
          >
            {saveError}
            {stale && (
              <div className="mt-2">
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="endpoint-reload"
                  onClick={() => (dirty ? setConfirmingReload(true) : void reload())}
                >
                  Reload the saved endpoint
                </Button>
              </div>
            )}
          </div>
        )}
        <SaveBar
          dirty={dirty}
          saving={saving}
          onSave={begin}
          onDiscard={() => {
            setSaveError(null);
            discard();
          }}
          saveLabel={creating ? "Create endpoint" : "Save endpoint"}
          disabled={!canSave}
          hint={hint}
        />
      </SaveDock>

      <AlertDialog
        open={confirmingSensitive}
        onOpenChange={(open) => {
          setConfirmingSensitive(open);
          if (!open) setUnderstood(false);
        }}
      >
        <AlertDialogContent data-testid="confirm-sensitive">
          <AlertDialogHeader>
            <AlertDialogTitle>Share personal or financial data?</AlertDialogTitle>
            <AlertDialogDescription>
              You are about to share these fields. Anyone holding a key for this endpoint can read them for every row.
              Each such change is recorded in the audit log with the names of the fields.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="space-y-1" data-testid="confirm-sensitive-fields">
            {newSensitive.map((f) => (
              <li
                key={f.key}
                className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-1.5 text-[13px]"
              >
                <span className="font-semibold text-slate-900">{f.label}</span>
                <SensitivityPill level={f.sensitivity} />
              </li>
            ))}
          </ul>
          <label className="flex cursor-pointer items-start gap-2 text-[13px] text-slate-800" htmlFor="es-understood">
            <input
              id="es-understood"
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-indigo-600"
              checked={understood}
              onChange={(e) => setUnderstood(e.target.checked)}
            />
            I understand that these fields will be readable by every application that holds a key for this endpoint.
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel>Go back</AlertDialogCancel>
            <AlertDialogAction
              data-testid="confirm-sensitive-yes"
              disabled={!understood}
              onClick={() => void save(true)}
            >
              {creating ? "Create and share these fields" : "Save and share these fields"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <AlertDialogContent data-testid="confirm-delete">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete the endpoint "{saved?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              Every application that calls it is refused at once, and all of its keys are deleted. This can not be
              undone. Its activity log is kept. To stop sharing for a while without losing the setup, switch it off
              instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction data-testid="confirm-delete-yes" onClick={() => void doDelete()}>
              Delete the endpoint
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmingReload} onOpenChange={setConfirmingReload}>
        <AlertDialogContent data-testid="confirm-reload">
          <AlertDialogHeader>
            <AlertDialogTitle>Reload and drop your edits?</AlertDialogTitle>
            <AlertDialogDescription>
              Reloading shows the endpoint as it is saved now, including what the other person changed. Everything you
              changed here and have not saved is lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction data-testid="confirm-reload-yes" onClick={() => void reload()}>
              Reload and drop my edits
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

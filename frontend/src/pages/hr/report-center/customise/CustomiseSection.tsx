import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { ArrowUpRight, Copy, Loader2, Pencil, Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  customiseErrorMessage,
  useDeleteCustomReport,
  useDuplicateCustomReport,
  type SavedCustomReport,
} from "@/lib/api-client/custom-hooks/report-customise";
import type { ReportGroup } from "@/lib/report-catalog";
import type { ReportCategory } from "@/lib/report-center";
import { categoryStyle, iconFor } from "../report-icons";
import { editReportHref, newReportHref, savedByLine } from "./builder-logic";

const ACTION =
  "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:opacity-50";

/** "Create custom report": the builder's front door (shown to whoever has edit on Reports -> Customise). */
function CreateTile() {
  return (
    <Link
      href={newReportHref()}
      data-testid="customise-create"
      data-create-tile=""
      className="flex h-full min-h-[10rem] flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-sky-200 bg-sky-50/40 p-4 text-center transition-colors hover:border-sky-300 hover:bg-sky-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
    >
      <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-white text-sky-700 shadow-sm">
        <Plus size={18} />
      </span>
      <span className="text-sm font-bold text-sky-800">Create custom report</span>
      <span className="max-w-xs text-xs text-muted-foreground">
        Pick a data source, the fields and the filters, check the preview, then save it here for everyone.
      </span>
    </Link>
  );
}

/** One saved report: opens in the Report Center; Edit / Duplicate / Delete for those allowed (delete asks in place). */
function SavedTile({
  item,
  hrefFor,
  chip,
}: {
  item: SavedCustomReport;
  hrefFor: (reportId: string) => string;
  chip: string;
}) {
  const { toast } = useToast();
  const duplicate = useDuplicateCustomReport();
  const remove = useDeleteCustomReport();
  const [confirming, setConfirming] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
  }, [confirming]);

  const fieldCount = item.fields.length + item.hiddenFields;
  const byLine = savedByLine(item);

  const onDuplicate = () =>
    duplicate.mutate(item.id, {
      onSuccess: (copy) =>
        toast({ title: "Copy created", description: `“${copy.name}” is in the list - edit it to change it.` }),
      onError: (e) =>
        toast({
          title: "Could not copy the report",
          description: customiseErrorMessage(e) ?? "Please try again.",
          variant: "destructive",
        }),
    });
  const onDelete = () =>
    remove.mutate(item.id, {
      onSuccess: () => toast({ title: "Report deleted", description: item.name }),
      onError: (e) => {
        setConfirming(false);
        toast({
          title: "Could not delete the report",
          description: customiseErrorMessage(e) ?? "Please try again.",
          variant: "destructive",
        });
      },
    });

  return (
    <div
      className="flex h-full flex-col rounded-xl border bg-white shadow-sm transition-all hover:border-sky-200 hover:shadow-md"
      data-testid={`saved-report-${item.id}`}
    >
      <Link
        href={hrefFor(item.reportId)}
        className="flex flex-1 flex-col rounded-t-xl p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        <span className={`mb-3 inline-flex h-9 w-9 items-center justify-center rounded-lg ring-1 ${chip}`}>
          <SlidersHorizontal size={18} />
        </span>
        <span className="text-sm font-bold text-gray-900">{item.name}</span>
        {item.description && (
          <span className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{item.description}</span>
        )}
        <span className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px] font-semibold">
          {item.datasetLabel && (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">{item.datasetLabel}</span>
          )}
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">
            {fieldCount} field{fieldCount === 1 ? "" : "s"}
          </span>
        </span>
        {byLine && <span className="mt-2 text-[11px] text-gray-500">{byLine}</span>}
      </Link>

      {confirming ? (
        <div
          role="group"
          aria-label={`Delete ${item.name}`}
          className="flex flex-wrap items-center gap-2 rounded-b-xl border-t border-red-100 bg-red-50 px-3 py-2"
          data-testid={`delete-confirm-${item.id}`}
        >
          <p className="mr-auto text-xs font-semibold text-red-800" role="alert">
            Delete this report for everyone? This can’t be undone.
          </p>
          <Button ref={cancelRef} type="button" size="sm" variant="outline" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            onClick={onDelete}
            disabled={remove.isPending}
            data-testid={`delete-yes-${item.id}`}
          >
            {remove.isPending ? <Loader2 className="animate-spin" /> : <Trash2 />} Delete
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-0.5 border-t px-2 py-1.5">
          <Link href={hrefFor(item.reportId)} className={`${ACTION} text-sky-700`} aria-label={`Open ${item.name}`}>
            Open <ArrowUpRight size={12} />
          </Link>
          {item.canEdit && (
            <Link
              href={editReportHref(item.id)}
              className={ACTION}
              aria-label={`Edit ${item.name}`}
              data-testid={`edit-${item.id}`}
            >
              <Pencil size={12} /> Edit
            </Link>
          )}
          {item.canEdit && (
            <button
              type="button"
              className={ACTION}
              onClick={onDuplicate}
              disabled={duplicate.isPending}
              aria-label={`Duplicate ${item.name}`}
              data-testid={`duplicate-${item.id}`}
            >
              {duplicate.isPending ? <Loader2 size={12} className="animate-spin" /> : <Copy size={12} />} Duplicate
            </button>
          )}
          {item.canDelete && (
            <button
              type="button"
              className={`${ACTION} ml-auto hover:bg-red-50 hover:text-red-700`}
              onClick={() => setConfirming(true)}
              aria-label={`Delete ${item.name}`}
              data-testid={`delete-${item.id}`}
            >
              <Trash2 size={12} /> Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** A saved report the catalog lists but whose details could not be loaded: open only. */
function PlainTile({ group, href, chip }: { group: ReportGroup; href: string; chip: string }) {
  const r = group.primary;
  return (
    <Link
      href={href}
      className="flex h-full flex-col rounded-xl border bg-white p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:border-sky-200 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
    >
      <span className={`mb-3 inline-flex h-9 w-9 items-center justify-center rounded-lg ring-1 ${chip}`}>
        <SlidersHorizontal size={18} />
      </span>
      <span className="text-sm font-bold text-gray-900">{r.title}</span>
      {r.description && (
        <span className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{r.description}</span>
      )}
    </Link>
  );
}

/**
 * The catalog's Customise section: "Create custom report" (edit only) and one tile per saved report (a team library:
 * everyone with view sees them all). Shown whenever the catalog has the category, even with nothing saved yet.
 * `items` are the saved reports matching the search (undefined while loading or when they could not be loaded, then the
 * catalog's own entries, `fallback`, are listed instead).
 */
export function CustomiseSection({
  category,
  items,
  loading,
  failed,
  fallback,
  searching,
  canCreate,
  hrefFor,
}: {
  category: ReportCategory;
  items: SavedCustomReport[] | undefined;
  loading: boolean;
  failed: boolean;
  fallback: ReportGroup[];
  searching: boolean;
  canCreate: boolean;
  hrefFor: (reportId: string) => string;
}) {
  const style = categoryStyle(category.id);
  const Icon = category.icon === "SlidersHorizontal" ? SlidersHorizontal : iconFor(category.icon);
  const chip = `${style.chip} ${style.ring}`;
  const showCreate = canCreate && !searching;
  const listed = items ? items.length : loading ? 0 : fallback.length;
  if (searching && listed === 0) return null;

  return (
    <section id={`cat-${category.id}`} className="scroll-mt-4" data-testid="customise-section">
      <div className="mb-3 flex items-center gap-3">
        <span className={`inline-flex h-8 w-8 items-center justify-center rounded-lg ring-1 ${chip}`}>
          <Icon size={16} />
        </span>
        <div>
          <h3 className="text-base font-black text-gray-900">{category.label}</h3>
          <p className="text-xs text-muted-foreground">{category.description}</p>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {showCreate && <CreateTile />}
        {items
          ? items.map((item) => <SavedTile key={item.id} item={item} hrefFor={hrefFor} chip={chip} />)
          : loading
            ? [0, 1].map((i) => (
                <div
                  key={i}
                  className="h-40 animate-pulse rounded-xl border bg-white/70"
                  aria-hidden
                  data-testid="customise-loading"
                />
              ))
            : fallback.map((g) => <PlainTile key={g.key} group={g} href={hrefFor(g.primary.id)} chip={chip} />)}
      </div>
      {!searching && listed === 0 && !loading && (
        <p className="mt-2 text-sm text-muted-foreground" data-testid="customise-empty">
          {canCreate
            ? "No saved reports yet. Create one: it is listed here for everyone who can open Customise."
            : "No saved reports yet. Someone with edit access to Customise can build them."}
        </p>
      )}
      {failed && (
        <p className="mt-2 text-xs text-amber-700" data-testid="customise-failed">
          The details of the saved reports could not be loaded. They can still be opened.
        </p>
      )}
    </section>
  );
}

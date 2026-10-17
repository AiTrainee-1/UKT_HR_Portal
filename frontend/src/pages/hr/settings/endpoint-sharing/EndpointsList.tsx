import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useSharedEndpoints } from "@/lib/api-client/custom-hooks";
import { plural, stamp } from "./form";
import { AffectList } from "../kit/SettingBlock";
import { AnchorSection, Notice, Pill } from "./ui";

/** The list of endpoints: each one a card with what a person wants to know at a glance (on or off, data, keys, calls). */
export function EndpointsList({
  onOpen,
  onNew,
  readOnly,
  max,
}: {
  onOpen: (id: number) => void;
  onNew: () => void;
  readOnly: boolean;
  max: number;
}) {
  const list = useSharedEndpoints();
  const items = list.data ?? [];

  return (
    <AnchorSection
      id="endpoints-list"
      title="Shared endpoints"
      purpose="Each endpoint is a web address that gives one of your other applications a chosen slice of the HR data, read only. You choose the data, the fields and who may call it. Open one to change it, or make a new one."
      actions={
        <Button
          type="button"
          size="sm"
          className="gap-1.5"
          disabled={readOnly || items.length >= max}
          onClick={onNew}
          data-testid="endpoint-new"
        >
          <Plus size={13} /> New endpoint
        </Button>
      }
    >
      <Notice tone="warn" testId="nothing-shared" title="Nothing is shared until you select fields and create a key">
        A new endpoint shares nothing. It starts sharing only when it has ticked fields and at least one API key.
      </Notice>

      <AffectList
        affects={[
          {
            where: "Endpoints",
            what: "each one is a web address for one dataset (employees, attendance, leave...); switching it off closes it at once",
          },
          {
            where: "Fields",
            what: "only the fields you tick are sent; personal and financial ones ask you to confirm first",
          },
          {
            where: "Websites (origins)",
            what: "decide which websites may call it from a browser; your own servers are set apart",
          },
          {
            where: "API keys",
            what: "decide which applications may read it: a new key works at once and a revoked key stops at once",
          },
          { where: "Activity", what: "every call, answered or refused, is recorded for 90 days" },
          {
            where: "Audit log",
            what: "every change to an endpoint, a field or a key is recorded, never the key itself",
          },
        ]}
      />

      {list.isLoading ? (
        <div className="space-y-2" data-testid="endpoints-loading">
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      ) : list.isError ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"
          data-testid="endpoints-error"
        >
          The endpoints could not be loaded.
          <Button size="sm" variant="outline" onClick={() => void list.refetch()}>
            Try again
          </Button>
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 p-6 text-center" data-testid="endpoints-empty">
          <p className="text-sm font-semibold text-slate-800">No endpoint yet</p>
          <p className="mx-auto mt-1 max-w-md text-[13px] leading-snug text-slate-500">
            Nothing is being shared with other applications. Make an endpoint when another application needs some HR
            data.
          </p>
        </div>
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2" data-testid="endpoints-grid">
          {items.map((e) => (
            <li
              key={e.id}
              className="space-y-2 rounded-xl border border-slate-200 bg-white p-4"
              data-testid="endpoint-card"
              data-slug={e.slug}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-slate-900">{e.name}</p>
                  <p className="break-all font-mono text-xs text-slate-500">/api/shared/{e.slug}</p>
                </div>
                {e.enabled ? <Pill tone="good">On</Pill> : <Pill tone="muted">Switched off</Pill>}
              </div>
              <p className="text-xs text-slate-600">
                Shares <span className="font-semibold">{e.datasetLabel}</span>: {plural(e.fieldCount, "field")}
              </p>
              <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
                <div>
                  <dt className="inline">Live keys: </dt>
                  <dd className="inline font-semibold">{e.liveKeyCount}</dd>
                </div>
                <div>
                  <dt className="inline">Websites: </dt>
                  <dd className="inline font-semibold">{e.originCount}</dd>
                </div>
                <div>
                  <dt className="inline">Calls in 24 hours: </dt>
                  <dd className="inline font-semibold">{e.calls24h}</dd>
                </div>
                <div>
                  <dt className="inline">Last call: </dt>
                  <dd className="inline font-semibold">{stamp(e.lastCallAt)}</dd>
                </div>
              </dl>
              {(e.fieldCount === 0 || e.liveKeyCount === 0) && (
                <p className="text-xs font-medium text-amber-800" data-testid="card-not-live">
                  {e.fieldCount === 0
                    ? "No field is ticked, so nothing is shared."
                    : "No live key, so nothing can be read."}
                </p>
              )}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => onOpen(e.id)}
                aria-label={`Open ${e.name}`}
              >
                Open
              </Button>
            </li>
          ))}
        </ul>
      )}
    </AnchorSection>
  );
}

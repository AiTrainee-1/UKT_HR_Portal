import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, CopyPlus, RotateCcw, Search, SearchX, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { PermissionLevel, Role } from "@/lib/api-client/custom-hooks";
import type { ModuleNode } from "@/lib/permission-modules";
import { MODULE_TREE, resolvePermission } from "@/lib/permission-modules";
import { cn } from "@/lib/utils";
import {
  LEVELS,
  clearOverride,
  filterModules,
  levelCounts,
  overrideCount,
  sectionCounts,
  setAll,
  setLevel,
  setSection,
  visibleModuleCount,
  type Permissions,
} from "./logic";

const ACTIVE_TONE: Record<PermissionLevel, string> = {
  hidden: "bg-white text-gray-700 shadow-sm",
  view: "bg-amber-100 text-amber-800 shadow-sm",
  edit: "bg-blue-600 text-white shadow-sm",
};

/** Hidden | View | Edit for one module. */
function LevelToggle({
  value,
  onChange,
  label,
  testKey,
  inheriting,
}: {
  value: PermissionLevel;
  onChange: (level: PermissionLevel) => void;
  label: string;
  testKey: string;
  /** The level shown is borrowed from the parent, not set on this module. */
  inheriting?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        "inline-flex shrink-0 rounded-lg bg-gray-100 p-0.5",
        inheriting && "ring-1 ring-dashed ring-gray-300",
      )}
    >
      {LEVELS.map((l) => {
        const active = value === l.value;
        return (
          <button
            key={l.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={`${label} - ${l.label}`}
            onClick={() => onChange(l.value)}
            className={cn(
              "h-7 min-w-[3.25rem] rounded-md px-2.5 text-xs font-semibold transition-colors",
              active ? ACTIVE_TONE[l.value] : "text-gray-500 hover:text-gray-800",
            )}
            data-testid={`perm-${testKey}-${l.value}`}
            data-active={active}
          >
            {l.label}
          </button>
        );
      })}
    </div>
  );
}

function ModuleLine({
  node,
  parent,
  permissions,
  onChange,
}: {
  node: ModuleNode;
  parent: ModuleNode;
  permissions: Permissions;
  onChange: (next: Permissions) => void;
}) {
  const explicit = node.key in permissions;
  return (
    <div
      className="flex flex-col gap-1.5 border-t border-gray-100 py-2 pl-6 pr-3 sm:flex-row sm:items-center sm:justify-between"
      data-testid={`module-${node.key}`}
    >
      <span className="flex min-w-0 items-center gap-1.5 text-sm text-gray-700">
        {node.label}
        {!explicit && <span className="text-[10px] text-gray-400">(follows {parent.label})</span>}
      </span>
      <span className="flex items-center gap-1.5">
        {explicit && (
          <button
            type="button"
            onClick={() => onChange(clearOverride(permissions, node.key))}
            title={`Follow ${parent.label} again`}
            aria-label={`${node.label}: follow ${parent.label} again`}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
            data-testid={`perm-reset-${node.key}`}
          >
            <RotateCcw size={13} />
          </button>
        )}
        <LevelToggle
          value={resolvePermission(permissions, node.key)}
          onChange={(level) => onChange(setLevel(permissions, node.key, level))}
          label={node.label}
          testKey={node.key}
          inheriting={!explicit}
        />
      </span>
    </div>
  );
}

function Section({
  node,
  shown,
  permissions,
  onChange,
  open,
  onToggle,
}: {
  node: ModuleNode;
  /** The submodules to show (all of them, or just the ones a search matched). */
  shown: ModuleNode[];
  permissions: Permissions;
  onChange: (next: Permissions) => void;
  open: boolean;
  onToggle: () => void;
}) {
  const hasChildren = (node.children ?? []).length > 0;
  const counts = sectionCounts(permissions, node);
  const custom = overrideCount(permissions, node);
  return (
    <div className="overflow-hidden rounded-xl border bg-white" data-testid={`section-${node.key}`}>
      <div className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-1.5">
          {hasChildren ? (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={open}
              aria-label={`${open ? "Collapse" : "Expand"} ${node.label}`}
              className="rounded p-0.5 text-gray-400 hover:text-gray-700"
              data-testid={`section-toggle-${node.key}`}
            >
              {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </button>
          ) : (
            <span className="w-5" />
          )}
          <span className="text-sm font-semibold text-gray-900">{node.label}</span>
          {hasChildren && (
            <span className="text-[11px] text-gray-400">
              {counts.total - 1} sub-module{counts.total - 1 === 1 ? "" : "s"}
              {counts.edit + counts.view > 0 ? ` · ${counts.edit} edit · ${counts.view} view` : ""}
            </span>
          )}
          {custom > 0 && (
            <button
              type="button"
              onClick={() => onChange(setSection(permissions, node, resolvePermission(permissions, node.key)))}
              title="Make every sub-module follow this module again"
              className="inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-700 hover:bg-blue-100"
              data-testid={`section-reset-${node.key}`}
            >
              <RotateCcw size={10} /> {custom} custom · reset
            </button>
          )}
        </div>
        <LevelToggle
          value={resolvePermission(permissions, node.key)}
          onChange={(level) => onChange(setLevel(permissions, node.key, level))}
          label={node.label}
          testKey={node.key}
        />
      </div>
      {hasChildren && open && (
        <div className="bg-gray-50/50">
          {shown.map((child) => (
            <ModuleLine key={child.key} node={child} parent={node} permissions={permissions} onChange={onChange} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The module list of a role: a Hidden / View / Edit control for every section, sections with submodules that fold
 * open, a search, "set every module" buttons and "copy from another role". It only edits the object it is given: nothing
 * is saved until the dialog's Save.
 */
export default function PermissionEditor({
  permissions,
  onChange,
  otherRoles,
  onCopied,
}: {
  permissions: Permissions;
  onChange: (next: Permissions) => void;
  /** Roles whose permissions can be copied in. */
  otherRoles: Role[];
  onCopied?: (from: Role) => void;
}) {
  const [query, setQuery] = useState("");
  // Sections where a sub-module has been set on its own start open, so a role's exceptions are not hidden away.
  const [openKeys, setOpenKeys] = useState<Set<string>>(
    () => new Set(MODULE_TREE.filter((n) => overrideCount(permissions, n) > 0).map((n) => n.key)),
  );
  const searching = query.trim() !== "";
  const sections = useMemo(() => filterModules(query), [query]);
  const counts = levelCounts(permissions);
  const foldable = sections.filter((s) => (s.node.children ?? []).length > 0);
  const allOpen = foldable.length > 0 && foldable.every((s) => searching || openKeys.has(s.node.key));

  const toggle = (key: string) =>
    setOpenKeys((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <div className="space-y-3" data-testid="permission-editor">
      {/* sticks to the top of the dialog while the long list scrolls under it */}
      <div className="sticky top-0 z-10 space-y-2.5 rounded-xl border bg-gray-50 p-3 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold text-gray-900">Module access</p>
          <p className="flex flex-wrap gap-x-3 text-xs text-gray-600" data-testid="permission-summary">
            <span className="inline-flex items-center gap-1">
              <i className="h-2 w-2 rounded-full bg-blue-600" /> <b data-testid="count-edit">{counts.edit}</b> edit
            </span>
            <span className="inline-flex items-center gap-1">
              <i className="h-2 w-2 rounded-full bg-amber-400" /> <b data-testid="count-view">{counts.view}</b> view
            </span>
            <span className="inline-flex items-center gap-1">
              <i className="h-2 w-2 rounded-full bg-gray-300" /> <b data-testid="count-hidden">{counts.hidden}</b>{" "}
              hidden
            </span>
            <span className="text-gray-400">of {counts.total} modules</span>
          </p>
        </div>

        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search modules, e.g. payroll or SMTP"
            aria-label="Search modules"
            className="h-9 bg-white pl-9 pr-9"
            data-testid="module-search"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear module search"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:text-gray-700"
            >
              <X size={13} />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-gray-500">Set every module to</span>
            {LEVELS.map((l) => (
              <button
                key={l.value}
                type="button"
                onClick={() => onChange(setAll(permissions, l.value))}
                className="h-7 rounded-md border bg-white px-2.5 text-xs font-semibold text-gray-700 hover:bg-gray-100"
                data-testid={`set-all-${l.value}`}
              >
                {l.label}
              </button>
            ))}
          </div>
          {otherRoles.length > 0 && (
            <div className="flex items-center gap-1.5">
              <CopyPlus size={13} className="text-gray-400" />
              <Select
                value=""
                onValueChange={(id) => {
                  const from = otherRoles.find((r) => String(r.id) === id);
                  if (!from) return;
                  onChange({ ...from.permissions });
                  onCopied?.(from);
                }}
              >
                <SelectTrigger
                  className="h-7 w-48 bg-white text-xs"
                  aria-label="Copy permissions from another role"
                  data-testid="copy-from"
                >
                  <SelectValue placeholder="Copy from another role…" />
                </SelectTrigger>
                <SelectContent>
                  {otherRoles.map((r) => (
                    <SelectItem key={r.id} value={String(r.id)}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {foldable.length > 0 && !searching && (
            <button
              type="button"
              onClick={() => setOpenKeys(allOpen ? new Set() : new Set(foldable.map((s) => s.node.key)))}
              className="ml-auto text-xs font-semibold text-blue-600 hover:underline"
              data-testid="toggle-all-sections"
            >
              {allOpen ? "Collapse all" : "Expand all"}
            </button>
          )}
        </div>
      </div>

      {sections.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-10 text-center text-gray-500" data-testid="no-modules">
          <SearchX size={24} />
          <p className="text-sm">No module matches “{query.trim()}”.</p>
        </div>
      ) : (
        <>
          {searching && (
            <p className="text-xs text-gray-500">
              {visibleModuleCount(sections)} {visibleModuleCount(sections) === 1 ? "module matches" : "modules match"}
            </p>
          )}
          <div className="space-y-2">
            {sections.map((s) => (
              <Section
                key={s.node.key}
                node={s.node}
                shown={s.children}
                permissions={permissions}
                onChange={onChange}
                open={searching || openKeys.has(s.node.key)}
                onToggle={() => toggle(s.node.key)}
              />
            ))}
          </div>
        </>
      )}
      <p className="text-[11px] leading-relaxed text-gray-400">
        A sub-module with no setting of its own follows its section. Change the section and the others follow; set a
        sub-module yourself only where it should differ.
      </p>
    </div>
  );
}

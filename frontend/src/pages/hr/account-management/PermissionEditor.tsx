import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CopyPlus,
  Lock,
  MonitorSmartphone,
  RotateCcw,
  Search,
  SearchX,
  X,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { PermissionLevel, Role } from "@/lib/api-client/custom-hooks";
import type { DisplayGroup, DisplayNode } from "@/lib/permission-modules";
import { resolvePermission } from "@/lib/permission-modules";
import { cn } from "@/lib/utils";
import {
  LEVELS,
  applyLevel,
  clearOverride,
  commonLevel,
  countsText,
  filterTree,
  foldableKeys,
  followText,
  groupCounts,
  levelCounts,
  matchedCount,
  overrideCount,
  sectionCounts,
  setAll,
  setGroup,
  setSection,
  typeWord,
  type Permissions,
  type TreeItem,
} from "./logic";

const ACTIVE_TONE: Record<PermissionLevel, string> = {
  hidden: "bg-white text-gray-700 shadow-sm",
  view: "bg-amber-100 text-amber-800 shadow-sm",
  edit: "bg-blue-600 text-white shadow-sm",
};

/** Hidden | View | Edit for one key (or, with value null, for a set of keys that are not all at one level). */
export function LevelToggle({
  value,
  onChange,
  label,
  testKey,
  inheriting,
}: {
  value: PermissionLevel | null;
  onChange: (level: PermissionLevel) => void;
  label: string;
  testKey: string;
  /** The level shown is borrowed from the node above, not set on this key. */
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

/** "Page", "Tab", "Sub-tab" ... and, where Hidden only hides it on screen, a note saying so. */
export function NodeChips({ node }: { node: DisplayNode }) {
  return (
    <>
      <span className="rounded border border-gray-200 bg-white px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-gray-400">
        {typeWord(node.type)}
      </span>
      {node.enforce === "screen" && (
        <span
          className="inline-flex items-center gap-0.5 rounded border border-amber-200 bg-amber-50 px-1 py-px text-[9px] font-semibold text-amber-700"
          title="It shares its data with its page: Hidden removes it from the portal and View locks its buttons, but the server still answers the page's own calls."
          data-testid={`screen-only-${node.key}`}
        >
          <MonitorSmartphone size={9} /> Screen only
        </span>
      )}
    </>
  );
}

/** A row for something no role can be given: who may use it instead. */
export function LockedRow({ node, depth }: { node: DisplayNode; depth: number }) {
  return (
    <div
      className="flex flex-col gap-1 border-t border-gray-100 bg-gray-50/70 py-2 pr-3 sm:flex-row sm:items-center sm:justify-between"
      style={{ paddingLeft: `${0.75 + depth * 1.1 + 1.25}rem` }}
      data-testid={`locked-${node.key}`}
    >
      <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm text-gray-600">
        <Lock size={12} className="text-gray-400" />
        {node.label}
        <NodeChips node={node} />
      </span>
      <span className="text-[11px] font-semibold text-gray-500">{node.locked ?? "Fixed"}</span>
    </div>
  );
}

function NodeRow({
  item,
  depth,
  parent,
  permissions,
  onChange,
  open,
  onToggle,
  searching,
}: {
  item: TreeItem;
  depth: number;
  parent: DisplayNode | null;
  permissions: Permissions;
  onChange: (next: Permissions) => void;
  open: Set<string>;
  onToggle: (key: string) => void;
  searching: boolean;
}) {
  const { node } = item;
  if (node.locked) {
    return (
      <>
        <LockedRow node={node} depth={depth} />
        {item.children.map((c) => (
          <LockedRow key={c.node.key} node={c.node} depth={depth + 1} />
        ))}
      </>
    );
  }
  const hasParts = item.children.length > 0;
  const isOpen = hasParts && (searching || open.has(node.key));
  const explicit = node.key in permissions;
  const level = resolvePermission(permissions, node.key);
  const counts = hasParts ? sectionCounts(permissions, node) : null;
  const custom = hasParts ? overrideCount(permissions, node) : 0;
  return (
    <div
      className={cn(depth === 0 ? "" : "border-t border-gray-100")}
      data-testid={depth === 0 ? `section-${node.key}` : `module-${node.key}`}
    >
      <div
        className={cn(
          "flex flex-col gap-1.5 py-2 pr-3 sm:flex-row sm:items-center sm:justify-between",
          depth === 0 ? "bg-white" : "bg-gray-50/40",
        )}
        style={{ paddingLeft: `${0.75 + depth * 1.1}rem` }}
      >
        <div className="flex min-w-0 items-start gap-1.5">
          {hasParts ? (
            <button
              type="button"
              onClick={() => onToggle(node.key)}
              aria-expanded={isOpen}
              aria-label={`${isOpen ? "Collapse" : "Expand"} ${node.label}`}
              className="mt-0.5 rounded p-0.5 text-gray-400 hover:text-gray-700"
              data-testid={`section-toggle-${node.key}`}
            >
              {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            </button>
          ) : (
            <span className="w-5 shrink-0" />
          )}
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-1.5">
              <span className={cn("text-sm", depth === 0 ? "font-semibold text-gray-900" : "text-gray-800")}>
                {node.label}
              </span>
              <NodeChips node={node} />
              {!explicit && <span className="text-[10px] text-gray-400">({followText(permissions, node)})</span>}
              {explicit && node.own && <span className="text-[10px] text-gray-400">(own setting)</span>}
            </p>
            <p className="truncate text-[11px] text-gray-400 sm:max-w-[26rem]" title={node.help}>
              {node.help}
              {counts && <span className="ml-1 text-gray-500">· {countsText(counts)}</span>}
            </p>
          </div>
        </div>
        <span className="flex shrink-0 flex-wrap items-center gap-1.5 pl-6 sm:pl-0">
          {custom > 0 && (
            <button
              type="button"
              onClick={() => onChange(setSection(permissions, node, level))}
              title="Make every part follow this one again"
              className="inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-700 hover:bg-blue-100"
              data-testid={`section-reset-${node.key}`}
            >
              <RotateCcw size={10} /> {custom} custom · reset
            </button>
          )}
          {explicit && parent && !node.own && (
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
            value={level}
            onChange={(next) => onChange(applyLevel(permissions, node, next))}
            label={node.label}
            testKey={node.key}
            inheriting={!explicit}
          />
        </span>
      </div>
      {isOpen &&
        item.children.map((child) => (
          <NodeRow
            key={child.node.key}
            item={child}
            depth={depth + 1}
            parent={node}
            permissions={permissions}
            onChange={onChange}
            open={open}
            onToggle={onToggle}
            searching={searching}
          />
        ))}
    </div>
  );
}

function GroupBlock({
  group,
  items,
  permissions,
  onChange,
  open,
  onToggle,
  searching,
}: {
  group: DisplayGroup;
  items: TreeItem[];
  permissions: Permissions;
  onChange: (next: Permissions) => void;
  open: Set<string>;
  onToggle: (key: string) => void;
  searching: boolean;
}) {
  const id = `group:${group.id}`;
  const isOpen = searching || open.has(id);
  const counts = groupCounts(permissions, group);
  return (
    <div className="overflow-hidden rounded-xl border bg-white" data-testid={`group-${group.id}`}>
      <div className="flex flex-col gap-2 bg-slate-50 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => onToggle(id)}
            aria-expanded={isOpen}
            aria-label={`${isOpen ? "Collapse" : "Expand"} ${group.label}`}
            className="rounded p-0.5 text-gray-400 hover:text-gray-700"
            data-testid={`group-toggle-${group.id}`}
          >
            {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
          <span className="text-xs font-bold uppercase tracking-wider text-[#006496]">{group.label}</span>
          <span className="text-[11px] text-gray-500" data-testid={`group-count-${group.id}`}>
            {countsText(counts)}
          </span>
        </div>
        <LevelToggle
          value={commonLevel(counts)}
          onChange={(level) => onChange(setGroup(permissions, group, level))}
          label={`Everything under ${group.label}`}
          testKey={`group-${group.id}`}
        />
      </div>
      {isOpen && (
        <div className="divide-y divide-gray-100">
          {items.map((item) => (
            <NodeRow
              key={item.node.key}
              item={item}
              depth={0}
              parent={null}
              permissions={permissions}
              onChange={onChange}
              open={open}
              onToggle={onToggle}
              searching={searching}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * What a role can see and do: every page, tab, sub-tab and feature of the portal, by sidebar heading, each Hidden / View /
 * Edit. A part with no setting of its own follows the one above it. Search finds tabs too; "Expand all" opens every level;
 * set every key at once or copy another role. It only edits the object it is given: nothing is saved until the dialog's
 * Save.
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
  // The headings start open; a page with a part set on its own starts open too, so a role's exceptions are not hidden away.
  const [open, setOpen] = useState<Set<string>>(() => {
    const start = new Set<string>(filterTree("").map((g) => `group:${g.group.id}`));
    for (const g of filterTree("")) {
      for (const item of g.items)
        if (!item.node.locked && overrideCount(permissions, item.node) > 0) start.add(item.node.key);
    }
    return start;
  });
  const searching = query.trim() !== "";
  const groups = useMemo(() => filterTree(query), [query]);
  const counts = levelCounts(permissions);
  const everything = useMemo(() => [...filterTree("").map((g) => `group:${g.group.id}`), ...foldableKeys()], []);
  const allOpen = everything.every((k) => open.has(k));

  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <div className="space-y-3" data-testid="permission-editor">
      {/* sticks to the top of the dialog while the long list scrolls under it */}
      <div className="sticky top-0 z-10 space-y-2.5 rounded-xl border bg-gray-50 p-3 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold text-gray-900">Pages, tabs and features</p>
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
            <span className="text-gray-400">of {counts.total}</span>
          </p>
        </div>

        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search pages and tabs, e.g. payslip, issues or SMTP"
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
            <span className="text-xs text-gray-500">Set everything to</span>
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
          {!searching && (
            <button
              type="button"
              onClick={() => setOpen(allOpen ? new Set() : new Set(everything))}
              className="ml-auto text-xs font-semibold text-blue-600 hover:underline"
              data-testid="toggle-all-sections"
            >
              {allOpen ? "Collapse all" : "Expand all"}
            </button>
          )}
        </div>
      </div>

      {groups.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-10 text-center text-gray-500" data-testid="no-modules">
          <SearchX size={24} />
          <p className="text-sm">Nothing matches “{query.trim()}”.</p>
        </div>
      ) : (
        <>
          {searching && (
            <p className="text-xs text-gray-500" data-testid="search-count">
              {matchedCount(groups, query)} {matchedCount(groups, query) === 1 ? "match" : "matches"}
            </p>
          )}
          <div className="space-y-2">
            {groups.map((g) => (
              <GroupBlock
                key={g.group.id}
                group={g.group}
                items={g.items}
                permissions={permissions}
                onChange={onChange}
                open={open}
                onToggle={toggle}
                searching={searching}
              />
            ))}
          </div>
        </>
      )}
      <p className="text-[11px] leading-relaxed text-gray-400">
        A part with no setting of its own follows the one above it: change a page and its tabs follow; set a tab
        yourself only where it should differ. <b>Screen only</b> parts share their data with their page: Hidden removes
        them from the portal, but the server still answers the page.
      </p>
    </div>
  );
}

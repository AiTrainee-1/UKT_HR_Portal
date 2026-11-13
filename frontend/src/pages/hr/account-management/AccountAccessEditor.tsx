import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, RotateCcw, Search, SearchX, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import type { PermissionLevel } from "@/lib/api-client/custom-hooks";
import { applyModuleOverrides, type Permissions } from "@/lib/hr-access";
import { resolvePermission, type DisplayNode } from "@/lib/permission-modules";
import { cn } from "@/lib/utils";
import { LEVELS, countsText, filterTree, foldableKeys, partsOf, sectionCounts, type TreeItem } from "./logic";
import { LevelToggle, LockedRow, NodeChips } from "./PermissionEditor";
import { Chip } from "./parts";

const levelWord = (level: PermissionLevel) => LEVELS.find((l) => l.value === level)?.label ?? level;

/** "Follows role" or "Custom · role: View" with a reset, for one key. */
function Origin({
  node,
  custom,
  roleLevel,
  onReset,
}: {
  node: DisplayNode;
  custom: boolean;
  roleLevel: PermissionLevel;
  onReset: () => void;
}) {
  if (!custom) return <span className="text-[11px] text-gray-400">Follows role</span>;
  return (
    <span className="flex items-center gap-1">
      <Chip className="border-blue-200 bg-blue-50 text-blue-700">Custom · role: {levelWord(roleLevel)}</Chip>
      <button
        type="button"
        onClick={onReset}
        title="Follow the role again"
        aria-label={`${node.label}: follow the role again`}
        className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
        data-testid={`override-reset-${node.key}`}
      >
        <RotateCcw size={13} />
      </button>
    </span>
  );
}

/**
 * The account's own change for `node` at `level` (none when the role already gives that), and the parts that would not
 * follow it on their own (a part that follows another key, like Settings -> ID Card) changed with it. Parts the account
 * has a change of its own for keep it.
 */
export function accountSet(
  rolePermissions: Permissions,
  modules: Permissions,
  node: DisplayNode,
  level: PermissionLevel,
): Permissions {
  const next: Permissions = { ...modules };
  delete next[node.key];
  if (resolvePermission(applyModuleOverrides(rolePermissions, next), node.key) !== level) next[node.key] = level;
  for (const part of partsOf(node)) {
    if (part.key in modules) continue;
    if (resolvePermission(applyModuleOverrides(rolePermissions, next), part.key) !== level) next[part.key] = level;
  }
  return next;
}

function Row({
  item,
  depth,
  rolePermissions,
  modules,
  effective,
  onChange,
  open,
  onToggle,
  searching,
}: {
  item: TreeItem;
  depth: number;
  rolePermissions: Permissions;
  modules: Permissions;
  effective: Permissions;
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
  const custom = node.key in modules;
  const counts = hasParts ? sectionCounts(effective, node) : null;
  return (
    <div className={cn(depth > 0 && "border-t border-gray-100")} data-testid={`override-${node.key}`}>
      <div
        className={cn(
          "flex flex-col gap-1.5 py-2 pr-3 sm:flex-row sm:items-center sm:justify-between",
          custom ? "bg-blue-50/40" : depth === 0 ? "bg-white" : "bg-gray-50/40",
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
            </p>
            {counts && <p className="text-[11px] text-gray-500">{countsText(counts)}</p>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 pl-6 sm:pl-0">
          <Origin
            node={node}
            custom={custom}
            roleLevel={resolvePermission(rolePermissions, node.key)}
            onReset={() => {
              const next = { ...modules };
              delete next[node.key];
              onChange(next);
            }}
          />
          <LevelToggle
            value={resolvePermission(effective, node.key)}
            onChange={(level) => onChange(accountSet(rolePermissions, modules, node, level))}
            label={node.label}
            testKey={`ov-${node.key}`}
          />
        </div>
      </div>
      {isOpen &&
        item.children.map((child) => (
          <Row
            key={child.node.key}
            item={child}
            depth={depth + 1}
            rolePermissions={rolePermissions}
            modules={modules}
            effective={effective}
            onChange={onChange}
            open={open}
            onToggle={onToggle}
            searching={searching}
          />
        ))}
    </div>
  );
}

/**
 * An HR Manager's / HR Assistant's pages, tabs and features: every key at the level this person gets (the role, with their
 * own changes on top). Changing a level makes it "Custom" for this person only; reset puts it back to the role.
 */
export default function AccountAccessEditor({
  rolePermissions,
  modules,
  onChange,
}: {
  rolePermissions: Permissions;
  /** The account's own changes ({key: level}). */
  modules: Permissions;
  onChange: (next: Permissions) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<string>>(() => new Set(filterTree("").map((g) => `group:${g.group.id}`)));
  const effective = useMemo(() => applyModuleOverrides(rolePermissions, modules), [rolePermissions, modules]);
  const groups = useMemo(() => filterTree(query), [query]);
  const searching = query.trim() !== "";
  const everything = useMemo(() => [...filterTree("").map((g) => `group:${g.group.id}`), ...foldableKeys()], []);
  const allOpen = everything.every((k) => open.has(k));
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <div className="space-y-2" data-testid="account-access-editor">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search pages and tabs, e.g. payslip"
            aria-label="Search modules"
            className="h-9 bg-white pl-9 pr-9"
            data-testid="override-search"
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
        {!searching && (
          <button
            type="button"
            onClick={() => setOpen(allOpen ? new Set() : new Set(everything))}
            className="text-xs font-semibold text-blue-600 hover:underline"
            data-testid="override-toggle-all"
          >
            {allOpen ? "Collapse all" : "Expand all"}
          </button>
        )}
      </div>
      {groups.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center text-gray-500">
          <SearchX size={22} />
          <p className="text-sm">Nothing matches “{query.trim()}”.</p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {groups.map(({ group, items }) => {
            const id = `group:${group.id}`;
            const isOpen = searching || open.has(id);
            return (
              <div
                key={group.id}
                className="overflow-hidden rounded-xl border bg-white"
                data-testid={`ov-group-${group.id}`}
              >
                <button
                  type="button"
                  onClick={() => toggle(id)}
                  aria-expanded={isOpen}
                  className="flex w-full items-center gap-1.5 bg-slate-50 px-3 py-2 text-left"
                >
                  {isOpen ? (
                    <ChevronDown size={15} className="text-gray-400" />
                  ) : (
                    <ChevronRight size={15} className="text-gray-400" />
                  )}
                  <span className="text-xs font-bold uppercase tracking-wider text-[#006496]">{group.label}</span>
                </button>
                {isOpen && (
                  <div className="divide-y divide-gray-100">
                    {items.map((item) => (
                      <Row
                        key={item.node.key}
                        item={item}
                        depth={0}
                        rolePermissions={rolePermissions}
                        modules={modules}
                        effective={effective}
                        onChange={onChange}
                        open={open}
                        onToggle={toggle}
                        searching={searching}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

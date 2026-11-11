import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, RotateCcw, Search, SearchX, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import type { PermissionLevel } from "@/lib/api-client/custom-hooks";
import { applyModuleOverrides, type Permissions } from "@/lib/hr-access";
import { resolvePermission, type ModuleNode } from "@/lib/permission-modules";
import { cn } from "@/lib/utils";
import { LEVELS, filterModules } from "./logic";
import { LevelToggle } from "./PermissionEditor";
import { Chip } from "./parts";

const levelWord = (level: PermissionLevel) => LEVELS.find((l) => l.value === level)?.label ?? level;

/** "Follows role" or "Custom · role: View" with a reset, for one module. */
function Origin({
  node,
  custom,
  roleLevel,
  onReset,
}: {
  node: ModuleNode;
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
 * An HR Manager's / HR Assistant's pages and actions: every module at the level this person gets (the role, with their
 * own changes on top). Changing a level makes it "Custom" for this person only; reset puts it back to the role.
 */
export default function AccountAccessEditor({
  rolePermissions,
  modules,
  onChange,
}: {
  rolePermissions: Permissions;
  /** The account's own changes ({module: level}). */
  modules: Permissions;
  onChange: (next: Permissions) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const effective = useMemo(() => applyModuleOverrides(rolePermissions, modules), [rolePermissions, modules]);
  const sections = useMemo(() => filterModules(query), [query]);
  const searching = query.trim() !== "";

  const set = (key: string, level: PermissionLevel) => {
    const without = { ...modules };
    delete without[key];
    // the level this person would get anyway (from the role, or a section above it): no custom entry needed
    const anyway = resolvePermission(applyModuleOverrides(rolePermissions, without), key);
    onChange(anyway === level ? without : { ...without, [key]: level });
  };
  const reset = (key: string) => {
    const next = { ...modules };
    delete next[key];
    onChange(next);
  };

  return (
    <div className="space-y-2" data-testid="account-access-editor">
      <div className="relative">
        <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search modules, e.g. payroll"
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
      {sections.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center text-gray-500">
          <SearchX size={22} />
          <p className="text-sm">No module matches “{query.trim()}”.</p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {sections.map(({ node, children }) => {
            const hasChildren = (node.children ?? []).length > 0;
            const isOpen = searching || open.has(node.key);
            return (
              <div
                key={node.key}
                className="overflow-hidden rounded-xl border bg-white"
                data-testid={`override-${node.key}`}
              >
                <div
                  className={cn(
                    "flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:justify-between",
                    node.key in modules && "bg-blue-50/40",
                  )}
                >
                  <div className="flex min-w-0 items-center gap-1.5">
                    {hasChildren ? (
                      <button
                        type="button"
                        onClick={() =>
                          setOpen((prev) => {
                            const next = new Set(prev);
                            if (!next.delete(node.key)) next.add(node.key);
                            return next;
                          })
                        }
                        aria-expanded={isOpen}
                        aria-label={`${isOpen ? "Collapse" : "Expand"} ${node.label}`}
                        className="rounded p-0.5 text-gray-400 hover:text-gray-700"
                      >
                        {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      </button>
                    ) : (
                      <span className="w-5" />
                    )}
                    <span className="text-sm font-semibold text-gray-900">{node.label}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Origin
                      node={node}
                      custom={node.key in modules}
                      roleLevel={resolvePermission(rolePermissions, node.key)}
                      onReset={() => reset(node.key)}
                    />
                    <LevelToggle
                      value={resolvePermission(effective, node.key)}
                      onChange={(level) => set(node.key, level)}
                      label={node.label}
                      testKey={`ov-${node.key}`}
                    />
                  </div>
                </div>
                {hasChildren && isOpen && (
                  <div className="bg-gray-50/50">
                    {children.map((child) => (
                      <div
                        key={child.key}
                        className={cn(
                          "flex flex-col gap-1.5 border-t border-gray-100 py-2 pl-9 pr-3 sm:flex-row sm:items-center sm:justify-between",
                          child.key in modules && "bg-blue-50/40",
                        )}
                        data-testid={`override-${child.key}`}
                      >
                        <span className="text-sm text-gray-700">{child.label}</span>
                        <div className="flex flex-wrap items-center gap-2">
                          <Origin
                            node={child}
                            custom={child.key in modules}
                            roleLevel={resolvePermission(rolePermissions, child.key)}
                            onReset={() => reset(child.key)}
                          />
                          <LevelToggle
                            value={resolvePermission(effective, child.key)}
                            onChange={(level) => set(child.key, level)}
                            label={child.label}
                            testKey={`ov-${child.key}`}
                          />
                        </div>
                      </div>
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

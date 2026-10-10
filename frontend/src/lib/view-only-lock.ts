/**
 * View Only should allow full browsing -tabs, filters, search, pagination,
 * expand/collapse -and only block actions that actually change data. There's
 * no reliable DOM signal that separates "Add Employee" from "All Departments"
 * (both render as a plain <button>), so this classifies by the button's
 * accessible name (visible text + aria-label + title) against a list of
 * mutating-action verbs, checked as whole words so "Add" doesn't match
 * inside "Address" or similar.
 *
 * Deliberately only targets <button> -inputs/selects/textareas are left
 * alone entirely, since those are exactly the search boxes and filter
 * dropdowns View Only needs to keep working. A genuine data-entry field only
 * ever appears inside a Create/Edit dialog, and that dialog's own trigger
 * button is itself a mutating control caught here, so it never opens.
 */
const MUTATING_KEYWORDS = new Set([
  "add",
  "create",
  "new",
  "edit",
  "update",
  "save",
  "delete",
  "remove",
  "disable",
  "enable",
  "approve",
  "reject",
  "generate",
  "run",
  "upload",
  "import",
  "export",
  "sync",
  "submit",
  "assign",
  "unassign",
  "restore",
  "duplicate",
  "clone",
  "ban",
  "block",
  "revoke",
  "send",
  "post",
]);

/**
 * Opt-out for pages that are READ-ONLY by nature (the Report Center: "Generate", "Export", "Run" only read
 * and download). Put `data-view-safe` on the page's root (and on portaled popover content, which renders
 * outside that root) and none of the buttons inside are locked, so a View Only role can still use them.
 * Real data-changing buttons elsewhere stay locked - this never widens what the API allows.
 */
export const VIEW_SAFE_ATTR = "data-view-safe";

export function isMutatingControl(el: HTMLButtonElement): boolean {
  if (el.closest(`[${VIEW_SAFE_ATTR}]`)) return false;
  const accessibleName = [el.textContent, el.getAttribute("aria-label"), el.getAttribute("title")]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const words = accessibleName.match(/[a-z]+/g) ?? [];
  return words.some((w) => MUTATING_KEYWORDS.has(w));
}

/** Disables every mutating <button> under `root`, leaves everything else alone. */
export function lockMutatingControls(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>("button").forEach((btn) => {
    if (isMutatingControl(btn) && !btn.disabled) btn.disabled = true;
  });
}

/**
 * A row's bin: a <button> with only a trash icon and no words, which the name check above cannot see. A page that is
 * view-only for someone (the Managing Director's Leave & Holiday and Requests) should not offer it, so it is hidden as
 * well as disabled (a greyed-out bin says nothing). Only for icon-only buttons: a button with words is the name check's.
 */
export function lockIconOnlyDeletes(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>("button").forEach((btn) => {
    if (btn.closest(`[${VIEW_SAFE_ATTR}]`)) return;
    if ((btn.textContent ?? "").trim() !== "" || btn.getAttribute("aria-label") || btn.getAttribute("title")) return;
    if (!btn.querySelector('svg[class*="lucide-trash"]')) return;
    btn.disabled = true;
    btn.style.display = "none";
  });
}

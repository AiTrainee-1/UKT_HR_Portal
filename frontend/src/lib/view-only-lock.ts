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

// For an account whose approvals are a right of their own (HR Manager / HR Assistant categories, lib/hr-access.ts) an
// Approve / Reject button is not an edit: such an account may approve with View only, and the screens only draw those
// buttons when the server says it may (approval.canAct). Off for every other account, so nothing changes for them.
const DECISION_WORDS = new Set(["approve", "reject"]);
let approvalsSeparate = false;

/** HrLayout switches this on for an account on explicit approvals ("approvalMode": "explicit" in /auth/me). */
export function setApprovalsSeparate(on: boolean): void {
  approvalsSeparate = on;
}

export function isMutatingControl(el: HTMLButtonElement): boolean {
  if (el.closest(`[${VIEW_SAFE_ATTR}]`)) return false;
  const accessibleName = [el.textContent, el.getAttribute("aria-label"), el.getAttribute("title")]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const words = accessibleName.match(/[a-z]+/g) ?? [];
  return words.some((w) => MUTATING_KEYWORDS.has(w) && !(approvalsSeparate && DECISION_WORDS.has(w)));
}

function lockButton(btn: HTMLButtonElement): void {
  if (isMutatingControl(btn) && !btn.disabled) btn.disabled = true;
}

/** Disables every mutating <button> under `root`, leaves everything else alone. */
export function lockMutatingControls(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>("button").forEach(lockButton);
}

/** Attributes that can make a button lockable again: its name (aria-label/title), React clearing its `disabled`, or an
 *  ancestor losing the view-safe opt-out. */
const WATCHED_ATTRIBUTES = ["disabled", "aria-label", "title", VIEW_SAFE_ATTR];

/**
 * Keeps `root` locked while the page changes: one full pass now (lockMutatingControls), then only what changed, batched
 * to at most one pass per animation frame (which still runs before the next paint, so an unlocked button is never
 * shown): every added subtree, the button around changed text or children, a button whose name or `disabled` changed,
 * and a subtree that lost `data-view-safe`. The end state is the same as re-scanning the whole document after every
 * mutation, which is what this replaces (that re-scan ran for every keystroke render, poll update and tooltip).
 * Returns the function that stops watching.
 */
export function watchMutatingControls(root: HTMLElement): () => void {
  lockMutatingControls(root);
  if (typeof MutationObserver === "undefined") return () => {};

  const schedule: (cb: () => void) => number =
    typeof requestAnimationFrame === "function" ? (cb) => requestAnimationFrame(cb) : (cb) => window.setTimeout(cb, 16);
  const cancel: (handle: number) => void =
    typeof cancelAnimationFrame === "function" ? (h) => cancelAnimationFrame(h) : (h) => window.clearTimeout(h);

  const pending = new Set<Element>();
  let frame = 0;

  const flush = () => {
    frame = 0;
    const changed = Array.from(pending);
    pending.clear();
    for (const el of changed) {
      if (!root.contains(el)) continue; // removed again before the frame
      if (el instanceof HTMLButtonElement) lockButton(el);
      else el.querySelectorAll<HTMLButtonElement>("button").forEach(lockButton);
    }
  };
  const queue = (el: Element | null | undefined) => {
    if (!el) return;
    pending.add(el);
    if (!frame) frame = schedule(flush);
  };

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const target = record.target;
      if (record.type === "attributes") {
        // A name or `disabled` change matters on a button only; a lost opt-out matters for everything under it.
        if (record.attributeName === VIEW_SAFE_ATTR || target instanceof HTMLButtonElement) queue(target as Element);
      } else if (record.type === "characterData") {
        queue(target.parentElement?.closest("button"));
      } else {
        record.addedNodes.forEach((node) => {
          if (node instanceof Element) queue(node);
          else queue(node.parentElement?.closest("button"));
        });
        // Children added to / removed from inside a button change its name.
        if (target instanceof Element) queue(target.closest("button"));
      }
    }
  });
  observer.observe(root, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: WATCHED_ATTRIBUTES,
  });

  return () => {
    observer.disconnect();
    if (frame) cancel(frame);
    frame = 0;
    pending.clear();
  };
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

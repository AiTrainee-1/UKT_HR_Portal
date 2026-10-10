// ID Cards: the rules behind the page, kept apart from the screens so they can be tested on their own.

import type { Employee } from "@/lib/api-client/generated/api.schemas";
import type { IdCardData } from "@/lib/api-client/custom-hooks";

export type TypeFilter = "all" | "staff" | "production";
/** What is known about an employee's card details: every card shows the photo, blood group and an emergency number. */
export type DetailsFilter = "all" | "has_photo" | "no_photo" | "incomplete";

export type PickerFilters = {
  query: string;
  type: TypeFilter;
  /** "all" or a branch id. */
  branch: string;
  /** "all" or a department id. */
  department: string;
  details: DetailsFilter;
};

export const NO_FILTERS: PickerFilters = { query: "", type: "all", branch: "all", department: "all", details: "all" };

export const filtersActive = (f: PickerFilters) =>
  f.query.trim() !== "" || f.type !== "all" || f.branch !== "all" || f.department !== "all" || f.details !== "all";

/** How many employees the picker shows at first, and how many more each "Show more" adds. */
export const PAGE_SIZE = 50;
/** The card request lists the ids in the URL, so a large selection is fetched in pieces. */
export const CARD_CHUNK = 100;

export const fullName = (e: Pick<Employee, "firstName" | "lastName">) => `${e.firstName} ${e.lastName}`.trim();

export const isProduction = (e: Pick<Employee, "employmentType">) => e.employmentType === "production";

export const hasPhoto = (e: Pick<Employee, "photoUrl">) => !!e.photoUrl?.trim();

export type CardGap = "photo" | "bloodGroup" | "emergency";

export const GAP_LABEL: Record<CardGap, string> = {
  photo: "No photo",
  bloodGroup: "No blood group",
  emergency: "No emergency contact",
};

/** What the printed card will show as a blank or a dash for this employee (the back falls back to the phone number). */
export function cardGaps(e: Pick<Employee, "photoUrl" | "bloodGroup" | "emergencyContact" | "phone">): CardGap[] {
  const gaps: CardGap[] = [];
  if (!e.photoUrl?.trim()) gaps.push("photo");
  if (!e.bloodGroup?.trim()) gaps.push("bloodGroup");
  if (!e.emergencyContact?.trim() && !e.phone?.trim()) gaps.push("emergency");
  return gaps;
}

/** Every word typed must appear in the employee's name, code, unit code, designation, department or branch. */
export function filterEmployees(employees: Employee[], f: PickerFilters): Employee[] {
  const words = f.query.toLowerCase().split(/\s+/).filter(Boolean);
  return employees.filter((e) => {
    if (f.type === "production" && !isProduction(e)) return false;
    if (f.type === "staff" && isProduction(e)) return false;
    if (f.branch !== "all" && String(e.branchId ?? "") !== f.branch) return false;
    if (f.department !== "all" && String(e.departmentId ?? "") !== f.department) return false;
    if (f.details === "has_photo" && !hasPhoto(e)) return false;
    if (f.details === "no_photo" && hasPhoto(e)) return false;
    if (f.details === "incomplete" && cardGaps(e).length === 0) return false;
    if (words.length === 0) return true;
    const haystack = [
      fullName(e),
      e.employeeCode,
      e.unitCode,
      e.designationTitle,
      e.departmentName,
      e.branchName,
      e.branchCode,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
}

export type Option = { value: string; label: string };

/** The branches and departments that occur among the employees (scoped to what the viewer may see), for the filters. */
export function facetsOf(employees: Employee[]): { branches: Option[]; departments: Option[] } {
  const branches = new Map<number, string>();
  const departments = new Map<number, string>();
  for (const e of employees) {
    if (e.branchId != null && e.branchName) branches.set(e.branchId, e.branchName);
    if (e.departmentId != null && e.departmentName) departments.set(e.departmentId, e.departmentName);
  }
  const toOptions = (m: Map<number, string>) =>
    [...m]
      .map(([id, label]) => ({ value: String(id), label }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
  return { branches: toOptions(branches), departments: toOptions(departments) };
}

export type PickerSummary = {
  total: number;
  staff: number;
  production: number;
  withPhoto: number;
  withoutPhoto: number;
  /** Everything a card shows is on file. */
  complete: number;
  incomplete: number;
};

export function summarizeEmployees(employees: Employee[]): PickerSummary {
  const production = employees.filter(isProduction).length;
  const withPhoto = employees.filter(hasPhoto).length;
  const complete = employees.filter((e) => cardGaps(e).length === 0).length;
  return {
    total: employees.length,
    staff: employees.length - production,
    production,
    withPhoto,
    withoutPhoto: employees.length - withPhoto,
    complete,
    incomplete: employees.length - complete,
  };
}

// ─── selection ──────────────────────────────────────────────────────────────────

export const toggleId = (ids: number[], id: number): number[] =>
  ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];

/** Adds every listed id that is not selected yet, after the ones already chosen. */
export const addIds = (ids: number[], add: number[]): number[] => {
  const have = new Set(ids);
  return [...ids, ...add.filter((id) => !have.has(id))];
};

/** The shown employees are all chosen. */
export const allSelected = (shown: Employee[], ids: number[]) => {
  const have = new Set(ids);
  return shown.length > 0 && shown.every((e) => have.has(e.id));
};

/** Takes the shown employees out of the selection (the others stay). */
export const removeIds = (ids: number[], remove: number[]): number[] => {
  const gone = new Set(remove);
  return ids.filter((id) => !gone.has(id));
};

/** Selected ids that are no longer among the employees (left the company, changed branch) are dropped. */
export const keepKnown = (ids: number[], employees: Employee[]): number[] => {
  const known = new Set(employees.map((e) => e.id));
  return ids.filter((id) => known.has(id));
};

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The server returns cards in its own order; they are shown in the order they were selected, and only the selected, each once. */
export function orderCards(cards: IdCardData[], ids: number[]): IdCardData[] {
  const rank = new Map(ids.map((id, i) => [id, i]));
  const seen = new Set<number>();
  return cards
    .filter((c) => rank.has(c.id) && !seen.has(c.id) && seen.add(c.id))
    .sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
}

export type SelectionSummary = { count: number; staff: number; production: number; noPhoto: Employee[] };

export function summarizeSelection(employees: Employee[], ids: number[]): SelectionSummary {
  const chosen = new Set(ids);
  const picked = employees.filter((e) => chosen.has(e.id));
  const production = picked.filter(isProduction).length;
  return {
    count: picked.length,
    staff: picked.length - production,
    production,
    noPhoto: picked.filter((e) => !hasPhoto(e)),
  };
}

export const cardFileName = (card: Pick<IdCardData, "code" | "name">) =>
  `ID-Card-${card.code}-${card.name.replace(/[^a-z0-9]+/gi, "_")}.png`;

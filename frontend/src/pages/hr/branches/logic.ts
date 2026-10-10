// Manage Branch: the rules behind the page, kept apart from the screens so they can be tested on their own.

import type { Branch } from "@/lib/api-client/custom-hooks";
import type { BranchSummary, BranchSummaryRow } from "./api";

export type GeoFilter = "all" | "set" | "unset";
export type BranchSort = "name" | "code" | "people" | "departments" | "newest";

export type BranchFilters = {
  query: string;
  geo: GeoFilter;
  headOfficeOnly: boolean;
};

export const NO_FILTERS: BranchFilters = { query: "", geo: "all", headOfficeOnly: false };

export const SORT_LABELS: Record<BranchSort, string> = {
  name: "Name (A to Z)",
  code: "Code",
  people: "Most people",
  departments: "Most departments",
  newest: "Newest first",
};

export const filtersActive = (f: BranchFilters) => f.query.trim() !== "" || f.geo !== "all" || f.headOfficeOnly;

export const hasGeofence = (b: Pick<Branch, "geofenceLat" | "geofenceLng">) =>
  b.geofenceLat != null && b.geofenceLng != null;

/** The figures of one branch by its id (undefined while they load, or for a branch outside the viewer's scope). */
export const summaryMap = (summary: BranchSummary | undefined): Map<number, BranchSummaryRow> =>
  new Map((summary?.branches ?? []).map((r) => [r.branchId, r]));

/** Active people in a branch. */
export const headcount = (row: BranchSummaryRow | undefined) => (row ? row.staffActive + row.productionActive : 0);

/** Every word typed must appear in the branch's name, code, location, address, phone or manager. */
export function filterBranches(branches: Branch[], f: BranchFilters): Branch[] {
  const words = f.query.toLowerCase().split(/\s+/).filter(Boolean);
  return branches.filter((b) => {
    if (f.geo === "set" && !hasGeofence(b)) return false;
    if (f.geo === "unset" && hasGeofence(b)) return false;
    if (f.headOfficeOnly && !b.isHeadOffice) return false;
    if (words.length === 0) return true;
    const haystack = [
      b.name,
      b.code,
      b.location,
      b.address,
      b.phone,
      b.managerName,
      b.isHeadOffice ? "head office" : "",
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
}

const text = (v: string | null | undefined) => (v ?? "").toLowerCase();

/** A sorted copy. The head office always comes first when sorting by name, and ties fall back to the name. */
export function sortBranches(branches: Branch[], sort: BranchSort, figures: Map<number, BranchSummaryRow>): Branch[] {
  const byName = (a: Branch, b: Branch) => text(a.name).localeCompare(text(b.name));
  const compare = (a: Branch, b: Branch): number => {
    switch (sort) {
      case "code":
        // a branch with no code goes last
        return (text(a.code) || "￿").localeCompare(text(b.code) || "￿");
      case "people":
        return headcount(figures.get(b.id)) - headcount(figures.get(a.id));
      case "departments":
        return (figures.get(b.id)?.departments.length ?? 0) - (figures.get(a.id)?.departments.length ?? 0);
      case "newest":
        return (b.createdAt ? Date.parse(b.createdAt) : 0) - (a.createdAt ? Date.parse(a.createdAt) : 0);
      default:
        return Number(b.isHeadOffice) - Number(a.isHeadOffice);
    }
  };
  return [...branches].sort((a, b) => compare(a, b) || byName(a, b));
}

export type BranchTotals = {
  branches: number;
  headOffice: Branch | null;
  staff: number;
  production: number;
  people: number;
  unassigned: number;
  withGeofence: number;
  withoutGeofence: number;
  departments: number;
  /** Branches that have no department yet. */
  emptyBranches: number;
};

export function totalsOf(branches: Branch[], summary: BranchSummary | undefined): BranchTotals {
  const figures = summaryMap(summary);
  let staff = 0;
  let production = 0;
  let departments = 0;
  let emptyBranches = 0;
  for (const b of branches) {
    const row = figures.get(b.id);
    staff += row?.staffActive ?? 0;
    production += row?.productionActive ?? 0;
    departments += row?.departments.length ?? 0;
    if (row && row.departments.length === 0) emptyBranches += 1;
  }
  const withGeofence = branches.filter(hasGeofence).length;
  return {
    branches: branches.length,
    headOffice: branches.find((b) => b.isHeadOffice) ?? null,
    staff,
    production,
    people: staff + production,
    unassigned: summary?.unassignedActive ?? 0,
    withGeofence,
    withoutGeofence: branches.length - withGeofence,
    departments,
    emptyBranches,
  };
}

/** The code the next employee created in this branch gets (see _assign_unit_code on the server), or null without a code. */
export const nextUnitCode = (b: Pick<Branch, "code">, row: BranchSummaryRow | undefined): string | null => {
  const code = (b.code ?? "").trim();
  return code ? `${code}-${(row?.nextEmployeeSeq ?? 0) + 1}` : null;
};

// ─── the add / edit form ────────────────────────────────────────────────────────

export const MIN_RADIUS = 20;
export const MAX_RADIUS = 2000;
export const DEFAULT_RADIUS = 200;

export type BranchForm = {
  name: string;
  code: string;
  location: string;
  address: string;
  phone: string;
  isHeadOffice: boolean;
  geofenceLat: number | null;
  geofenceLng: number | null;
  /** Kept as typed, so clearing the box to type a new number does not snap back. */
  radius: string;
};

export const EMPTY_FORM: BranchForm = {
  name: "",
  code: "",
  location: "",
  address: "",
  phone: "",
  isHeadOffice: false,
  geofenceLat: null,
  geofenceLng: null,
  radius: String(DEFAULT_RADIUS),
};

export const formOf = (b: Branch): BranchForm => ({
  name: b.name,
  code: b.code ?? "",
  location: b.location ?? "",
  address: b.address ?? "",
  phone: b.phone ?? "",
  isHeadOffice: b.isHeadOffice,
  geofenceLat: b.geofenceLat ?? null,
  geofenceLng: b.geofenceLng ?? null,
  radius: String(b.geofenceRadiusM ?? DEFAULT_RADIUS),
});

export type FormErrors = Partial<Record<"name" | "code" | "phone" | "radius", string>>;

/** What stops the form from being saved. `others` are the other branches (the one being edited left out). */
export function validateForm(form: BranchForm, others: Pick<Branch, "name" | "code">[]): FormErrors {
  const errors: FormErrors = {};
  const name = form.name.trim();
  const code = form.code.trim();
  if (!name) errors.name = "Branch name is required";
  else if (others.some((o) => text(o.name).trim() === name.toLowerCase())) {
    errors.name = "Another branch already has this name";
  }
  // the code is unique on the server; without this a repeated one comes back as a server error
  if (code && others.some((o) => text(o.code).trim() === code.toLowerCase())) {
    errors.code = "Another branch already uses this code";
  }
  const phone = form.phone.trim();
  if (phone && !/^[+()\-\s\d.]{6,20}$/.test(phone)) errors.phone = "Use digits, spaces, + and - only";
  if (form.geofenceLat != null) {
    const radius = Number(form.radius);
    if (!Number.isFinite(radius) || radius < MIN_RADIUS || radius > MAX_RADIUS) {
      errors.radius = `Between ${MIN_RADIUS} and ${MAX_RADIUS} metres`;
    }
  }
  return errors;
}

const radiusOf = (form: BranchForm) => {
  const radius = Number(form.radius);
  return Number.isFinite(radius) && radius >= MIN_RADIUS ? Math.round(radius) : DEFAULT_RADIUS;
};

/** The request body for a new branch: empty optional fields are left out. */
export function toCreatePayload(form: BranchForm) {
  const clean = (v: string) => v.trim() || undefined;
  return {
    name: form.name.trim(),
    code: clean(form.code),
    location: clean(form.location),
    address: clean(form.address),
    phone: clean(form.phone),
    isHeadOffice: form.isHeadOffice,
    geofenceLat: form.geofenceLat,
    geofenceLng: form.geofenceLng,
    geofenceRadiusM: radiusOf(form),
  };
}

/** The request body for an edit: a field that was cleared goes as null so it really is cleared on the server. */
export function toUpdatePayload(form: BranchForm) {
  const clean = (v: string) => v.trim() || null;
  return {
    name: form.name.trim(),
    code: clean(form.code),
    location: clean(form.location),
    address: clean(form.address),
    phone: clean(form.phone),
    isHeadOffice: form.isHeadOffice,
    geofenceLat: form.geofenceLat,
    geofenceLng: form.geofenceLng,
    geofenceRadiusM: radiusOf(form),
  };
}

// ─── export ─────────────────────────────────────────────────────────────────────

export const EXPORT_HEADERS = [
  "Branch",
  "Code",
  "Head office",
  "Location",
  "Address",
  "Phone",
  "Staff (active)",
  "Production (active)",
  "Inactive",
  "Departments",
  "Geofence",
  "Latitude",
  "Longitude",
  "Radius (m)",
];

/** One row per branch, in the order shown. */
export function exportRows(branches: Branch[], figures: Map<number, BranchSummaryRow>): (string | number)[][] {
  return branches.map((b) => {
    const row = figures.get(b.id);
    const geo = hasGeofence(b);
    return [
      b.name,
      b.code ?? "",
      b.isHeadOffice ? "Yes" : "No",
      b.location ?? "",
      b.address ?? "",
      b.phone ?? "",
      row ? row.staffActive : "",
      row ? row.productionActive : "",
      row ? row.inactive : "",
      row ? row.departments.length : "",
      geo ? "Set" : "Not set",
      geo ? Number(b.geofenceLat) : "",
      geo ? Number(b.geofenceLng) : "",
      geo ? (b.geofenceRadiusM ?? DEFAULT_RADIUS) : "",
    ];
  });
}

/** An OpenStreetMap link to a branch's geofence centre. */
export const mapLink = (lat: number, lng: number) =>
  `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`;

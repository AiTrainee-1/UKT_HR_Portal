// visitor-admin: Visitors (/hr/outpass-visitors/visitors; Visits / People is a `?view=` switch, not a tab). OWNER: slice
// C. HR token, permission key outpass_visitors.visitors (view for GET, edit for writes). Backend: outpass_visitor_views.py
// (records, summary) and visitor_admin_views.py (register, detail, check-out, people, export, the desk's check-out).
//
//   GET  /api/visitor/records?range|from&to&status&branchId&hostEmployeeId&departmentId&source&q&page&pageSize
//                                               -> VisitorVisitsPage (every old key of VisitorRecordRow kept)
//   GET  /api/visitor/summary?<the same filters>[&options=1] -> VisitorDashboardSummary ({today, thisWeek, thisMonth}
//                                               kept; options = the Host / Department selects)
//   POST /api/visitor/visits                    VisitorRegisterInput -> VisitorVisit (201; HR registers = check-in now;
//                                               409 {code: "already_inside", visitId} when that visitor is inside)
//   GET  /api/visitor/visits/<id>               -> VisitorVisitDetail (the visit + the visitor's last 20 visits)
//   POST /api/visitor/visits/<id>/check-out     {note?} -> VisitorVisit (409 already checked out / an earlier day)
//   GET  /api/visitor/people?q&phone&branchId&page&pageSize -> VisitorPeoplePage (phone: the "returning visitor" check)
//   GET  /api/visitor/export?fmt=xlsx|pdf&<records filters>   (kit/download.ts; Aadhaar masked in the file)
//   POST /api/reception-devices/visits/<id>/check-out         the reception desk (its own token, own branch only: the
//                                               desk's own fetch in pages/gate/reception/desk-api.ts, never this file)
//
// The old Visitors and reception-desk hooks of gate.ts are gone (unused); the visitor-gate form hooks stay there.
// Every query here starts its key with "/api/visitor/", and invalidateVisitorQueries refreshes all of them after a change.

import { keepPreviousData, useMutation, useQuery, type QueryClient } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";
import type { PaginatedRecords, VisitorRecordRow } from "./gate";

/** checked_out: check-out recorded; inside: came today and not checked out; not_checked_out: an earlier day, left without. */
export type VisitStatus = "inside" | "checked_out" | "not_checked_out";
/** qr: the visitor's own phone at the QR; hr: registered on this page; reception: at a reception desk. */
export type VisitSource = "qr" | "hr" | "reception";

/** One visit: the old row's keys plus the new ones. */
export type VisitorVisit = VisitorRecordRow & {
  visitorId: number;
  branchId: number | null;
  source: VisitSource;
  sourceLabel: string;
  /** Who registered it (null for a QR self check-in). */
  checkedInBy: string | null;
  checkedOutAt: string | null;
  checkedOutBy: string | null;
  checkoutSource: "hr" | "reception" | null;
  company: string | null;
  vehicleNumber: string | null;
  peopleCount: number;
  idProofType: string | null;
  badgeNumber: string | null;
  notes: string | null;
  status: VisitStatus;
  statusLabel: string;
  /** Inside until check-out (or until now while inside); null when the visitor left without a check-out. */
  minutesInside: number | null;
  /** This visitor's visits so far (this branch for a branch account). */
  visitCount: number;
  /** A check-out may be recorded: none yet and checked in under 24 hours ago (a night visitor too). Older servers: unset. */
  canCheckOut?: boolean;
};

export type VisitorVisitsPage = PaginatedRecords<VisitorVisit>;

export type VisitorFilterOptions = {
  hosts: { id: number; name: string; department: string | null }[];
  departments: { id: number; name: string }[];
};

export type VisitorDashboardSummary = {
  today: number;
  thisWeek: number;
  thisMonth: number;
  insideNow: number;
  checkedOutToday: number;
  /** Inside for more than 2 hours. */
  longStayNow: number;
  repeatThisMonth: number;
  inRange: { visits: number; checkedOut: number; avgMinutes: number | null };
  /** The figures of the dates, every filter but the status (2026-11-24: the page's tiles follow its date filter): the
   *  visits, how many checked out, and how many of their visitors came twice or more. Older servers leave it out. */
  rangeTotals?: { visits: number; checkedOut: number; repeat: number };
  /** Only with ?options=1. */
  options?: VisitorFilterOptions;
};

export type VisitorRegisterInput = {
  name: string;
  phone: string;
  aadhaarNumber?: string;
  company?: string;
  vehicleNumber?: string;
  peopleCount?: number;
  idProofType?: string;
  badgeNumber?: string;
  whomToMeet: string;
  meetingEmployeeId?: number;
  purpose: string;
  whyCame?: string;
  notes?: string;
  /** Only for an HR account not bound to a branch. */
  branchId?: number;
};

export type VisitorVisitDetail = VisitorVisit & { history: VisitorVisit[] };

export type VisitorCheckOutInput = { note?: string };

export type VisitorPerson = {
  id: number;
  name: string;
  phoneMasked: string;
  lastVisitAt: string | null;
  visitCount: number;
  lastHost: string | null;
  insideNow: boolean;
  /** Opens the drawer (that visit and the visitor's history). */
  lastVisitId: number | null;
  lastCompany: string | null;
};

export type VisitorPeoplePage = PaginatedRecords<VisitorPerson>;

export type VisitorFilters = {
  from?: string;
  to?: string;
  status?: VisitStatus | "";
  branchId?: string;
  hostEmployeeId?: string;
  departmentId?: string;
  source?: VisitSource | "";
  q?: string;
  page?: number;
  pageSize?: number;
};

export const VISITOR_ADMIN_API = {
  records: "/api/visitor/records",
  summary: "/api/visitor/summary",
  register: "/api/visitor/visits",
  detail: (id: number) => `/api/visitor/visits/${id}`,
  checkOut: (id: number) => `/api/visitor/visits/${id}/check-out`,
  people: "/api/visitor/people",
  export: "/api/visitor/export",
  receptionCheckOut: (id: number) => `/api/reception-devices/visits/${id}/check-out`,
} as const;

const withQuery = (path: string, query: string) => (query ? `${path}?${query}` : path);

/** `query`: the page's filters (useGateFilters().params / exportQuery as a string). */
export const getVisitorVisitsQueryKey = (query: string) => [VISITOR_ADMIN_API.records, "visits", query] as const;
export const useVisitorVisits = (query: string, options?: { enabled?: boolean }) =>
  useQuery<VisitorVisitsPage>({
    queryKey: getVisitorVisitsQueryKey(query),
    queryFn: () => customFetch<VisitorVisitsPage>(withQuery(VISITOR_ADMIN_API.records, query)),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
    enabled: options?.enabled ?? true,
  });

export const getVisitorDashboardQueryKey = (query: string) => [VISITOR_ADMIN_API.summary, "dashboard", query] as const;
export const useVisitorDashboard = (query: string) =>
  useQuery<VisitorDashboardSummary>({
    queryKey: getVisitorDashboardQueryKey(query),
    queryFn: () => customFetch<VisitorDashboardSummary>(withQuery(VISITOR_ADMIN_API.summary, query)),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });

/** The Host and Department selects: the employees visitors came to meet (`branchId` for an account not bound to one). */
export const getVisitorFilterOptionsQueryKey = (branchId: string) =>
  [VISITOR_ADMIN_API.summary, "options", branchId] as const;
export const useVisitorFilterOptions = (branchId: string) =>
  useQuery<VisitorFilterOptions>({
    queryKey: getVisitorFilterOptionsQueryKey(branchId),
    queryFn: async () => {
      const query = new URLSearchParams({ options: "1", range: "today" });
      if (branchId) query.set("branchId", branchId);
      const summary = await customFetch<VisitorDashboardSummary>(`${VISITOR_ADMIN_API.summary}?${query}`);
      return summary.options ?? { hosts: [], departments: [] };
    },
    staleTime: 5 * 60_000,
  });

export const getVisitorVisitQueryKey = (id: number | null) => ["/api/visitor/visits", id] as const;
export const useVisitorVisit = (id: number | null) =>
  useQuery<VisitorVisitDetail>({
    queryKey: getVisitorVisitQueryKey(id),
    queryFn: () => customFetch<VisitorVisitDetail>(VISITOR_ADMIN_API.detail(id!)),
    enabled: id !== null,
  });

export const getVisitorPeopleQueryKey = (query: string) => [VISITOR_ADMIN_API.people, query] as const;
export const useVisitorPeople = (query: string, options?: { enabled?: boolean }) =>
  useQuery<VisitorPeoplePage>({
    queryKey: getVisitorPeopleQueryKey(query),
    queryFn: () => customFetch<VisitorPeoplePage>(withQuery(VISITOR_ADMIN_API.people, query)),
    placeholderData: keepPreviousData,
    enabled: options?.enabled ?? true,
  });

/** The register form's "returning visitor" check: the visitor with this phone (however it is typed), if any. */
export const getVisitorByPhoneQueryKey = (phone: string, branchId: string) =>
  [VISITOR_ADMIN_API.people, "phone", phone, branchId] as const;
export const useVisitorByPhone = (phone: string, branchId: string) =>
  useQuery<VisitorPerson | null>({
    queryKey: getVisitorByPhoneQueryKey(phone, branchId),
    queryFn: async () => {
      const query = new URLSearchParams({ phone, pageSize: "1" });
      if (branchId) query.set("branchId", branchId);
      const page = await customFetch<VisitorPeoplePage>(`${VISITOR_ADMIN_API.people}?${query}`);
      return page.items[0] ?? null;
    },
    enabled: phone.replace(/\D/g, "").length >= 7,
    staleTime: 30_000,
  });

export const useRegisterVisitor = () =>
  useMutation({
    mutationFn: (body: VisitorRegisterInput) =>
      customFetch<VisitorVisit>(VISITOR_ADMIN_API.register, { method: "POST", body: JSON.stringify(body) }),
  });

export const useCheckOutVisitor = () =>
  useMutation({
    mutationFn: ({ id, note }: { id: number } & VisitorCheckOutInput) =>
      customFetch<VisitorVisit>(VISITOR_ADMIN_API.checkOut(id), {
        method: "POST",
        body: JSON.stringify(note ? { note } : {}),
      }),
  });

const VISITOR_KEY = /^\/api\/visitor\/(records|summary|people|visits)/;

/** After a register or a check-out: the list, the figures, the People view and any open visit read again. */
export const invalidateVisitorQueries = (client: QueryClient) =>
  client.invalidateQueries({
    predicate: (query) => typeof query.queryKey[0] === "string" && VISITOR_KEY.test(query.queryKey[0]),
  });

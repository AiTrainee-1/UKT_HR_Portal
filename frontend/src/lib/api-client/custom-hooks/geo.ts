// geo: hooks/types split out of the former single custom-hooks.ts (see ./index.ts).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch, getApiOrigin } from "../custom-fetch";

// ═══════════════════════════════════════════════════════════════════════════
//  Geo Attendance (Office Geo Punch + On-Duty two-stage approval + live tracking)
// ═══════════════════════════════════════════════════════════════════════════

/** The destination-request gate -no photos/GPS at this stage, that
 * verification now happens per-punch (see OnDutyPunchVerificationItem
 * below). Two-stage HOD->HR chain same as before; approval flips status to
 * "active" (started_at stamped), and the session ends in "completed" either
 * automatically (4th punch approved) or manually (employee taps Done). */
export type OnDutySessionItem = {
  id: number;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  destination: string;
  branchId: number | null;
  branchName: string | null;
  status: "pending_hod" | "pending_hr" | "active" | "completed" | "rejected";
  /** True DB status. Identical to `status` on HR endpoints; differs only on
   *  employee-facing ones, where a provisional session is presented as
   *  active so the app lets the employee start work immediately. */
  approvalStatus: "pending_hod" | "pending_hr" | "active" | "completed" | "rejected";
  /** Submitted and already being worked, but not yet HR-approved. */
  isProvisional: boolean;
  /** Punches captured under this request that are still awaiting review —
   *  all voided if the request is rejected. */
  pendingPunchCount: number;
  /** When the employee tapped "Done"; may be set while still pending. */
  employeeEndedAt: string | null;
  hodReviewedBy: string | null;
  hodReviewComment: string | null;
  hodReviewedAt: string | null;
  hrReviewedBy: string | null;
  hrReviewComment: string | null;
  hrReviewedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  completedBy: string | null;
  completionReason: "manual" | "auto_4th_punch" | null;
  createdAt: string | null;
};

export const useOnDutySessionsHR = (
  status: "pending" | "pending_hod" | "pending_hr" | "active" | "completed" | "rejected" | "all" = "pending",
  enabled = true,
) =>
  useQuery<OnDutySessionItem[]>({
    queryKey: ["/api/on-duty-sessions", status],
    queryFn: () => customFetch<OnDutySessionItem[]>(`/api/on-duty-sessions?status=${status}`),
    refetchInterval: 30_000,
    enabled,
  });

export const useUpdateOnDutySessionHR = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status, comment }: { id: number; status: "approved" | "rejected"; comment?: string }) =>
      customFetch<OnDutySessionItem>(`/api/on-duty-sessions/${id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status, comment }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/on-duty-sessions"] });
    },
  });
};

/** One of the day's (up to 4) attendance punches, captured with a selfie +
 * GPS while a session is active -held pending until HR approves it, then
 * written as a real punch. Single-stage (HR only), unlike the session gate. */
export type OnDutyPunchVerificationItem = {
  id: number;
  sessionId: number;
  sessionStatus: "pending_hod" | "pending_hr" | "active" | "completed" | "rejected";
  /** False while the parent request is still awaiting approval — this punch
   *  cannot be approved into attendance until that request is approved. */
  sessionApproved: boolean;
  sessionDestination: string;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  punchDate: string;
  punchTime: string;
  punchType: "IN" | "OUT";
  punchNumber: number;
  latitude: number;
  longitude: number;
  accuracyM: number | null;
  isMocked: boolean;
  hasPhoto: boolean;
  status: "pending" | "approved" | "rejected";
  hrReviewedBy: string | null;
  hrReviewComment: string | null;
  hrReviewedAt: string | null;
  createdAt: string | null;
};

export const useOnDutyPunchVerificationsHR = (
  status: "pending" | "approved" | "rejected" | "all" = "pending",
  enabled = true,
) =>
  useQuery<OnDutyPunchVerificationItem[]>({
    queryKey: ["/api/on-duty-punch-verifications", status],
    queryFn: () => customFetch<OnDutyPunchVerificationItem[]>(`/api/on-duty-punch-verifications?status=${status}`),
    refetchInterval: 20_000,
    enabled,
  });

export const useUpdateOnDutyPunchVerificationHR = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status, comment }: { id: number; status: "approved" | "rejected"; comment?: string }) =>
      customFetch<OnDutyPunchVerificationItem>(`/api/on-duty-punch-verifications/${id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status, comment }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/on-duty-punch-verifications"] });
    },
  });
};

/** One decision for every punch still pending under an On-Duty request.
 *  Covers punches that arrive after the request itself was approved -the
 *  approval already accepted everything captured up to that point. */
export const useUpdateOnDutySessionPunchesHR = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      sessionId,
      status,
      comment,
    }: {
      sessionId: number;
      status: "approved" | "rejected";
      comment?: string;
    }) =>
      customFetch<{ updated: number; session: OnDutySessionItem }>(`/api/on-duty-sessions/${sessionId}/punches`, {
        method: "PATCH",
        body: JSON.stringify({ status, comment }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/on-duty-punch-verifications"] });
      queryClient.invalidateQueries({ queryKey: ["/api/on-duty-sessions"] });
    },
  });
};

/** Fetches an auth-protected image (geo-punch photos) and returns a blob
 * object URL -img src can't carry an Authorization header, so this mirrors
 * _fetchPdfBlob's fetch-then-objectURL pattern for images instead. Caller
 * owns revoking the URL when done with it. */
export const fetchAuthedImageObjectUrl = async (url: string, getToken: () => string | null): Promise<string> => {
  const token = getToken();
  // Same as _fetchPdfBlob above -callers pass a relative /api/... path.
  const response = await fetch(`${getApiOrigin()}${url}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) throw new Error("Failed to load photo");
  const blob = await response.blob();
  return URL.createObjectURL(blob);
};

/** Fetches an auth-protected file and triggers a real browser "Save As",
 * with the actual filename -unlike an <a href> to the API, which can't
 * attach a Bearer header, and unlike fetchAuthedImageObjectUrl above, which
 * hands back a blob URL for an <img> rather than saving anything. Used for
 * "Download" buttons on files a page doesn't otherwise render (backup
 * zips, resumes, documents). The object URL is revoked right after the
 * click -this fetches fresh from the server every time (the "cloud, at
 * that moment" behavior), never a locally cached copy. */
export const downloadAuthedFile = async (
  url: string,
  filename: string,
  getToken: () => string | null,
): Promise<void> => {
  const token = getToken();
  const response = await fetch(`${getApiOrigin()}${url}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || `Download failed (${response.status})`);
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
};

export type LiveLocationTeamMember = {
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  branchName: string | null;
  latitude: number | null;
  longitude: number | null;
  isMocked: boolean;
  lastSeenAt: string | null;
};

export const useLiveLocationTeam = (enabled = true) =>
  useQuery<LiveLocationTeamMember[]>({
    queryKey: ["/api/live-location/team"],
    queryFn: () => customFetch<LiveLocationTeamMember[]>("/api/live-location/team"),
    refetchInterval: 20_000,
    enabled,
  });

export type LiveLocationTrailPoint = { latitude: number; longitude: number; recordedAt: string; isMocked: boolean };

export const useLiveLocationTrail = (employeeId: number | null) =>
  useQuery<LiveLocationTrailPoint[]>({
    queryKey: ["/api/live-location/trail", employeeId],
    queryFn: () => customFetch<LiveLocationTrailPoint[]>(`/api/live-location/team/${employeeId}/trail`),
    enabled: employeeId != null,
    refetchInterval: 20_000,
  });

export type LiveLocationRoute = {
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  date: string;
  points: { latitude: number; longitude: number; recordedAt: string; isMocked: boolean }[];
};

export const useLiveLocationRoute = (employeeId: number | null, date: string) =>
  useQuery<LiveLocationRoute>({
    queryKey: ["/api/live-location/route", employeeId, date],
    queryFn: () => customFetch<LiveLocationRoute>(`/api/live-location/team/${employeeId}/route?date=${date}`),
    enabled: employeeId != null,
  });

export type OnDutyMapEmployee = {
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  locationTrackingEnabled: boolean;
  latitude: number | null;
  longitude: number | null;
  lastSeenAt: string | null;
  routePoints: { latitude: number; longitude: number; recordedAt: string }[];
  session: { id: number; destination: string; status: string };
  punches: { punchNumber: number; punchType: "IN" | "OUT"; punchTime: string; status: string }[];
};

export const useOnDutyMap = (date: string) =>
  useQuery<{ date: string; employees: OnDutyMapEmployee[] }>({
    queryKey: ["/api/on-duty-map", date],
    queryFn: () => customFetch<{ date: string; employees: OnDutyMapEmployee[] }>(`/api/on-duty-map?date=${date}`),
    refetchInterval: 20_000,
  });

export const useUpdateEmployeeLocationTracking = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ employeeId, enabled }: { employeeId: number; enabled: boolean }) =>
      customFetch(`/api/employees/${employeeId}`, {
        method: "PATCH",
        body: JSON.stringify({ locationTrackingEnabled: enabled }),
      }),
    onSuccess: () => {
      // /api/employees list + /api/live-location/team both need a refetch —
      // matches by query-key prefix so every params variant is caught.
      queryClient.invalidateQueries({ queryKey: ["/api/employees"] });
      queryClient.invalidateQueries({ queryKey: ["/api/live-location/team"] });
    },
  });
};

// "Co Emp" toggle (Employees -> Co Emp tab): marks an employee as visible to
// an external application consuming this HRMS's API. Off by default; this
// only flips the flag itself, nothing inside this app changes behavior when
// it's on. Same shape as useUpdateEmployeeLocationTracking above.
export const useUpdateEmployeeCoEmp = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ employeeId, enabled }: { employeeId: number; enabled: boolean }) =>
      customFetch(`/api/employees/${employeeId}`, {
        method: "PATCH",
        body: JSON.stringify({ coEmpEnabled: enabled }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/employees"] });
    },
  });
};

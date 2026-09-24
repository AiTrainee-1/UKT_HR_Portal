// documents: hooks/types split out of the former single custom-hooks.ts (see ./index.ts).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch, getApiOrigin } from "../custom-fetch";

// ── ID Card Template Settings ─────────────────────────────────────────────────

export type IdCardSettingsItem = {
  primaryColor: string;
  secondaryColor: string;
  textColor: string;
  fontFamily: string;
  backgroundStyle: string;
  logoPosition: string;
  cornerStyle: string;
  showQrOnBack: boolean;
  footerText: string;
  updatedAt: string | null;
};

export const getIdCardSettingsQueryKey = () => ["/api/idcard-settings"] as const;

export const useIdCardSettings = () =>
  useQuery<IdCardSettingsItem>({
    queryKey: getIdCardSettingsQueryKey(),
    queryFn: () => customFetch<IdCardSettingsItem>("/api/idcard-settings"),
  });

export const useUpdateIdCardSettings = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<IdCardSettingsItem>) =>
      customFetch<IdCardSettingsItem>("/api/idcard-settings", {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: getIdCardSettingsQueryKey() }),
  });
};

export const useEmailSalarySlip = () =>
  useMutation({
    mutationFn: ({ id, toEmail }: { id: number; toEmail?: string }) =>
      customFetch<{ ok: boolean; sentTo: string }>(`/api/salary-slips/${id}/email`, {
        method: "POST",
        body: JSON.stringify({ toEmail }),
      }),
  });

// ── Company Documents (Offer Letter / Experience Letter / Salary Slip theming) ──

export type DocumentType = "offer_letter" | "experience_letter" | "salary_slip" | "resignation_letter";

export type DocumentSettingsItem = {
  docType: DocumentType;
  primaryColor: string;
  accentColor: string;
  headingStyle: "serif" | "sans";
  showWatermark: boolean;
  footerTagline: string;
  logoOverride: string;
  updatedAt: string | null;
};

export const getDocumentSettingsQueryKey = (docType: DocumentType) => ["/api/document-settings", docType] as const;

export const useDocumentSettings = (docType: DocumentType) =>
  useQuery<DocumentSettingsItem>({
    queryKey: getDocumentSettingsQueryKey(docType),
    queryFn: () => customFetch<DocumentSettingsItem>(`/api/document-settings/${docType}`),
  });

export const useUpdateDocumentSettings = (docType: DocumentType) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<DocumentSettingsItem>) =>
      customFetch<DocumentSettingsItem>(`/api/document-settings/${docType}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: getDocumentSettingsQueryKey(docType) }),
  });
};

const _fetchPdfBlob = async (url: string, getToken: () => string | null): Promise<{ blob: Blob; filename: string }> => {
  const token = getToken();
  // Every caller (PDF preview/download across Employee Detail, Payroll,
  // Recruitment Documents, New Joinees, Settings, Salary Slip bulk) passes a
  // relative /api/... path, same as customFetch's own calls -this needs the
  // same origin prefix customFetch applies automatically, since a raw
  // fetch() here has no base-URL handling of its own.
  const response = await fetch(`${getApiOrigin()}${url}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error((err as any).error ?? "Failed to generate PDF");
  }
  const blob = await response.blob();
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const match = disposition.match(/filename="([^"]+)"/);
  return { blob, filename: match ? match[1] : "document.pdf" };
};

export const previewDocumentPdf = async (url: string, getToken: () => string | null) => {
  const sep = url.includes("?") ? "&" : "?";
  const { blob } = await _fetchPdfBlob(`${url}${sep}preview=1`, getToken);
  const objectUrl = URL.createObjectURL(blob);
  window.open(objectUrl, "_blank");
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
};

export const downloadDocumentPdf = async (url: string, getToken: () => string | null) => {
  const { blob, filename } = await _fetchPdfBlob(url, getToken);
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(objectUrl);
};

// ═══════════════════════════════════════════════════════════════════════════
//  ID Cards + QR Verification
// ═══════════════════════════════════════════════════════════════════════════

export type IdCardData = {
  id: number;
  code: string;
  name: string;
  designation?: string | null;
  department?: string | null;
  branchName?: string | null;
  branchCode?: string | null;
  unitCode?: string | null;
  employmentType?: string | null;
  photoUrl?: string | null;
  bloodGroup?: string | null;
  dateOfBirth?: string | null;
  emergencyContact?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  joinDate?: string | null;
  status: string;
  company: {
    name: string;
    address: string;
    logo?: string | null;
    signature?: string | null;
  };
  template?: {
    primaryColor: string;
    secondaryColor: string;
    textColor: string;
    fontFamily: string;
    backgroundStyle: string;
    logoPosition: string;
    cornerStyle: string;
    showQrOnBack: boolean;
    footerText: string;
  };
};

export const useIdCards = (ids: number[], enabled = true) =>
  useQuery<IdCardData[]>({
    queryKey: ["/api/idcard", ids.join(",")],
    queryFn: () => customFetch<IdCardData[]>(`/api/idcard?ids=${ids.join(",")}`),
    enabled: enabled && ids.length > 0,
  });

export const useEmailIdCard = () =>
  useMutation({
    mutationFn: (data: { employeeId: number; image?: string; toEmail?: string }) =>
      customFetch<{ ok: boolean; sentTo: string }>("/api/idcard/email", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });

export type VerifyEmployeeResult = {
  verified: boolean;
  status?: string;
  employee?: {
    code: string;
    name: string;
    designation?: string | null;
    department?: string | null;
    employmentType?: string | null;
    photoUrl?: string | null;
    bloodGroup?: string | null;
    joinDate?: string | null;
  };
  company: { name: string; address?: string; logo?: string | null };
};

export const useVerifyEmployee = (code: string) =>
  useQuery<VerifyEmployeeResult>({
    queryKey: ["/api/verify-employee", code],
    queryFn: () => customFetch<VerifyEmployeeResult>(`/api/verify-employee/${encodeURIComponent(code)}`),
    enabled: !!code,
    retry: false,
  });

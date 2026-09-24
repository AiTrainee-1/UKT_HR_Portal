// recruitment: hooks/types split out of the former single custom-hooks.ts (see ./index.ts).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryOptions } from "@tanstack/react-query";
import { customFetch, getApiOrigin } from "../custom-fetch";

// ── New Joinees ─────────────────────────────────────────────────────────

export type NewJoineeItem = {
  id: number;
  employeeCode: string;
  name: string;
  email: string | null;
  phone: string | null;
  department: string | null;
  designation: string | null;
  branchName: string | null;
  employmentType: string;
  joinDate: string | null;
  photoUrl: string | null;
};

export const getNewJoineesQueryKey = (days: number) => ["/api/recruitment/new-joinees", days] as const;

export const useListNewJoinees = (days: number = 30) =>
  useQuery<NewJoineeItem[]>({
    queryKey: getNewJoineesQueryKey(days),
    queryFn: () => customFetch<NewJoineeItem[]>(`/api/recruitment/new-joinees?days=${days}`),
  });

export const useSendOfferLetterEmail = () =>
  useMutation({
    mutationFn: ({ employeeId, toEmail }: { employeeId: number; toEmail?: string }) =>
      customFetch<{ ok: boolean; sentTo: string; pdfAttached: boolean }>(
        `/api/employees/${employeeId}/offer-letter/email`,
        {
          method: "POST",
          body: JSON.stringify({ toEmail }),
        },
      ),
  });

// ── Recruitment ───────────────────────────────────────────────────────────────

export type DeptAnalysisItem = {
  departmentId: number;
  departmentName: string;
  currentCount: number;
  requiredCount: number;
  vacancy: number;
};

export type RecentJoineeItem = {
  id: number;
  name: string;
  employeeCode: string;
  department?: string | null;
  designation?: string | null;
  joinDate?: string | null;
  photoUrl?: string | null;
};

export type RecentLeaveItem = {
  id: number;
  employeeName: string;
  employeeCode: string;
  department?: string | null;
  type: string;
  startDate: string;
  endDate: string;
  status: string;
};

export type RecruitmentDashboard = {
  totalStaffEmployees: number;
  totalDepartments: number;
  recentLeaves: number;
  newJoinees: number;
  openRoles: number;
  pendingResignations: number;
  positionsNeedingStaff: number;
  departmentAnalysis: DeptAnalysisItem[];
  recentJoineeList: RecentJoineeItem[];
  recentLeavesList: RecentLeaveItem[];
};

export type ResignationRequest = {
  id: number;
  employeeId: number;
  employeeName?: string | null;
  employeeCode?: string | null;
  departmentId?: number | null;
  departmentName?: string | null;
  reason?: string | null;
  lastWorkingDate?: string | null;
  surveyQ1Answer?: string | null;
  surveyQ2Answer?: string | null;
  surveyQ3Answer?: string | null;
  // Status flow: pending → dept_approved → approved | rejected
  status: "pending" | "dept_approved" | "approved" | "rejected";
  // Dept head stage
  deptHeadId?: number | null;
  deptHeadName?: string | null;
  deptHeadStatus?: "approved" | "rejected" | null;
  deptHeadComment?: string | null;
  deptHeadApprovedAt?: string | null;
  // HR stage
  hrComment?: string | null;
  approvedBy?: string | null;
  approvedAt?: string | null;
  rejectedBy?: "dept_head" | "hr" | null;
  createdAt?: string | null;
};

export type DepartmentHeadcountItem = {
  id?: number | null;
  departmentId: number;
  departmentName: string;
  currentCount: number;
  requiredCount: number;
  vacancy: number;
  notes?: string | null;
};

export const getRecruitmentDashboardQueryKey = () => ["/api/recruitment/dashboard"] as const;

export const useGetRecruitmentDashboard = (options?: UseQueryOptions<RecruitmentDashboard>) =>
  useQuery<RecruitmentDashboard>({
    queryKey: getRecruitmentDashboardQueryKey(),
    queryFn: () => customFetch<RecruitmentDashboard>("/api/recruitment/dashboard"),
    ...options,
  });

export const getListResignationsQueryKey = (status?: string) => ["/api/recruitment/resignations", status] as const;

export const useListResignations = (statusFilter?: string, options?: UseQueryOptions<ResignationRequest[]>) => {
  const qs = statusFilter ? `?status=${statusFilter}` : "";
  return useQuery<ResignationRequest[]>({
    queryKey: getListResignationsQueryKey(statusFilter),
    queryFn: () => customFetch<ResignationRequest[]>(`/api/recruitment/resignations${qs}`),
    ...options,
  });
};

export const useSubmitResignation = () =>
  useMutation({
    mutationFn: (data: {
      reason?: string;
      lastWorkingDate?: string;
      surveyQ1Answer?: string;
      surveyQ2Answer?: string;
      surveyQ3Answer?: string;
    }) =>
      customFetch<ResignationRequest>("/api/recruitment/resignations", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });

export const useResignationAction = () =>
  useMutation({
    mutationFn: ({ id, action, hrComment }: { id: number; action: "approve" | "reject"; hrComment?: string }) =>
      customFetch<ResignationRequest>(`/api/recruitment/resignations/${id}/action`, {
        method: "PATCH",
        body: JSON.stringify({ action, hrComment }),
      }),
  });

export const getMyResignationQueryKey = () => ["/api/my/resignation"] as const;

export const useMyResignation = (options?: UseQueryOptions<ResignationRequest | null>) =>
  useQuery<ResignationRequest | null>({
    queryKey: getMyResignationQueryKey(),
    queryFn: () => customFetch<ResignationRequest | null>("/api/my/resignation"),
    ...options,
  });

export const getListDepartmentHeadcountQueryKey = () => ["/api/recruitment/department-headcount"] as const;

export const useListDepartmentHeadcount = (options?: UseQueryOptions<DepartmentHeadcountItem[]>) =>
  useQuery<DepartmentHeadcountItem[]>({
    queryKey: getListDepartmentHeadcountQueryKey(),
    queryFn: () => customFetch<DepartmentHeadcountItem[]>("/api/recruitment/department-headcount"),
    ...options,
  });

export const useSetDepartmentHeadcount = () =>
  useMutation({
    mutationFn: (data: { departmentId: number; requiredCount: number; notes?: string }) =>
      customFetch<DepartmentHeadcountItem>("/api/recruitment/department-headcount", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });

export const useUpdateDepartmentHeadcount = () =>
  useMutation({
    mutationFn: ({ id, data }: { id: number; data: { requiredCount?: number; notes?: string } }) =>
      customFetch<DepartmentHeadcountItem>(`/api/recruitment/department-headcount/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
  });

// ── Resume Screening (ATS) ──────────────────────────────────────────────────

export type HiringRuleSetItem = {
  id: number;
  name: string;
  departmentId: number;
  departmentName: string | null;
  requiredSkills: string[];
  softSkills: string[];
  educationQualification: string | null;
  minExperienceYears: number;
  preferredCity: string | null;
  otherRequirements: string | null;
  isActive: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

export type ScreeningCandidateStatus =
  "uploaded" | "screened" | "shortlisted" | "not_shortlisted" | "selected" | "rejected";

export const EDUCATION_LEVEL_OPTIONS = [
  "10th",
  "12th",
  "Diploma",
  "B.E.",
  "B.Tech",
  "UG",
  "PG",
  "More than 10th",
  "More than 12th",
  "More than Diploma",
  "More than B.E.",
  "More than B.Sc.",
  "More than B.Tech.",
  "More than M.Sc.",
] as const;

export type ScoreBreakdown = {
  total: number;
  components: {
    skills: { score: number; weight: number; matched: string[]; missing: string[] };
    softSkills: { score: number; weight: number; matched: string[]; missing: string[] };
    similarity: { score: number; weight: number; rawCosine?: number; raw_cosine?: number };
    experience: { score: number; weight: number; required: number; extracted: number | null };
    education: { score: number; weight: number; required: string | null; extracted: string | null; meets: boolean };
    location: { score: number; weight: number; preferred: string | null; extracted: string | null; meets: boolean };
  };
};

export type ScreeningCandidateItem = {
  id: number;
  ruleSetId: number;
  ruleSetName: string | null;
  departmentId: number | null;
  departmentName: string | null;
  originalFilename: string;
  hasResume: boolean;
  source: "single" | "bulk";
  candidateName: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  extractedSkills: string[];
  extractedSoftSkills: string[];
  extractedExperienceYears: number | null;
  extractedEducation: string | null;
  matchScore: number | null;
  scoreBreakdown: ScoreBreakdown | null;
  rankInBatch: number | null;
  status: ScreeningCandidateStatus;
  screenedAt: string | null;
  interviewInvitedAt: string | null;
  interviewDatetime: string | null;
  rejectionEmailedAt: string | null;
  notes: string | null;
  createdAt: string | null;
  resumeUrl: string;
};

const RESUME_SCREENING_BASE = "/api/recruitment/resume-screening";

export const getListHiringRuleSetsQueryKey = (params?: { departmentId?: number; isActive?: boolean }) =>
  [`${RESUME_SCREENING_BASE}/rule-sets`, params] as const;

export const useListHiringRuleSets = (
  params?: { departmentId?: number; isActive?: boolean },
  options?: UseQueryOptions<HiringRuleSetItem[]>,
) => {
  const qs = new URLSearchParams();
  if (params?.departmentId) qs.set("departmentId", String(params.departmentId));
  if (params?.isActive !== undefined) qs.set("isActive", String(params.isActive));
  const q = qs.toString();
  return useQuery<HiringRuleSetItem[]>({
    queryKey: getListHiringRuleSetsQueryKey(params),
    queryFn: () => customFetch<HiringRuleSetItem[]>(`${RESUME_SCREENING_BASE}/rule-sets${q ? `?${q}` : ""}`),
    ...options,
  });
};

export type HiringRuleSetInput = {
  name: string;
  departmentId: number;
  requiredSkills: string[];
  softSkills?: string[];
  educationQualification?: string;
  minExperienceYears?: number;
  preferredCity?: string;
  otherRequirements?: string;
  isActive?: boolean;
};

export const useCreateHiringRuleSet = () =>
  useMutation({
    mutationFn: (data: HiringRuleSetInput) =>
      customFetch<HiringRuleSetItem>(`${RESUME_SCREENING_BASE}/rule-sets`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });

export const useUpdateHiringRuleSet = () =>
  useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<HiringRuleSetInput> }) =>
      customFetch<HiringRuleSetItem>(`${RESUME_SCREENING_BASE}/rule-sets/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
  });

export const useDeleteHiringRuleSet = () =>
  useMutation({
    mutationFn: (id: number) =>
      customFetch<{ ok: boolean }>(`${RESUME_SCREENING_BASE}/rule-sets/${id}`, { method: "DELETE" }),
  });

export const useUploadSingleResume = () =>
  useMutation({
    mutationFn: ({ file, ruleSetId }: { file: File; ruleSetId: number }) => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("ruleSetId", String(ruleSetId));
      return customFetch<ScreeningCandidateItem>(`${RESUME_SCREENING_BASE}/upload-single`, {
        method: "POST",
        body: formData,
      });
    },
  });

export const useShortlistCandidate = () =>
  useMutation({
    mutationFn: (id: number) =>
      customFetch<ScreeningCandidateItem>(`${RESUME_SCREENING_BASE}/candidates/${id}/shortlist`, {
        method: "POST",
      }),
  });

export const getListScreeningCandidatesQueryKey = (params?: {
  status?: ScreeningCandidateStatus;
  ruleSetId?: number;
  departmentId?: number;
  search?: string;
}) => [`${RESUME_SCREENING_BASE}/candidates`, params] as const;

export const useListScreeningCandidates = (
  params?: { status?: ScreeningCandidateStatus; ruleSetId?: number; departmentId?: number; search?: string },
  options?: UseQueryOptions<ScreeningCandidateItem[]>,
) => {
  const qs = new URLSearchParams();
  if (params?.status) qs.set("status", params.status);
  if (params?.ruleSetId) qs.set("ruleSetId", String(params.ruleSetId));
  if (params?.departmentId) qs.set("departmentId", String(params.departmentId));
  if (params?.search) qs.set("search", params.search);
  const q = qs.toString();
  return useQuery<ScreeningCandidateItem[]>({
    queryKey: getListScreeningCandidatesQueryKey(params),
    queryFn: () => customFetch<ScreeningCandidateItem[]>(`${RESUME_SCREENING_BASE}/candidates${q ? `?${q}` : ""}`),
    ...options,
  });
};

export const useUpdateCandidateStatus = () =>
  useMutation({
    mutationFn: ({ id, data }: { id: number; data: { status?: ScreeningCandidateStatus; notes?: string } }) =>
      customFetch<ScreeningCandidateItem>(`${RESUME_SCREENING_BASE}/candidates/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
  });

export const useDeleteScreeningCandidate = () =>
  useMutation({
    mutationFn: (id: number) =>
      customFetch<{ ok: boolean }>(`${RESUME_SCREENING_BASE}/candidates/${id}`, { method: "DELETE" }),
  });

export const useSendRejectionEmailsAll = () =>
  useMutation({
    mutationFn: () =>
      customFetch<{ sent: number; failed: { candidateId: number; name: string | null; error: string }[] }>(
        `${RESUME_SCREENING_BASE}/candidates/reject-email-all`,
        { method: "POST" },
      ),
  });

export const useSendInterviewInvite = () =>
  useMutation({
    mutationFn: ({ id, interviewDateTime }: { id: number; interviewDateTime: string }) =>
      customFetch<ScreeningCandidateItem>(`${RESUME_SCREENING_BASE}/candidates/${id}/interview-invite`, {
        method: "POST",
        body: JSON.stringify({ interviewDateTime }),
      }),
  });

export const useSendInterviewInviteBulk = () =>
  useMutation({
    mutationFn: (interviewDateTime: string) =>
      customFetch<{ sent: number; failed: { candidateId: number; name: string | null; error: string }[] }>(
        `${RESUME_SCREENING_BASE}/candidates/interview-invite-bulk`,
        { method: "POST", body: JSON.stringify({ interviewDateTime }) },
      ),
  });

// ── Resume Screening bulk upload progress ───────────────────────────────────

export type ResumeScreeningProgress = {
  stage: "idle" | "running" | "completed";
  total: number;
  completed: number;
  screened: number;
  failed: number;
  currentFile: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

export const useResumeScreeningProgress = (enabled: boolean) =>
  useQuery<ResumeScreeningProgress>({
    queryKey: [`${RESUME_SCREENING_BASE}/upload-bulk-progress`],
    queryFn: () => customFetch<ResumeScreeningProgress>(`${RESUME_SCREENING_BASE}/upload-bulk-progress`),
    enabled,
    refetchInterval: enabled ? 600 : false,
    staleTime: 0,
  });

export const useResignationEmail = () =>
  useMutation({
    mutationFn: ({ id, toEmail }: { id: number; toEmail?: string }) =>
      customFetch<{ ok: boolean; sentTo: string; pdfAttached: boolean }>(`/api/recruitment/resignations/${id}/email`, {
        method: "POST",
        body: JSON.stringify({ toEmail }),
      }),
  });

// ── Employee Documents ──────────────────────────────────────────────────────

export type EmployeeDocumentCategory =
  | "pan_card"
  | "aadhaar_card"
  | "educational_certificate"
  | "voter_id_or_birth_certificate"
  | "bank_passbook"
  | "offer_letter"
  | "experience_letter"
  | "resignation_letter"
  | "staff_letter"
  | "production_employee_documents";

export const EMPLOYEE_DOCUMENT_CATEGORIES: { value: EmployeeDocumentCategory; label: string }[] = [
  { value: "pan_card", label: "PAN Card" },
  { value: "aadhaar_card", label: "Aadhaar Card" },
  { value: "educational_certificate", label: "Educational Certificates" },
  { value: "voter_id_or_birth_certificate", label: "Voter ID or Birth Certificate" },
  { value: "bank_passbook", label: "Bank Passbook" },
  { value: "offer_letter", label: "Offer Letter" },
  { value: "experience_letter", label: "Experience Letter" },
  { value: "resignation_letter", label: "Resignation Letter" },
  { value: "staff_letter", label: "Staff Letter" },
  { value: "production_employee_documents", label: "Production Employee Documents" },
];

export type EmployeeDocumentItem = {
  id: number;
  employeeId: number;
  category: EmployeeDocumentCategory;
  categoryLabel: string;
  originalFilename: string;
  uploadedBy: string | null;
  uploadedAt: string | null;
  fileUrl: string;
};

export const getEmployeeDocumentsQueryKey = (employeeId: number | null) =>
  ["/api/recruitment/employee-documents", employeeId] as const;

export const useEmployeeDocuments = (employeeId: number | null, enabled = true) =>
  useQuery<EmployeeDocumentItem[]>({
    queryKey: getEmployeeDocumentsQueryKey(employeeId),
    queryFn: () => customFetch<EmployeeDocumentItem[]>(`/api/recruitment/employee-documents/${employeeId}`),
    enabled: enabled && !!employeeId,
  });

export const useUploadEmployeeDocument = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      employeeId,
      category,
      file,
    }: {
      employeeId: number;
      category: EmployeeDocumentCategory;
      file: File;
    }) => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("category", category);
      return customFetch<EmployeeDocumentItem>(`/api/recruitment/employee-documents/${employeeId}/upload`, {
        method: "POST",
        body: formData,
      });
    },
    onSuccess: (_data, { employeeId }) =>
      queryClient.invalidateQueries({ queryKey: getEmployeeDocumentsQueryKey(employeeId) }),
  });
};

export const useDeleteEmployeeDocument = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => customFetch<{ ok: boolean }>(`/api/employee-documents/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/recruitment/employee-documents"] }),
  });
};

export type DocumentCompletionEmployee = {
  id: number;
  employeeCode: string;
  name: string;
  departmentName: string | null;
};

export type DocumentCompletionStats = {
  totalCount: number;
  uploadedCount: number;
  pendingCount: number;
  uploadedEmployees: DocumentCompletionEmployee[];
  pendingEmployees: (DocumentCompletionEmployee & {
    missingCategories: { value: EmployeeDocumentCategory; label: string }[];
  })[];
};

export const getDocumentCompletionStatsQueryKey = (employmentType: "staff" | "production") =>
  ["/api/recruitment/employee-documents/completion-stats", employmentType] as const;

export const useDocumentCompletionStats = (employmentType: "staff" | "production", enabled = true) =>
  useQuery<DocumentCompletionStats>({
    queryKey: getDocumentCompletionStatsQueryKey(employmentType),
    queryFn: () =>
      customFetch<DocumentCompletionStats>(
        `/api/recruitment/employee-documents/completion-stats?employmentType=${employmentType}`,
      ),
    enabled,
  });

export const useDeleteResignation = () =>
  useMutation({
    mutationFn: (id: number) => customFetch<void>(`/api/recruitment/resignations/${id}/delete`, { method: "DELETE" }),
  });

export const downloadResignationPdf = async (id: number, getToken: () => string | null) => {
  const token = getToken();
  const response = await fetch(`${getApiOrigin()}/api/recruitment/resignations/${id}/pdf`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error((err as any).error ?? "Failed to download PDF");
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const match = disposition.match(/filename="([^"]+)"/);
  a.download = match ? match[1] : `resignation_${id}.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

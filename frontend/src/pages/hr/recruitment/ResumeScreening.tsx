import { useRef, useState } from "react";
import HrLayout from "@/components/HrLayout";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@/lib/api-client/custom-fetch";
import { useResumeScreening } from "@/contexts/ResumeScreeningContext";
import ResumeScreeningPipeline from "@/components/ResumeScreeningPipeline";
import {
  useListDepartments,
  useListHiringRuleSets, useCreateHiringRuleSet, useUpdateHiringRuleSet, useDeleteHiringRuleSet,
  useUploadSingleResume, useShortlistCandidate,
  useListScreeningCandidates, useUpdateCandidateStatus, useDeleteScreeningCandidate,
  useSendRejectionEmailsAll, useSendInterviewInvite, useSendInterviewInviteBulk,
  getListHiringRuleSetsQueryKey, getListScreeningCandidatesQueryKey,
  EDUCATION_LEVEL_OPTIONS,
  type HiringRuleSetItem, type ScreeningCandidateItem, type ScreeningCandidateStatus,
} from "@/lib/api-client";
import {
  UserSearch, FileText, Files, ClipboardList, Plus, Trash2, Edit, X,
  UploadCloud, CheckCircle2, XCircle, Mail, CalendarClock, Star,
  Briefcase, GraduationCap, MapPin, Phone, AtSign, Loader2, ArrowUpRight,
  Info, HeartHandshake,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
//  Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

function describeFailures(failed: { name: string | null; error: string }[]): string | undefined {
  if (failed.length === 0) return undefined;
  const first = failed[0];
  const firstLine = `${first.name ?? "One candidate"}: ${first.error}`;
  return failed.length === 1 ? firstLine : `${firstLine} (and ${failed.length - 1} more)`;
}

async function openResume(candidateId: number, onError?: (message: string) => void) {
  try {
    const blob = await customFetch<Blob>(
      `/api/recruitment/resume-screening/candidates/${candidateId}/resume`,
      { responseType: "blob" },
    );
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (err) {
    onError?.(err instanceof Error ? err.message : "Could not open this resume");
  }
}

function ScoreBadge({ score }: { score: number | null }) {
  if (score == null) return null;
  const tone = score >= 75 ? "bg-emerald-100 text-emerald-700" : score >= 50 ? "bg-amber-100 text-amber-700" : "bg-rose-100 text-rose-700";
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full ${tone}`}>
      <Star size={11} /> {score.toFixed(0)}/100
    </span>
  );
}

function ScoreBreakdownBars({ breakdown }: { breakdown: ScreeningCandidateItem["scoreBreakdown"] }) {
  if (!breakdown) return null;
  const rows: { label: string; score: number; weight: number; icon: React.ReactNode }[] = [
    { label: "Skills Match", score: breakdown.components.skills.score, weight: breakdown.components.skills.weight, icon: <Briefcase size={12} /> },
    { label: "Soft Skills", score: breakdown.components.softSkills.score, weight: breakdown.components.softSkills.weight, icon: <HeartHandshake size={12} /> },
    { label: "Overall Fit", score: breakdown.components.similarity.score, weight: breakdown.components.similarity.weight, icon: <ClipboardList size={12} /> },
    { label: "Experience", score: breakdown.components.experience.score, weight: breakdown.components.experience.weight, icon: <Briefcase size={12} /> },
    { label: "Education", score: breakdown.components.education.score, weight: breakdown.components.education.weight, icon: <GraduationCap size={12} /> },
    { label: "Location", score: breakdown.components.location.score, weight: breakdown.components.location.weight, icon: <MapPin size={12} /> },
  ];
  return (
    <div className="space-y-2">
      {rows.map(r => (
        <div key={r.label}>
          <div className="flex items-center justify-between text-[11px] text-gray-500 mb-0.5">
            <span className="flex items-center gap-1">{r.icon} {r.label}</span>
            <span>{r.score.toFixed(1)} / {r.weight}</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-gray-100 overflow-hidden">
            <div
              className="h-full rounded-full bg-gradient-to-r from-violet-400 to-fuchsia-500"
              style={{ width: `${Math.min(100, (r.score / r.weight) * 100)}%` }}
            />
          </div>
        </div>
      ))}
      {breakdown.components.skills.missing.length > 0 && (
        <p className="text-[11px] text-gray-400 pt-1">
          Missing skills: {breakdown.components.skills.missing.join(", ")}
        </p>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Why was this candidate shortlisted/rejected? (Overview / Reason dialog)
// ─────────────────────────────────────────────────────────────────────────────

function buildReasonNarrative(candidate: ScreeningCandidateItem): string[] {
  const b = candidate.scoreBreakdown;
  if (!b) return ["This candidate hasn't been scored yet."];
  const lines: string[] = [];

  const fitLabel = b.total >= 75 ? "a strong match" : b.total >= 50 ? "a moderate match" : "a weak match";
  lines.push(`Overall match score: ${b.total.toFixed(0)}/100 — ${fitLabel} for this rule set.`);

  const sk = b.components.skills;
  const totalSkills = sk.matched.length + sk.missing.length;
  if (totalSkills > 0) {
    lines.push(
      sk.missing.length === 0
        ? `Required skills: matched all ${sk.matched.length} required skill(s) — ${sk.matched.join(", ")}.`
        : `Required skills: matched ${sk.matched.length} of ${totalSkills} (${sk.matched.join(", ") || "none"}). Missing: ${sk.missing.join(", ")}.`
    );
  }

  const soft = b.components.softSkills;
  const totalSoft = soft.matched.length + soft.missing.length;
  if (totalSoft > 0) {
    lines.push(
      soft.matched.length > 0
        ? `Soft skills: found ${soft.matched.join(", ")} mentioned in the resume.`
        : `Soft skills: none of the configured soft skills (${soft.missing.join(", ")}) were found in the resume.`
    );
  }

  const exp = b.components.experience;
  if (exp.extracted == null) {
    lines.push(`Experience: could not detect years of experience from the resume${exp.required > 0 ? ` (required: ${exp.required}+ years).` : "."}`);
  } else if (exp.required <= 0) {
    lines.push(`Experience: candidate has ${exp.extracted} year(s) — no minimum was required for this rule set.`);
  } else if (exp.extracted >= exp.required) {
    lines.push(`Experience: candidate has ${exp.extracted} year(s), meeting or exceeding the required ${exp.required}+ years.`);
  } else {
    lines.push(`Experience: candidate has ${exp.extracted} year(s), below the required ${exp.required}+ years.`);
  }

  const edu = b.components.education;
  if (edu.required) {
    lines.push(
      edu.meets
        ? `Education: candidate's qualification${edu.extracted ? ` (${edu.extracted})` : ""} meets the required "${edu.required}".`
        : `Education: candidate's qualification${edu.extracted ? ` (${edu.extracted})` : " could not be detected"} does not clearly meet the required "${edu.required}".`
    );
  }

  const loc = b.components.location;
  if (loc.preferred) {
    lines.push(
      loc.meets
        ? `Location: candidate is based in ${loc.extracted ?? "a matching city"}, matching the preferred city (${loc.preferred}).`
        : `Location: candidate's city${loc.extracted ? ` (${loc.extracted})` : " could not be detected"} does not match the preferred city (${loc.preferred}).`
    );
  }

  if (candidate.status === "shortlisted") {
    lines.push(
      candidate.rankInBatch != null
        ? `Shortlisted: ranked #${candidate.rankInBatch} by match score in this batch, within the requested shortlist size.`
        : "Shortlisted: added to the shortlist."
    );
  } else if (candidate.status === "not_shortlisted") {
    lines.push(
      candidate.rankInBatch != null
        ? `Not shortlisted: ranked #${candidate.rankInBatch} by match score — outside the requested shortlist size for this batch.`
        : "Not shortlisted."
    );
  } else if (candidate.status === "selected") {
    lines.push("Selected: HR has moved this candidate forward for an interview.");
  } else if (candidate.status === "rejected") {
    lines.push("Rejected: HR has marked this candidate as not proceeding further.");
  }

  return lines;
}

function CandidateReasonDialog({ candidate, onClose }: { candidate: ScreeningCandidateItem; onClose: () => void }) {
  const lines = buildReasonNarrative(candidate);
  const statusLabel = candidate.status.replace("_", " ");
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto scrollbar-hide">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Info size={16} className="text-violet-600" />
            Why {candidate.candidateName ?? "this candidate"} is {statusLabel}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="flex items-center justify-between">
            <ScoreBadge score={candidate.matchScore} />
            <Badge variant="outline" className="capitalize text-[10px]">{statusLabel}</Badge>
          </div>
          <ScoreBreakdownBars breakdown={candidate.scoreBreakdown} />
          <div className="rounded-lg bg-gray-50 border p-3 space-y-1.5">
            {lines.map((line, i) => (
              <p key={i} className="text-xs text-gray-600 leading-relaxed">{line}</p>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Company Rules & Expectations tab
// ─────────────────────────────────────────────────────────────────────────────

function RuleSetDialog({ ruleSet, onClose }: { ruleSet: HiringRuleSetItem | null; onClose: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: departments } = useListDepartments();
  const createMutation = useCreateHiringRuleSet();
  const updateMutation = useUpdateHiringRuleSet();

  const [name, setName] = useState(ruleSet?.name ?? "");
  const [departmentId, setDepartmentId] = useState<string>(ruleSet ? String(ruleSet.departmentId) : "");
  const [skills, setSkills] = useState<string[]>(ruleSet?.requiredSkills ?? []);
  const [skillInput, setSkillInput] = useState("");
  const [softSkills, setSoftSkills] = useState<string[]>(ruleSet?.softSkills ?? []);
  const [softSkillInput, setSoftSkillInput] = useState("");
  const [education, setEducation] = useState(ruleSet?.educationQualification ?? "");
  const [minExperience, setMinExperience] = useState(String(ruleSet?.minExperienceYears ?? 0));
  const [preferredCity, setPreferredCity] = useState(ruleSet?.preferredCity ?? "");
  const [otherRequirements, setOtherRequirements] = useState(ruleSet?.otherRequirements ?? "");

  const addSkill = () => {
    const trimmed = skillInput.trim();
    if (trimmed && !skills.includes(trimmed)) setSkills([...skills, trimmed]);
    setSkillInput("");
  };

  const addSoftSkill = () => {
    const trimmed = softSkillInput.trim();
    if (trimmed && !softSkills.includes(trimmed)) setSoftSkills([...softSkills, trimmed]);
    setSoftSkillInput("");
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  const handleSave = async () => {
    if (!name.trim() || !departmentId) {
      toast({ title: "Name and Department are required", variant: "destructive" });
      return;
    }
    const data = {
      name: name.trim(),
      departmentId: Number(departmentId),
      requiredSkills: skills,
      softSkills,
      educationQualification: education || undefined,
      minExperienceYears: Number(minExperience) || 0,
      preferredCity: preferredCity || undefined,
      otherRequirements: otherRequirements || undefined,
    };
    try {
      if (ruleSet) {
        await updateMutation.mutateAsync({ id: ruleSet.id, data });
        toast({ title: "Rule set updated" });
      } else {
        await createMutation.mutateAsync(data);
        toast({ title: "Rule set created" });
      }
      queryClient.invalidateQueries({ queryKey: getListHiringRuleSetsQueryKey() });
      onClose();
    } catch (err) {
      toast({ title: "Failed to save rule set", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto scrollbar-hide">
        <DialogHeader>
          <DialogTitle>{ruleSet ? "Edit Rule Set" : "New Hiring Rule Set"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label className="text-xs">Rule Set Name</Label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Stitching Operator — Unit 1" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Department</Label>
            <Select value={departmentId} onValueChange={setDepartmentId}>
              <SelectTrigger><SelectValue placeholder="Select department" /></SelectTrigger>
              <SelectContent>
                {(departments ?? []).map(d => (
                  <SelectItem key={d.id} value={String(d.id)}>{d.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Required Skills</Label>
            <div className="flex gap-2">
              <Input
                value={skillInput} onChange={e => setSkillInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addSkill(); } }}
                placeholder="Type a skill and press Enter"
              />
              <Button type="button" variant="outline" onClick={addSkill}><Plus size={14} /></Button>
            </div>
            {skills.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {skills.map(s => (
                  <Badge key={s} variant="secondary" className="gap-1">
                    {s}
                    <button onClick={() => setSkills(skills.filter(x => x !== s))}><X size={11} /></button>
                  </Badge>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs flex items-center gap-1"><HeartHandshake size={12} /> Soft Skills</Label>
            <div className="flex gap-2">
              <Input
                value={softSkillInput} onChange={e => setSoftSkillInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addSoftSkill(); } }}
                placeholder="e.g. Communication, Teamwork — press Enter"
              />
              <Button type="button" variant="outline" onClick={addSoftSkill}><Plus size={14} /></Button>
            </div>
            {softSkills.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {softSkills.map(s => (
                  <Badge key={s} variant="secondary" className="gap-1 bg-violet-50 text-violet-700 border-violet-100">
                    {s}
                    <button onClick={() => setSoftSkills(softSkills.filter(x => x !== s))}><X size={11} /></button>
                  </Badge>
                ))}
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Min. Experience (years)</Label>
              <Input type="number" min={0} step={0.5} value={minExperience} onChange={e => setMinExperience(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Preferred City</Label>
              <Input value={preferredCity} onChange={e => setPreferredCity(e.target.value)} placeholder="e.g. Tirupur" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Educational Qualification</Label>
            <Select value={education} onValueChange={setEducation}>
              <SelectTrigger><SelectValue placeholder="Select minimum qualification" /></SelectTrigger>
              <SelectContent>
                {EDUCATION_LEVEL_OPTIONS.map(opt => (
                  <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Other Requirements</Label>
            <Textarea value={otherRequirements} onChange={e => setOtherRequirements(e.target.value)} rows={3} placeholder="Any other hiring requirements..." />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={isPending}>{isPending ? "Saving…" : "Save Rule Set"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RulesTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: ruleSets, isLoading } = useListHiringRuleSets();
  const deleteMutation = useDeleteHiringRuleSet();
  const updateMutation = useUpdateHiringRuleSet();
  const [editing, setEditing] = useState<HiringRuleSetItem | null | undefined>(undefined);

  const handleDelete = async (rs: HiringRuleSetItem) => {
    if (!confirm(`Delete "${rs.name}"? This can't be undone.`)) return;
    try {
      await deleteMutation.mutateAsync(rs.id);
      toast({ title: "Rule set deleted" });
      queryClient.invalidateQueries({ queryKey: getListHiringRuleSetsQueryKey() });
    } catch (err) {
      toast({
        title: "Couldn't delete this rule set",
        description: err instanceof Error ? err.message : "It may already have screened candidates — try deactivating instead.",
        variant: "destructive",
      });
    }
  };

  const toggleActive = async (rs: HiringRuleSetItem) => {
    await updateMutation.mutateAsync({ id: rs.id, data: { isActive: !rs.isActive } });
    queryClient.invalidateQueries({ queryKey: getListHiringRuleSetsQueryKey() });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Configure per-department hiring criteria. Pick one of these when screening resumes.
        </p>
        <Button size="sm" className="gap-1.5" onClick={() => setEditing(null)}>
          <Plus size={14} /> New Rule Set
        </Button>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {!isLoading && (ruleSets ?? []).length === 0 && (
        <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">
          No hiring rule sets yet. Create one to start screening resumes.
        </CardContent></Card>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {(ruleSets ?? []).map(rs => (
          <Card key={rs.id} className={!rs.isActive ? "opacity-60" : ""}>
            <CardContent className="p-4 space-y-2">
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-bold text-sm">{rs.name}</p>
                  <p className="text-xs text-muted-foreground">{rs.departmentName}</p>
                </div>
                <div className="flex items-center gap-1">
                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditing(rs)}><Edit size={13} /></Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7 text-red-500" onClick={() => handleDelete(rs)}><Trash2 size={13} /></Button>
                </div>
              </div>
              {rs.requiredSkills.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {rs.requiredSkills.slice(0, 5).map(s => <Badge key={s} variant="outline" className="text-[10px]">{s}</Badge>)}
                  {rs.requiredSkills.length > 5 && <Badge variant="outline" className="text-[10px]">+{rs.requiredSkills.length - 5} more</Badge>}
                </div>
              )}
              {rs.softSkills.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {rs.softSkills.slice(0, 5).map(s => (
                    <Badge key={s} variant="outline" className="text-[10px] bg-violet-50 text-violet-700 border-violet-100">{s}</Badge>
                  ))}
                  {rs.softSkills.length > 5 && <Badge variant="outline" className="text-[10px]">+{rs.softSkills.length - 5} more</Badge>}
                </div>
              )}
              <div className="text-xs text-muted-foreground space-y-0.5">
                {rs.minExperienceYears > 0 && <p>Min. experience: {rs.minExperienceYears} yrs</p>}
                {rs.educationQualification && <p>Education: {rs.educationQualification}</p>}
                {rs.preferredCity && <p>Preferred city: {rs.preferredCity}</p>}
              </div>
              <button
                onClick={() => toggleActive(rs)}
                className={`text-[11px] font-semibold ${rs.isActive ? "text-emerald-600" : "text-gray-400"}`}
              >
                {rs.isActive ? "● Active — click to deactivate" : "○ Inactive — click to reactivate"}
              </button>
            </CardContent>
          </Card>
        ))}
      </div>

      {editing !== undefined && <RuleSetDialog ruleSet={editing} onClose={() => setEditing(undefined)} />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Upload Resume (single) tab
// ─────────────────────────────────────────────────────────────────────────────

function UploadResumeTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: ruleSets } = useListHiringRuleSets({ isActive: true });
  const uploadMutation = useUploadSingleResume();
  const shortlistMutation = useShortlistCandidate();
  const [file, setFile] = useState<File | null>(null);
  const [ruleSetId, setRuleSetId] = useState("");
  const [result, setResult] = useState<ScreeningCandidateItem | null>(null);
  const [showReason, setShowReason] = useState(false);

  const handleScreen = async () => {
    if (!file || !ruleSetId) {
      toast({ title: "Choose a resume file and a rule set first", variant: "destructive" });
      return;
    }
    try {
      const candidate = await uploadMutation.mutateAsync({ file, ruleSetId: Number(ruleSetId) });
      setResult(candidate);
    } catch (err) {
      toast({ title: "Screening failed", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    }
  };

  const handleShortlist = async () => {
    if (!result) return;
    await shortlistMutation.mutateAsync(result.id);
    toast({ title: `${result.candidateName ?? "Candidate"} added to Shortlisted` });
    queryClient.invalidateQueries({ predicate: q => typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith("/api/recruitment/resume-screening/candidates") });
    setResult(null);
    setFile(null);
    setRuleSetId("");
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle className="text-base">Screen a Single Resume</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs">Resume File (.pdf or .docx)</Label>
            <Input type="file" accept=".pdf,.docx" onChange={e => setFile(e.target.files?.[0] ?? null)} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Hiring Rule Set</Label>
            <Select value={ruleSetId} onValueChange={setRuleSetId}>
              <SelectTrigger><SelectValue placeholder="Select rule set" /></SelectTrigger>
              <SelectContent>
                {(ruleSets ?? []).map(rs => (
                  <SelectItem key={rs.id} value={String(rs.id)}>{rs.name} — {rs.departmentName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button className="w-full gap-1.5" disabled={uploadMutation.isPending} onClick={handleScreen}>
            {uploadMutation.isPending ? <><Loader2 size={14} className="animate-spin" /> Screening…</> : <><UserSearch size={14} /> Screen Resume</>}
          </Button>
        </CardContent>
      </Card>

      {result ? (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">{result.candidateName ?? result.originalFilename}</CardTitle>
            <ScoreBadge score={result.matchScore} />
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="text-xs text-muted-foreground space-y-1">
              {result.email && <p className="flex items-center gap-1.5"><AtSign size={12} /> {result.email}</p>}
              {result.phone && <p className="flex items-center gap-1.5"><Phone size={12} /> {result.phone}</p>}
              {result.city && <p className="flex items-center gap-1.5"><MapPin size={12} /> {result.city}</p>}
            </div>
            <ScoreBreakdownBars breakdown={result.scoreBreakdown} />
            <div className="flex gap-2 flex-wrap">
              <Button
                variant="outline" size="sm" className="gap-1.5"
                onClick={() => openResume(result.id, msg => toast({ title: "Couldn't open resume", description: msg, variant: "destructive" }))}
              >
                <FileText size={13} /> View Resume
              </Button>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setShowReason(true)}>
                <Info size={13} /> Reason
              </Button>
              <Button size="sm" className="gap-1.5 ml-auto" onClick={handleShortlist} disabled={shortlistMutation.isPending}>
                <CheckCircle2 size={13} /> Add to Shortlist
              </Button>
            </div>
          </CardContent>
          {showReason && <CandidateReasonDialog candidate={result} onClose={() => setShowReason(false)} />}
        </Card>
      ) : (
        <HowItWorksCard />
      )}
    </div>
  );
}

function HowItWorksCard() {
  const steps: { title: string; description: string; icon: React.ReactNode }[] = [
    {
      title: "1. Upload a resume",
      description: "Choose a .pdf or .docx resume file and pick the hiring rule set to screen it against.",
      icon: <UploadCloud size={16} />,
    },
    {
      title: "2. The system reads and scores it",
      description: "Name, email, phone, city, skills, education and experience are extracted automatically, then compared against the rule set's requirements — matched skills, education level, experience years, and location are each scored and combined into one overall match score.",
      icon: <UserSearch size={16} />,
    },
    {
      title: "3. Review the breakdown",
      description: "Every score comes with a full breakdown — click \"Reason\" on any candidate at any time to see exactly what matched, what's missing, and why they were shortlisted, selected, or rejected.",
      icon: <Info size={16} />,
    },
    {
      title: "4. Add to Shortlist",
      description: "If the candidate looks like a good fit, add them to the Shortlisted list — from there you can mark them Selected (and send an interview invite) or Rejected (and send a rejection email) in the Candidate Pipeline tab.",
      icon: <CheckCircle2 size={16} />,
    },
  ];
  return (
    <Card className="bg-gradient-to-br from-violet-50/60 via-white to-fuchsia-50/40 border-violet-100">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2"><Info size={16} className="text-violet-600" /> How Resume Screening Works</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {steps.map(s => (
          <div key={s.title} className="flex gap-3">
            <div className="w-8 h-8 rounded-full bg-violet-100 text-violet-700 flex items-center justify-center shrink-0">
              {s.icon}
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-800">{s.title}</p>
              <p className="text-xs text-muted-foreground leading-relaxed">{s.description}</p>
            </div>
          </div>
        ))}
        <p className="text-xs text-muted-foreground pt-2 border-t border-violet-100/70">
          For screening many resumes at once, use the <strong>Bulk Resume Upload</strong> tab — you'll be able to set how many top candidates to automatically shortlist.
        </p>
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Bulk Resume Upload tab
// ─────────────────────────────────────────────────────────────────────────────

function BulkUploadTab() {
  const { toast } = useToast();
  const { data: ruleSets } = useListHiringRuleSets({ isActive: true });
  const { triggerBulkScreen, isScreening, showPipeline, progress, dismiss } = useResumeScreening();
  const [files, setFiles] = useState<File[]>([]);
  const [ruleSetId, setRuleSetId] = useState("");
  const [topN, setTopN] = useState("10");
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const valid = Array.from(list).filter(f => /\.(pdf|docx)$/i.test(f.name));
    setFiles(prev => [...prev, ...valid]);
  };

  const handleRun = async () => {
    if (files.length === 0 || !ruleSetId || !topN) {
      toast({ title: "Add resumes, pick a rule set, and set how many to shortlist", variant: "destructive" });
      return;
    }
    await triggerBulkScreen({ files, ruleSetId: Number(ruleSetId), topN: Number(topN) });
    setFiles([]);
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle className="text-base">Bulk Resume Upload</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <label
            htmlFor="bulk-resume-file"
            onDragOver={e => { e.preventDefault(); setDragActive(true); }}
            onDragLeave={() => setDragActive(false)}
            onDrop={e => { e.preventDefault(); setDragActive(false); addFiles(e.dataTransfer.files); }}
            className={`relative border-2 border-dashed transition-all rounded-xl p-7 flex flex-col items-center gap-2 text-center cursor-pointer block ${
              dragActive ? "border-violet-500 bg-violet-50" : "border-gray-200 hover:border-violet-400 bg-gray-50/50"
            }`}
          >
            <input
              ref={inputRef} id="bulk-resume-file" type="file" multiple accept=".pdf,.docx"
              onChange={e => addFiles(e.target.files)}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
            <div className={`w-12 h-12 rounded-full flex items-center justify-center transition-colors ${dragActive ? "bg-violet-600" : "bg-violet-600/10"}`}>
              <UploadCloud size={22} className={dragActive ? "text-white" : "text-violet-600"} />
            </div>
            <span className="text-sm font-semibold text-gray-700">
              {dragActive ? "Drop resumes here" : "Drag resumes here, or click to browse"}
            </span>
            <span className="text-xs text-muted-foreground">.pdf or .docx, multiple files</span>
          </label>

          {files.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {files.map((f, i) => (
                <Badge key={`${f.name}-${i}`} variant="secondary" className="gap-1">
                  <Files size={11} /> {f.name}
                  <button onClick={() => setFiles(files.filter((_, idx) => idx !== i))}><X size={11} /></button>
                </Badge>
              ))}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Hiring Rule Set</Label>
              <Select value={ruleSetId} onValueChange={setRuleSetId}>
                <SelectTrigger><SelectValue placeholder="Select rule set" /></SelectTrigger>
                <SelectContent>
                  {(ruleSets ?? []).map(rs => (
                    <SelectItem key={rs.id} value={String(rs.id)}>{rs.name} — {rs.departmentName}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Shortlist Top N Candidates</Label>
              <Input type="number" min={1} value={topN} onChange={e => setTopN(e.target.value)} />
            </div>
          </div>

          <Button className="w-full gap-1.5" disabled={isScreening} onClick={handleRun}>
            {isScreening ? <><Loader2 size={14} className="animate-spin" /> Screening in progress…</> : <><UserSearch size={14} /> Run Screening</>}
          </Button>
        </CardContent>
      </Card>

      <ResumeScreeningPipeline active={showPipeline} data={progress} onDismiss={dismiss} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Interview invite dialog (single or bulk)
// ─────────────────────────────────────────────────────────────────────────────

function InterviewInviteDialog({ mode, onClose, onSent }: {
  mode: { type: "single"; candidate: ScreeningCandidateItem } | { type: "bulk" };
  onClose: () => void;
  onSent: (result: { sent: number; failed: unknown[] } | ScreeningCandidateItem) => void;
}) {
  const { toast } = useToast();
  const [when, setWhen] = useState("");
  const singleMutation = useSendInterviewInvite();
  const bulkMutation = useSendInterviewInviteBulk();
  const isPending = singleMutation.isPending || bulkMutation.isPending;

  const handleSend = async () => {
    if (!when) {
      toast({ title: "Pick an interview date and time", variant: "destructive" });
      return;
    }
    const iso = new Date(when).toISOString();
    try {
      if (mode.type === "single") {
        const c = await singleMutation.mutateAsync({ id: mode.candidate.id, interviewDateTime: iso });
        toast({ title: `Interview invite sent to ${c.candidateName ?? "candidate"}` });
        onSent(c);
      } else {
        const res = await bulkMutation.mutateAsync(iso);
        toast({
          title: `Interview invites sent to ${res.sent} candidate(s)`,
          description: describeFailures(res.failed),
          variant: res.failed.length > 0 ? "destructive" : "default",
        });
        onSent(res);
      }
      onClose();
    } catch (err) {
      toast({ title: "Failed to send invite", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarClock size={16} className="text-indigo-600" />
            {mode.type === "single" ? `Schedule Interview — ${mode.candidate.candidateName ?? "Candidate"}` : "Schedule Interviews for All Selected"}
          </DialogTitle>
        </DialogHeader>
        <div className="py-2 space-y-2">
          <Label className="text-xs">Interview Date &amp; Time</Label>
          <Input type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} />
          {mode.type === "bulk" && (
            <p className="text-xs text-muted-foreground">
              This date and time will be sent to every currently Selected candidate who hasn't been invited yet.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSend} disabled={isPending} className="gap-1.5">
            {isPending ? "Sending…" : <><Mail size={13} /> Send Invite</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Candidate card + Pipeline panel
// ─────────────────────────────────────────────────────────────────────────────

function CandidateCard({ candidate, actions }: { candidate: ScreeningCandidateItem; actions: React.ReactNode }) {
  const { toast } = useToast();
  const [showReason, setShowReason] = useState(false);
  return (
    <Card>
      <CardContent className="p-4 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="font-bold text-sm">{candidate.candidateName ?? candidate.originalFilename}</p>
            <p className="text-xs text-muted-foreground">{candidate.ruleSetName} — {candidate.departmentName}</p>
          </div>
          <ScoreBadge score={candidate.matchScore} />
        </div>
        <div className="text-xs text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5">
          {candidate.email && <span className="flex items-center gap-1"><AtSign size={11} /> {candidate.email}</span>}
          {candidate.phone && <span className="flex items-center gap-1"><Phone size={11} /> {candidate.phone}</span>}
          {candidate.city && <span className="flex items-center gap-1"><MapPin size={11} /> {candidate.city}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {candidate.hasResume ? (
            <Button
              variant="outline" size="sm" className="h-7 gap-1 text-xs"
              onClick={() => openResume(candidate.id, msg => toast({ title: "Couldn't open resume", description: msg, variant: "destructive" }))}
            >
              <FileText size={12} /> Resume <ArrowUpRight size={10} />
            </Button>
          ) : (
            <span className="h-7 inline-flex items-center gap-1 text-[11px] text-muted-foreground px-2" title="Resume file was removed after this candidate was rejected">
              <FileText size={12} /> Resume removed
            </span>
          )}
          <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={() => setShowReason(true)}>
            <Info size={12} /> Reason
          </Button>
          {actions}
        </div>
      </CardContent>
      {showReason && <CandidateReasonDialog candidate={candidate} onClose={() => setShowReason(false)} />}
    </Card>
  );
}

function CandidatePipelinePanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<ScreeningCandidateStatus>("shortlisted");
  const { data: candidates, isLoading } = useListScreeningCandidates({ status: tab });
  const updateStatus = useUpdateCandidateStatus();
  const shortlistMutation = useShortlistCandidate();
  const rejectAllMutation = useSendRejectionEmailsAll();
  const [inviteFor, setInviteFor] = useState<{ type: "single"; candidate: ScreeningCandidateItem } | { type: "bulk" } | null>(null);

  const invalidateAll = () => queryClient.invalidateQueries({
    predicate: q => typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith("/api/recruitment/resume-screening/candidates"),
  });

  const setStatus = async (id: number, status: ScreeningCandidateStatus, label: string) => {
    await updateStatus.mutateAsync({ id, data: { status } });
    toast({ title: label });
    invalidateAll();
  };

  const handleRejectAll = async () => {
    const res = await rejectAllMutation.mutateAsync();
    toast({
      title: `Rejection email sent to ${res.sent} candidate(s)`,
      description: describeFailures(res.failed),
      variant: res.failed.length > 0 ? "destructive" : "default",
    });
    invalidateAll();
  };

  const pendingRejectionCount = (candidates ?? []).filter(c => c.status === "rejected" && !c.rejectionEmailedAt).length;

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle className="text-base flex items-center gap-2"><ClipboardList size={16} /> Review candidates by status</CardTitle>
        <PillTabs
          size="sm"
          value={tab}
          onChange={v => setTab(v as ScreeningCandidateStatus)}
          items={[
            { value: "shortlisted", label: "Shortlisted" },
            { value: "selected", label: "Selected" },
            { value: "rejected", label: "Rejected" },
            { value: "not_shortlisted", label: "Not Shortlisted" },
          ]}
        />
      </CardHeader>
      <CardContent className="space-y-3">
        {tab === "selected" && (
          <div className="flex justify-end">
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setInviteFor({ type: "bulk" })}>
              <CalendarClock size={13} /> Schedule interviews for all selected
            </Button>
          </div>
        )}
        {tab === "rejected" && (
          <div className="flex justify-end">
            <Button
              size="sm" className="gap-1.5 bg-rose-600 hover:bg-rose-700"
              disabled={pendingRejectionCount === 0 || rejectAllMutation.isPending}
              onClick={handleRejectAll}
            >
              <Mail size={13} /> {rejectAllMutation.isPending ? "Sending…" : `Send Email to Everyone (${pendingRejectionCount})`}
            </Button>
          </div>
        )}

        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {!isLoading && (candidates ?? []).length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-6">No candidates here yet.</p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          {(candidates ?? []).map(c => (
            <CandidateCard
              key={c.id}
              candidate={c}
              actions={
                tab === "shortlisted" ? (
                  <>
                    <Button size="sm" className="h-7 text-xs gap-1 bg-emerald-600 hover:bg-emerald-700" onClick={() => setStatus(c.id, "selected", `${c.candidateName ?? "Candidate"} marked Selected`)}>
                      <CheckCircle2 size={12} /> Mark Selected
                    </Button>
                    <Button size="sm" variant="outline" className="h-7 text-xs gap-1 text-rose-600 border-rose-200" onClick={() => setStatus(c.id, "rejected", `${c.candidateName ?? "Candidate"} marked Rejected`)}>
                      <XCircle size={12} /> Mark Rejected
                    </Button>
                  </>
                ) : tab === "selected" ? (
                  <>
                    <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => setInviteFor({ type: "single", candidate: c })}>
                      <CalendarClock size={12} /> {c.interviewInvitedAt ? "Re-send Invite" : "Send Interview Invite"}
                    </Button>
                    {c.interviewInvitedAt && (
                      <Badge variant="secondary" className="text-[10px]">
                        Invited for {c.interviewDatetime ? new Date(c.interviewDatetime).toLocaleString() : "—"}
                      </Badge>
                    )}
                    <Button size="sm" variant="outline" className="h-7 text-xs gap-1 text-rose-600 border-rose-200 ml-auto" onClick={() => setStatus(c.id, "rejected", `${c.candidateName ?? "Candidate"} marked Rejected`)}>
                      <XCircle size={12} /> Reject
                    </Button>
                  </>
                ) : tab === "rejected" ? (
                  c.rejectionEmailedAt ? (
                    <Badge variant="secondary" className="text-[10px] gap-1"><CheckCircle2 size={10} /> Emailed</Badge>
                  ) : (
                    <span className="text-[11px] text-muted-foreground">Not yet emailed</span>
                  )
                ) : (
                  <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={async () => { await shortlistMutation.mutateAsync(c.id); toast({ title: `${c.candidateName ?? "Candidate"} moved to Shortlisted` }); invalidateAll(); }}>
                    <ArrowUpRight size={12} /> Move to Shortlist
                  </Button>
                )
              }
            />
          ))}
        </div>
      </CardContent>

      {inviteFor && (
        <InterviewInviteDialog mode={inviteFor} onClose={() => setInviteFor(null)} onSent={invalidateAll} />
      )}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main page
// ─────────────────────────────────────────────────────────────────────────────

export default function ResumeScreening() {
  const [tab, setTab] = useState<"upload" | "bulk" | "rules" | "pipeline">("upload");

  return (
    <HrLayout>
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-black text-gray-900 flex items-center gap-2">
            <UserSearch size={22} className="text-violet-600" /> Resume Screening
          </h2>
          <p className="text-muted-foreground text-sm mt-0.5">
            Screen and shortlist candidates against department hiring rules.
          </p>
        </div>

        <PillTabs
          value={tab}
          onChange={v => setTab(v as typeof tab)}
          items={[
            { value: "upload", label: "Upload Resume", icon: <FileText size={14} /> },
            { value: "bulk", label: "Bulk Resume Upload", icon: <Files size={14} /> },
            { value: "rules", label: "Company Rules & Expectations", icon: <ClipboardList size={14} /> },
            { value: "pipeline", label: "Candidate Pipeline", icon: <UserSearch size={14} /> },
          ]}
        />

        {tab === "upload" && <UploadResumeTab />}
        {tab === "bulk" && <BulkUploadTab />}
        {tab === "rules" && <RulesTab />}
        {tab === "pipeline" && <CandidatePipelinePanel />}
      </div>
    </HrLayout>
  );
}

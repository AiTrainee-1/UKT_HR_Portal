import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { Clock, Info, Briefcase, Factory } from "lucide-react";
import { usePayrollSettings, useUpdatePayrollSettings } from "@/lib/api-client/custom-hooks";
import { validateHalfDayTimes } from "@/lib/late-detection";
import ProductionShiftConfigCard from "@/components/ProductionShiftConfigCard";

export default function AttendanceTab() {
  const { toast } = useToast();
  const updatePayrollSettings = useUpdatePayrollSettings();
  const { data: payrollSettingsData } = usePayrollSettings();

  // ── Attendance mode + production windows -loaded from DB ─────────────
  const [attMode, setAttMode] = useState({
    attendanceMode: "strict" as "strict" | "simple",
    simpleHalfShiftCutoff: "13:30",
    // undefined = the server did not report the switch (unknown), which is different from reporting it off.
    morningLateInEnabled: undefined as boolean | undefined,
    eveningEarlyOutEnabled: undefined as boolean | undefined,
    halfDayFirstHalfEndTime: "13:30",
    halfDaySecondHalfStartTime: "14:30",
    afternoonLateWindowMinutes: 60,
    afternoonPermissionWindowMinutes: 60,
    lastPunchPostShiftGraceHours: 9,
    firstPunchPreShiftBufferHours: 2,
    prodFirstHalfStart: "08:30",
    prodFirstHalfEnd: "12:30",
    prodSecondHalfStart: "13:30",
    prodSecondHalfEnd: "17:30",
    prodExtraStart: "17:50",
    prodExtraEnd: "20:00",
    defaultShiftGraceMinutes: 15,
    defaultShiftFirstHalfEnd: "13:30",
    defaultShiftLunchDurationMinutes: 60,
    defaultShiftLunchGraceMinutes: 10,
  });

  // Attendance tab is split Staff / Production -Strict/Simple mode, the
  // Half-Day times and the Late Detection switches are all staff-only
  // concepts, so they live under Staff.
  const [attSubTab, setAttSubTab] = useState<"staff" | "production">("staff");
  // Which switches the user has actually flipped since the settings last loaded -only those are ever sent, so a save
  // of some other field can never write a value the user did not choose (and never writes a guessed default).
  const [switchTouched, setSwitchTouched] = useState({ morning: false, evening: false });

  useEffect(() => {
    if (!payrollSettingsData) return;
    setSwitchTouched({ morning: false, evening: false });
    setAttMode({
      attendanceMode: (payrollSettingsData.attendanceMode as "strict" | "simple") || "strict",
      simpleHalfShiftCutoff: payrollSettingsData.simpleHalfShiftCutoff || "13:30",
      morningLateInEnabled: payrollSettingsData.morningLateInEnabled,
      eveningEarlyOutEnabled: payrollSettingsData.eveningEarlyOutEnabled,
      halfDayFirstHalfEndTime: payrollSettingsData.halfDayFirstHalfEndTime || "13:30",
      halfDaySecondHalfStartTime: payrollSettingsData.halfDaySecondHalfStartTime || "14:30",
      afternoonLateWindowMinutes: payrollSettingsData.afternoonLateWindowMinutes ?? 60,
      afternoonPermissionWindowMinutes: payrollSettingsData.afternoonPermissionWindowMinutes ?? 60,
      lastPunchPostShiftGraceHours: payrollSettingsData.lastPunchPostShiftGraceHours ?? 9,
      firstPunchPreShiftBufferHours: payrollSettingsData.firstPunchPreShiftBufferHours ?? 2,
      prodFirstHalfStart: payrollSettingsData.prodFirstHalfStart || "08:30",
      prodFirstHalfEnd: payrollSettingsData.prodFirstHalfEnd || "12:30",
      prodSecondHalfStart: payrollSettingsData.prodSecondHalfStart || "13:30",
      prodSecondHalfEnd: payrollSettingsData.prodSecondHalfEnd || "17:30",
      prodExtraStart: payrollSettingsData.prodExtraStart || "17:50",
      prodExtraEnd: payrollSettingsData.prodExtraEnd || "20:00",
      defaultShiftGraceMinutes: payrollSettingsData.defaultShiftGraceMinutes ?? 15,
      defaultShiftFirstHalfEnd: payrollSettingsData.defaultShiftFirstHalfEnd || "13:30",
      defaultShiftLunchDurationMinutes: payrollSettingsData.defaultShiftLunchDurationMinutes ?? 60,
      defaultShiftLunchGraceMinutes: payrollSettingsData.defaultShiftLunchGraceMinutes ?? 10,
    });
  }, [payrollSettingsData]);

  // The Late Detection switches and Half-Day times are company-wide rules: a branch-assigned login can see them but
  // the server refuses (403) any save that carries them, so they are shown read-only and left out of the request.
  // An older backend does not say, and is treated as editable.
  const companyWideEditable = payrollSettingsData?.companyWideRulesEditable !== false;
  const companyWideNote = "Company-wide rule - set by an administrator";

  // A backend that does not send a setting cannot have it edited here: the control stays disabled and says so, and
  // nothing is sent for it (the values in the boxes would only be this page's guesses).
  const morningReported = payrollSettingsData?.morningLateInEnabled != null;
  const eveningReported = payrollSettingsData?.eveningEarlyOutEnabled != null;
  const halfDayReported =
    payrollSettingsData?.halfDayFirstHalfEndTime != null && payrollSettingsData?.halfDaySecondHalfStartTime != null;
  const notReportedNote = "Not reported by the server, so it cannot be changed here";

  // Same rule the server enforces on save (First Half End must not be later than Second Half Start); checked here so
  // the message shows next to the fields and nothing is sent while the pair is contradictory.
  const halfDayError =
    companyWideEditable && halfDayReported
      ? validateHalfDayTimes(attMode.halfDayFirstHalfEndTime, attMode.halfDaySecondHalfStartTime)
      : null;

  const saveAttendanceMode = async () => {
    if (halfDayError) {
      toast({ title: "Half-Day times are not valid", description: halfDayError, variant: "destructive" });
      return;
    }
    try {
      await updatePayrollSettings.mutateAsync({
        attendanceMode: attMode.attendanceMode,
        simpleHalfShiftCutoff: attMode.simpleHalfShiftCutoff,
        ...(companyWideEditable
          ? {
              ...(switchTouched.morning && attMode.morningLateInEnabled !== undefined
                ? { morningLateInEnabled: attMode.morningLateInEnabled }
                : {}),
              ...(switchTouched.evening && attMode.eveningEarlyOutEnabled !== undefined
                ? { eveningEarlyOutEnabled: attMode.eveningEarlyOutEnabled }
                : {}),
              ...(halfDayReported
                ? {
                    halfDayFirstHalfEndTime: attMode.halfDayFirstHalfEndTime,
                    halfDaySecondHalfStartTime: attMode.halfDaySecondHalfStartTime,
                  }
                : {}),
            }
          : {}),
        afternoonLateWindowMinutes: attMode.afternoonLateWindowMinutes,
        afternoonPermissionWindowMinutes: attMode.afternoonPermissionWindowMinutes,
        lastPunchPostShiftGraceHours: attMode.lastPunchPostShiftGraceHours,
        firstPunchPreShiftBufferHours: attMode.firstPunchPreShiftBufferHours,
        prodFirstHalfStart: attMode.prodFirstHalfStart,
        prodFirstHalfEnd: attMode.prodFirstHalfEnd,
        prodSecondHalfStart: attMode.prodSecondHalfStart,
        prodSecondHalfEnd: attMode.prodSecondHalfEnd,
        prodExtraStart: attMode.prodExtraStart,
        prodExtraEnd: attMode.prodExtraEnd,
        defaultShiftGraceMinutes: attMode.defaultShiftGraceMinutes,
        defaultShiftFirstHalfEnd: attMode.defaultShiftFirstHalfEnd,
        defaultShiftLunchDurationMinutes: attMode.defaultShiftLunchDurationMinutes,
        defaultShiftLunchGraceMinutes: attMode.defaultShiftLunchGraceMinutes,
      } as never);
      toast({
        title: "Attendance settings saved",
        description: `Mode: ${attMode.attendanceMode === "simple" ? "Simple (morning + evening punch)" : "Strict (4-punch engine)"}. Applies to new calculations.`,
      });
    } catch (err) {
      toast({
        title: "Failed to save attendance settings",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    }
  };

  return (
    <>
      {/* Staff / Production split -Strict/Simple mode, the Half-Day times and
                the Late Detection switches are all staff-only concepts, so
                they live under Staff. Production has its own segment-based
                engine with no mode switch. */}
      <PillTabs
        items={[
          { value: "staff", label: "Staff", icon: <Briefcase size={13} /> },
          { value: "production", label: "Production", icon: <Factory size={13} /> },
        ]}
        value={attSubTab}
        onChange={(v) => setAttSubTab(v as "staff" | "production")}
        baseColor="#0f172a"
        pillBg="#f1f5f9"
      />

      {attSubTab === "staff" && (
        <>
          {/* ── How each mode works ── */}
          <Card className="border-0 shadow-sm bg-slate-50/60">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-bold flex items-center gap-2">
                <Info size={15} className="text-slate-500" /> How Staff Attendance Is Decided
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-xs text-slate-600 leading-relaxed">
              <div className="p-3 rounded-lg bg-white border border-slate-200">
                <p className="font-bold text-slate-800 mb-1">Shared by both modes -three independent rules</p>
                <p>
                  <strong>Half-Day Detection</strong> decides Full Day vs Half Day vs Absent purely from whether the
                  employee has a punch before the <strong>First-Half-End</strong> time and a punch at/after the{" "}
                  <strong>Second-Half-Start</strong> time (both set below) -these two clock times are the same for every
                  shift. <strong>Late Detection</strong> (Morning Late-In / Evening Early-Out) is judged separately,
                  against the employee's own assigned shift start/end + grace from <strong>Manage Shift</strong> -a very
                  late arrival that still beats the Half-Day cutoff is Full Day <em>and</em> Late, never auto-demoted.
                  An arrival <em>at or after</em> the First-Half-End time is different: the morning half was missed, so
                  the day is a Half Day only and is <em>not</em> also counted as Late (no Late alert is sent either).{" "}
                  <strong>Permission</strong> (Settings → Late Detection) can shift that day's Late Detection boundary
                  for an individual employee, but never moves the Half-Day cutoff itself.
                </p>
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                <div className="p-3 rounded-lg bg-white border border-amber-200">
                  <p className="font-bold text-amber-800 mb-1">Strict Mode</p>
                  <p>
                    Expects all 4 punches -morning IN, lunch OUT, lunch return, evening OUT. On top of the shared rules
                    above it <strong>additionally tracks lunch-return lateness</strong> (Night Late, informational
                    only). Choose this when you need to police the lunch break.
                  </p>
                </div>
                <div className="p-3 rounded-lg bg-white border border-green-200">
                  <p className="font-bold text-green-800 mb-1">Simple Mode</p>
                  <p>
                    Only the first and last punch of the day matter -<strong>no lunch tracking at all</strong>. Half-Day
                    Detection and Late Detection behave exactly as in Strict Mode. Choose this when the lunch break
                    isn't punched or isn't policed.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* ── Calculation Mode ── */}
          <Card className="border-0 shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-bold flex items-center gap-2">
                <Clock size={15} className="text-amber-500" /> Attendance Calculation Mode
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid sm:grid-cols-2 gap-3">
                {/* Strict */}
                <button
                  onClick={() => setAttMode((a) => ({ ...a, attendanceMode: "strict" }))}
                  className={`text-left p-4 rounded-xl border-2 transition-all ${
                    attMode.attendanceMode === "strict"
                      ? "border-amber-400 bg-amber-50/60 shadow-sm"
                      : "border-gray-200 bg-white hover:border-gray-300"
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <p className="font-bold text-sm text-gray-900">Strict Mode (4-Punch)</p>
                    {attMode.attendanceMode === "strict" && (
                      <span className="text-[10px] font-bold text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">
                        ACTIVE
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 leading-relaxed">
                    Tracks all 4 punches: morning IN, lunch OUT, lunch return, evening OUT. Full/Half/Absent and Late
                    Detection work exactly as in Simple Mode; the only addition is informational lunch-return (Night
                    Late) tracking.
                  </p>
                </button>
                {/* Simple */}
                <button
                  onClick={() => setAttMode((a) => ({ ...a, attendanceMode: "simple" }))}
                  className={`text-left p-4 rounded-xl border-2 transition-all ${
                    attMode.attendanceMode === "simple"
                      ? "border-green-400 bg-green-50/60 shadow-sm"
                      : "border-gray-200 bg-white hover:border-gray-300"
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <p className="font-bold text-sm text-gray-900">Simple Mode (Recommended)</p>
                    {attMode.attendanceMode === "simple" && (
                      <span className="text-[10px] font-bold text-green-700 bg-green-100 px-2 py-0.5 rounded-full">
                        ACTIVE
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 leading-relaxed">
                    Only the first and last punch of the day matter. No lunch-break tracking. Full/Half/Absent comes
                    from the Half-Day times below; Late and Early-Out from the Late Detection switches.
                  </p>
                </button>
              </div>

              {/* Half-Day Detection -REPLACES the old punctuality-window
                    escalation entirely. Full/Half/Absent is decided purely by
                    whether the employee has a punch before First-Half-End and
                    a punch at/after Second-Half-Start -the same two clock
                    times for every shift, independent of Late Detection. */}
              <div className="grid sm:grid-cols-2 gap-4 p-3 bg-amber-50/50 border border-amber-100 rounded-lg">
                <div className="sm:col-span-2">
                  <Label className="text-xs font-semibold text-amber-900">Half-Day Detection</Label>
                  <p className="text-[11px] text-gray-500 mt-0.5">
                    <strong>Morning Half</strong> = any punch before First Half End. <strong>Evening Half</strong> = any
                    punch at/after Second Half Start. Both halves = Full Day; one = Half Day; none = Absent. A punch
                    between the two times attends neither half. Simple and Strict modes use the same rule, and the
                    shift's own start/end never change it. Lateness within a half is judged separately, by Late
                    Detection below -it never costs the half by itself.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs" htmlFor="half-day-first-half-end">
                    First Half End Time
                  </Label>
                  <p className="text-[11px] text-gray-500 -mt-1">A punch before this time attends the Morning Half</p>
                  <Input
                    id="half-day-first-half-end"
                    type="time"
                    value={attMode.halfDayFirstHalfEndTime}
                    onChange={(e) => setAttMode((a) => ({ ...a, halfDayFirstHalfEndTime: e.target.value }))}
                    disabled={!companyWideEditable || !halfDayReported}
                    aria-invalid={!!halfDayError}
                    className={`max-w-[140px] ${halfDayError ? "border-red-400" : ""}`}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs" htmlFor="half-day-second-half-start">
                    Second Half Start Time
                  </Label>
                  <p className="text-[11px] text-gray-500 -mt-1">A punch at/after this time attends the Evening Half</p>
                  <Input
                    id="half-day-second-half-start"
                    type="time"
                    value={attMode.halfDaySecondHalfStartTime}
                    onChange={(e) => setAttMode((a) => ({ ...a, halfDaySecondHalfStartTime: e.target.value }))}
                    disabled={!companyWideEditable || !halfDayReported}
                    aria-invalid={!!halfDayError}
                    className={`max-w-[140px] ${halfDayError ? "border-red-400" : ""}`}
                  />
                </div>
                {halfDayError && (
                  <p
                    role="alert"
                    data-testid="half-day-error"
                    className="sm:col-span-2 text-[11px] font-medium text-red-600"
                  >
                    {halfDayError}
                  </p>
                )}
                {!companyWideEditable && (
                  <p
                    data-testid="company-wide-note-half-day"
                    className="sm:col-span-2 text-[11px] font-medium text-slate-500"
                  >
                    {companyWideNote}
                  </p>
                )}
                {companyWideEditable && payrollSettingsData && !halfDayReported && (
                  <p
                    data-testid="half-day-not-reported"
                    className="sm:col-span-2 text-[11px] font-medium text-slate-500"
                  >
                    {notReportedNote}
                  </p>
                )}
              </div>

              {/* Late Detection -Morning Late-In / Evening Early-Out, judged
                    against the shift's own start/end + grace (Manage Shift),
                    or that day's permission-shifted boundary. Independent
                    toggles: Morning ships on, Evening ships off. */}
              <div className="grid sm:grid-cols-2 gap-4 p-3 bg-sky-50/50 border border-sky-100 rounded-lg">
                <div className="sm:col-span-2">
                  <Label className="text-xs font-semibold text-sky-900">Late Detection switches</Label>
                  <p className="text-[11px] text-gray-500 mt-0.5">
                    Two independent checks, both judged against the employee's own shift start/end + grace from Manage
                    Shift (moved 60 minutes on a day an Allowed permission applies). Occurrences share one monthly pool
                    priced in Settings → Late Detection.
                  </p>
                </div>
                <div className="flex items-center justify-between bg-white rounded-lg border border-sky-100 p-3">
                  <div>
                    <Label className="text-xs">Morning Late-In</Label>
                    <p className="text-[11px] text-gray-500">Flag a punch after shift start + grace.</p>
                    {payrollSettingsData && !morningReported && (
                      <p data-testid="morning-not-reported" className="text-[11px] font-medium text-slate-500">
                        {notReportedNote}
                      </p>
                    )}
                  </div>
                  <Switch
                    aria-label="Morning Late-In"
                    checked={attMode.morningLateInEnabled === true}
                    disabled={!companyWideEditable || !morningReported}
                    onCheckedChange={(v) => {
                      setAttMode((a) => ({ ...a, morningLateInEnabled: v }));
                      setSwitchTouched((t) => ({ ...t, morning: true }));
                    }}
                  />
                </div>
                <div className="flex items-center justify-between bg-white rounded-lg border border-sky-100 p-3">
                  <div>
                    <Label className="text-xs">Evening Early-Out</Label>
                    <p className="text-[11px] text-gray-500">
                      Flag a punch before shift end - grace.
                      {eveningReported ? " Off by default." : ""}
                    </p>
                    {payrollSettingsData && !eveningReported && (
                      <p data-testid="evening-not-reported" className="text-[11px] font-medium text-slate-500">
                        {notReportedNote}
                      </p>
                    )}
                  </div>
                  <Switch
                    aria-label="Evening Early-Out"
                    checked={attMode.eveningEarlyOutEnabled === true}
                    disabled={!companyWideEditable || !eveningReported}
                    onCheckedChange={(v) => {
                      setAttMode((a) => ({ ...a, eveningEarlyOutEnabled: v }));
                      setSwitchTouched((t) => ({ ...t, evening: true }));
                    }}
                  />
                </div>
                {!companyWideEditable && (
                  <p
                    data-testid="company-wide-note-late"
                    className="sm:col-span-2 text-[11px] font-medium text-slate-500"
                  >
                    {companyWideNote}
                  </p>
                )}
              </div>

              {/* Afternoon (Night Late) lunch-return zone -a different,
                    untouched axis (strict mode only): a slow return from
                    lunch is flagged but can never demote the day anymore -
                    only Half-Day Detection above decides Full vs Half now. */}
              <div className="grid sm:grid-cols-2 gap-4 p-3 bg-emerald-50/50 border border-emerald-100 rounded-lg">
                <div className="space-y-1.5 sm:col-span-2">
                  <p className="text-[11px] font-semibold text-emerald-900">
                    Afternoon (Night Late) -lunch return, strict mode only, informational
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Night Late Window (minutes past lunch deadline)</Label>
                  <Input
                    type="number"
                    min={0}
                    step={5}
                    value={attMode.afternoonLateWindowMinutes}
                    onChange={(e) =>
                      setAttMode((a) => ({
                        ...a,
                        afternoonLateWindowMinutes: Math.max(0, Number(e.target.value) || 0),
                      }))
                    }
                    className="max-w-[140px]"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Afternoon Permission Zone Width (minutes)</Label>
                  <Input
                    type="number"
                    min={0}
                    step={5}
                    value={attMode.afternoonPermissionWindowMinutes}
                    onChange={(e) =>
                      setAttMode((a) => ({
                        ...a,
                        afternoonPermissionWindowMinutes: Math.max(0, Number(e.target.value) || 0),
                      }))
                    }
                    className="max-w-[140px]"
                  />
                </div>
              </div>

              {/* Cross-midnight punch reattribution -a forgotten evening exit
                    punch made hours late, after midnight, gets misread as the
                    NEXT day's first punch without this, shifting every one of
                    that day's real punches down a slot. */}
              <div className="grid sm:grid-cols-2 gap-4 p-3 bg-blue-50/50 border border-blue-100 rounded-lg">
                <div className="space-y-1.5">
                  <Label className="text-xs">Forgotten Last-Out Grace (hours after shift end)</Label>
                  <p className="text-[11px] text-gray-500 -mt-1">
                    A punch made this many hours after shift end -even after midnight -is treated as that day's own
                    last-out instead of tomorrow's first punch. E.g. 9 hours after a 20:00 end covers a punch as late as
                    05:00. Set to 0 to disable.
                  </p>
                  <Input
                    type="number"
                    min={0}
                    step={0.5}
                    value={attMode.lastPunchPostShiftGraceHours}
                    onChange={(e) =>
                      setAttMode((a) => ({
                        ...a,
                        lastPunchPostShiftGraceHours: Math.max(0, Number(e.target.value) || 0),
                      }))
                    }
                    className="max-w-[140px]"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Next-Day Early-Arrival Protection (hours before shift start)</Label>
                  <p className="text-[11px] text-gray-500 -mt-1">
                    The grace window above can never reach closer than this many hours before the next day's own shift
                    start -protects a genuinely early arrival from being stolen and misattributed to yesterday. Set to 0
                    to remove this cap.
                  </p>
                  <Input
                    type="number"
                    min={0}
                    step={0.5}
                    value={attMode.firstPunchPreShiftBufferHours}
                    onChange={(e) =>
                      setAttMode((a) => ({
                        ...a,
                        firstPunchPreShiftBufferHours: Math.max(0, Number(e.target.value) || 0),
                      }))
                    }
                    className="max-w-[140px]"
                  />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <p className="text-[11px] text-gray-500">
                    Only reattributes a punch when the earlier day genuinely looks like it's missing its own closing
                    punch (nothing recorded at or after that day's shift end) -an already-complete day never has a stray
                    next-day punch stolen from it. Staff only.
                  </p>
                </div>
              </div>

              {attMode.attendanceMode === "simple" && (
                <div className="grid sm:grid-cols-2 gap-4 p-3 bg-gray-50 border border-gray-200 rounded-lg">
                  <div className="space-y-1.5">
                    <Label className="text-xs text-gray-400">Legacy Half-Shift Cutoff Time</Label>
                    <p className="text-[11px] text-gray-400 -mt-1">
                      Historical only -no longer used for new calculations since the Half-Day times above replaced it.
                      Kept only for reference.
                    </p>
                    <Input
                      type="time"
                      value={attMode.simpleHalfShiftCutoff}
                      onChange={(e) => setAttMode((a) => ({ ...a, simpleHalfShiftCutoff: e.target.value }))}
                      disabled
                    />
                  </div>
                </div>
              )}

              {/* Company-wide defaults for NEW shifts. Office start/end time
                    is deliberately NOT here -Manage Shift already owns that
                    per-shift, and duplicating it here just invites drift. */}
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-3">
                <div>
                  <p className="text-xs font-bold text-slate-800">Default Timings for New Shifts</p>
                  <p className="text-[11px] text-gray-500 mt-0.5">
                    Pre-filled when someone creates a new shift in <strong>Manage Shift</strong> (which still owns
                    start/end time per shift). Existing shifts are never changed by editing these.
                  </p>
                </div>
                <div className="grid sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Grace Period (minutes)</Label>
                    <p className="text-[11px] text-gray-500 -mt-1">Arriving within this isn't Late</p>
                    <Input
                      type="number"
                      min={0}
                      value={attMode.defaultShiftGraceMinutes}
                      onChange={(e) =>
                        setAttMode((a) => ({
                          ...a,
                          defaultShiftGraceMinutes: Math.max(0, Number(e.target.value) || 0),
                        }))
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">First Half Ends (lunch start)</Label>
                    <Input
                      type="time"
                      value={attMode.defaultShiftFirstHalfEnd}
                      onChange={(e) => setAttMode((a) => ({ ...a, defaultShiftFirstHalfEnd: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Lunch Duration (minutes)</Label>
                    <Input
                      type="number"
                      min={0}
                      value={attMode.defaultShiftLunchDurationMinutes}
                      onChange={(e) =>
                        setAttMode((a) => ({
                          ...a,
                          defaultShiftLunchDurationMinutes: Math.max(0, Number(e.target.value) || 0),
                        }))
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Lunch Grace (minutes)</Label>
                    <p className="text-[11px] text-gray-500 -mt-1">Strict Mode only</p>
                    <Input
                      type="number"
                      min={0}
                      value={attMode.defaultShiftLunchGraceMinutes}
                      onChange={(e) =>
                        setAttMode((a) => ({
                          ...a,
                          defaultShiftLunchGraceMinutes: Math.max(0, Number(e.target.value) || 0),
                        }))
                      }
                    />
                  </div>
                </div>
              </div>

              <Button size="sm" onClick={saveAttendanceMode} disabled={updatePayrollSettings.isPending}>
                {updatePayrollSettings.isPending ? "Saving…" : "Save Attendance Settings"}
              </Button>
            </CardContent>
          </Card>
        </>
      )}

      {attSubTab === "production" && (
        <>
          <Card className="border-0 shadow-sm bg-slate-50/60">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-bold flex items-center gap-2">
                <Info size={15} className="text-slate-500" /> How Production Attendance Is Decided
              </CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-slate-600 leading-relaxed">
              <p>
                Production doesn't use Strict/Simple mode at all -it's scored against the
                <strong> shift segments</strong> configured below. Each segment the employee covers (arriving no later
                than its start + grace, leaving no earlier than its end) earns its share of a shift, so a day can total
                more than one shift when extra segments are worked. Pay is{" "}
                <strong>total shifts earned × salary per shift</strong>.
              </p>
            </CardContent>
          </Card>

          {/* ── Production Punch Times & Shift Segments (replaces the old fixed 3-window model) ── */}
          <ProductionShiftConfigCard />

          {/* Production PF/ESI deductions are configured in the Payroll tab
                (prodPfRate / prodEsiRate / prodEsiApplicableBelow) -the only
                rates the payroll engine actually applies. */}
        </>
      )}
    </>
  );
}

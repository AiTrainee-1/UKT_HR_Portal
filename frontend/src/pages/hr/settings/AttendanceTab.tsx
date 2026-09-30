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
import { clockMinutes } from "@/lib/late-detection";
import {
  DEFAULT_ARRIVAL,
  MAX_WINDOW_MINUTES,
  arrivalLimits,
  clock,
  minutesOf,
  shiftsFor,
  validateArrival,
  type ArrivalSettings,
  type ArrivalZone,
} from "@/lib/arrival-rules";
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
  // The arrival timeline (Late window, permission window, extra minutes, quarter-shift deduction), plus the example
  // shift the preview table is drawn for (never saved: only the four settings are).
  const [arrival, setArrival] = useState<ArrivalSettings>(DEFAULT_ARRIVAL);
  const [sampleShift, setSampleShift] = useState({ start: "09:00", grace: 10 });

  useEffect(() => {
    if (!payrollSettingsData) return;
    setSwitchTouched({ morning: false, evening: false });
    setAttMode({
      attendanceMode: (payrollSettingsData.attendanceMode as "strict" | "simple") || "strict",
      simpleHalfShiftCutoff: payrollSettingsData.simpleHalfShiftCutoff || "13:30",
      morningLateInEnabled: payrollSettingsData.morningLateInEnabled,
      eveningEarlyOutEnabled: payrollSettingsData.eveningEarlyOutEnabled,
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
    setArrival({
      lateWindowMinutes: payrollSettingsData.arrivalLateWindowMinutes ?? DEFAULT_ARRIVAL.lateWindowMinutes,
      permissionWindowMinutes:
        payrollSettingsData.arrivalPermissionWindowMinutes ?? DEFAULT_ARRIVAL.permissionWindowMinutes,
      extraMinutes: payrollSettingsData.arrivalExtraMinutes ?? DEFAULT_ARRIVAL.extraMinutes,
      quarterDeduction: payrollSettingsData.arrivalQuarterDeduction ?? DEFAULT_ARRIVAL.quarterDeduction,
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
  const halfDayReported = payrollSettingsData?.halfDaySecondHalfStartTime != null;
  const arrivalReported = payrollSettingsData?.arrivalLateWindowMinutes != null;
  const notReportedNote = "Not reported by the server, so it cannot be changed here";

  // The same checks the server makes on save, so the message shows next to the fields and nothing is sent while a
  // value is contradictory. (The old fixed First Half End time is retired: each shift's own first-half limit, worked out
  // from the arrival timeline below, replaces it.)
  const halfDayError =
    companyWideEditable && halfDayReported && clockMinutes(attMode.halfDaySecondHalfStartTime) === null
      ? "Enter Second Half Start as a valid clock time."
      : null;
  const arrivalError = companyWideEditable && arrivalReported ? validateArrival(arrival) : null;

  const saveAttendanceMode = async () => {
    if (halfDayError || arrivalError) {
      toast({
        title: halfDayError ? "Half-Day times are not valid" : "Arrival timeline is not valid",
        description: halfDayError ?? arrivalError ?? undefined,
        variant: "destructive",
      });
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
              ...(halfDayReported ? { halfDaySecondHalfStartTime: attMode.halfDaySecondHalfStartTime } : {}),
              ...(arrivalReported
                ? {
                    arrivalLateWindowMinutes: arrival.lateWindowMinutes,
                    arrivalPermissionWindowMinutes: arrival.permissionWindowMinutes,
                    arrivalExtraMinutes: arrival.extraMinutes,
                    arrivalQuarterDeduction: arrival.quarterDeduction,
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
                <p className="font-bold text-slate-800 mb-1">Shared by both modes</p>
                <p>
                  The <strong>first punch</strong> is placed on an <strong>arrival timeline</strong> measured from the
                  employee's own shift start and grace (<strong>Manage Shift</strong>): on time, then{" "}
                  <strong>Late</strong> (Full Day, counted in the late pool), then a permission window, then a few extra
                  minutes. An approved Morning Late-In permission excuses an arrival up to the end of the permission
                  window; after the Late window it is a <strong>quarter-shift</strong> day (a small deduction, never
                  also Late); after all of it the <strong>first half is missed</strong> -Absent until a punch at/after{" "}
                  <strong>Second Half Start</strong>, then a Half Day. The four numbers are set below.{" "}
                  <strong>Half-Day Detection</strong> decides Full vs Half vs Absent from those two facts: did the first
                  punch make the first half, and is there a punch at/after Second Half Start.
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
                    <strong>Morning Half</strong> = the first punch is within the shift's first-half limit (start +
                    grace + the Arrival timeline windows below). <strong>Evening Half</strong> = any punch at/after
                    Second Half Start. Both halves = Full Day; one = Half Day; none = Absent (a first punch after the
                    first-half limit stays Absent until a second-half punch is recorded). Simple and Strict modes use
                    the same rule.
                  </p>
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

              {/* Arrival timeline -where a morning arrival falls, measured from each shift's own start and grace.
                    Every step follows the one before it; all four numbers are settings. */}
              <div
                className="grid sm:grid-cols-2 gap-4 p-3 bg-violet-50/50 border border-violet-100 rounded-lg"
                data-testid="arrival-timeline"
              >
                <div className="sm:col-span-2">
                  <Label className="text-xs font-semibold text-violet-900">Arrival timeline</Label>
                  <p className="text-[11px] text-gray-500 mt-0.5">
                    Measured from each shift's own start time and grace (Manage Shift), one step after the other:{" "}
                    <strong>on time</strong> until start + grace, then <strong>Late</strong> for the Late window, then
                    the <strong>permission window</strong> (an approved Morning Late-In permission excuses an arrival up
                    to its end), then the <strong>extra minutes</strong>. Arriving after the Late window with no
                    covering permission is a <strong>quarter-shift</strong> day; arriving after all of it means the
                    first half was missed (Absent until a second-half punch, then Half Day).
                  </p>
                </div>
                {(
                  [
                    [
                      "arrival-late-window",
                      "Late window (minutes)",
                      "Late for this long after the grace period",
                      "lateWindowMinutes",
                      5,
                    ],
                    [
                      "arrival-permission-window",
                      "Permission window (minutes)",
                      "After the Late window: an approved Late-In permission still excuses",
                      "permissionWindowMinutes",
                      5,
                    ],
                    [
                      "arrival-extra",
                      "Extra minutes",
                      "After the permission window: still the first half, quarter-shift rule",
                      "extraMinutes",
                      5,
                    ],
                    [
                      "arrival-deduction",
                      "Quarter-shift deduction (shifts)",
                      "Taken off the day for a quarter-shift arrival; 0 = none",
                      "quarterDeduction",
                      0.05,
                    ],
                  ] as const
                ).map(([id, label, hint, key, step]) => (
                  <div key={id} className="space-y-1.5">
                    <Label className="text-xs" htmlFor={id}>
                      {label}
                    </Label>
                    <p className="text-[11px] text-gray-500 -mt-1">{hint}</p>
                    <Input
                      id={id}
                      type="number"
                      min={0}
                      max={key === "quarterDeduction" ? 1 : MAX_WINDOW_MINUTES}
                      step={step}
                      value={arrival[key]}
                      onChange={(e) =>
                        setArrival((a) => ({ ...a, [key]: e.target.value === "" ? 0 : Number(e.target.value) }))
                      }
                      disabled={!companyWideEditable || !arrivalReported}
                      aria-invalid={!!arrivalError}
                      className={`max-w-[140px] ${arrivalError ? "border-red-400" : ""}`}
                    />
                  </div>
                ))}
                {arrivalError && (
                  <p
                    role="alert"
                    data-testid="arrival-error"
                    className="sm:col-span-2 text-[11px] font-medium text-red-600"
                  >
                    {arrivalError}
                  </p>
                )}
                {!companyWideEditable && (
                  <p
                    data-testid="company-wide-note-arrival"
                    className="sm:col-span-2 text-[11px] font-medium text-slate-500"
                  >
                    {companyWideNote}
                  </p>
                )}
                {companyWideEditable && payrollSettingsData && !arrivalReported && (
                  <p
                    data-testid="arrival-not-reported"
                    className="sm:col-span-2 text-[11px] font-medium text-slate-500"
                  >
                    {notReportedNote}
                  </p>
                )}
                <ArrivalPreview
                  arrival={arrival}
                  sample={sampleShift}
                  onSample={setSampleShift}
                  secondHalfStart={attMode.halfDaySecondHalfStartTime}
                />
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
                    Shift (an Allowed Morning Late-In permission excuses the arrival up to the end of the permission
                    window; an Allowed Evening Early-Out moves that day's end 60 minutes earlier). Occurrences share one
                    monthly pool priced in Settings → Late Detection.
                  </p>
                </div>
                <div className="flex items-center justify-between bg-white rounded-lg border border-sky-100 p-3">
                  <div>
                    <Label className="text-xs">Morning Late-In</Label>
                    <p className="text-[11px] text-gray-500">
                      Flag a first punch inside the Late window (after shift start + grace).
                    </p>
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

const ZONE_ROWS: { zone: ArrivalZone; label: string }[] = [
  { zone: "on_time", label: "On time" },
  { zone: "late", label: "Late: a Full Day, counted in the late pool" },
  { zone: "excused", label: "Permission window: with an approved Late-In permission a Full Day and no Late mark" },
  { zone: "quarter", label: "Quarter-shift arrival (a permission does not cover these)" },
  { zone: "second_half", label: "First half missed: Absent until a second-half punch, then Half Day" },
];

/** What the arrival timeline means for one example shift, so HR can see the numbers they typed as clock times. */
function ArrivalPreview({
  arrival,
  sample,
  onSample,
  secondHalfStart,
}: {
  arrival: ArrivalSettings;
  sample: { start: string; grace: number };
  onSample: (s: { start: string; grace: number }) => void;
  secondHalfStart: string;
}) {
  const limits = arrivalLimits(sample.start, sample.grace, arrival);
  const bad = validateArrival(arrival) !== null;
  const secondStart = minutesOf(secondHalfStart);
  const range = (zone: ArrivalZone): string => {
    if (!limits) return "-";
    const { onTimeUntil, lateUntil, permissionUntil, firstHalfUntil } = limits;
    switch (zone) {
      case "on_time":
        return `up to ${clock(onTimeUntil)}`;
      case "late":
        return lateUntil > onTimeUntil ? `${clock(onTimeUntil + 1)} - ${clock(lateUntil)}` : "none";
      case "excused":
        return permissionUntil > lateUntil
          ? `${clock(onTimeUntil + 1)} - ${clock(permissionUntil)} (with a permission)`
          : lateUntil > onTimeUntil
            ? `${clock(onTimeUntil + 1)} - ${clock(lateUntil)} (with a permission)`
            : "none";
      case "quarter":
        return `${clock(lateUntil + 1)} - ${clock(firstHalfUntil)}`;
      default:
        return `after ${clock(firstHalfUntil)}`;
    }
  };
  return (
    <div className="sm:col-span-2 rounded-lg border border-violet-100 bg-white p-3" data-testid="arrival-preview">
      <div className="flex flex-wrap items-end gap-3 mb-2">
        <p className="text-[11px] font-semibold text-violet-900 mr-auto">What this means for an example shift</p>
        <div className="space-y-1">
          <Label className="text-[11px]" htmlFor="arrival-sample-start">
            Shift start
          </Label>
          <Input
            id="arrival-sample-start"
            type="time"
            value={sample.start}
            onChange={(e) => onSample({ ...sample, start: e.target.value })}
            className="h-8 w-[110px] text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[11px]" htmlFor="arrival-sample-grace">
            Grace (min)
          </Label>
          <Input
            id="arrival-sample-grace"
            type="number"
            min={0}
            value={sample.grace}
            onChange={(e) => onSample({ ...sample, grace: Math.max(0, Number(e.target.value) || 0) })}
            className="h-8 w-[80px] text-xs"
          />
        </div>
      </div>
      {!limits || bad ? (
        <p className="text-[11px] text-slate-500">
          Enter a valid shift start and valid numbers above to see the timeline.
        </p>
      ) : (
        <>
          <table className="w-full text-[11px]">
            <tbody>
              {ZONE_ROWS.map(({ zone, label }) => (
                <tr key={zone} data-testid={`arrival-preview-${zone}`} className="border-t border-violet-50">
                  <td className="py-1 pr-3 font-mono whitespace-nowrap text-slate-800">{range(zone)}</td>
                  <td className="py-1 text-slate-600">{label}</td>
                  <td className="py-1 pl-3 text-right whitespace-nowrap font-semibold text-slate-800">
                    {shiftsFor(zone, arrival.quarterDeduction).toFixed(2)} shift
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1.5 text-[11px] text-slate-500">
            Shifts shown are for a day worked through to the evening; a first punch after {clock(limits.firstHalfUntil)}{" "}
            earns the Half Day once a punch at/after Second Half Start ({secondHalfStart || "-"}) is recorded.
          </p>
          {secondStart !== null && limits.firstHalfUntil >= secondStart && (
            <p
              role="alert"
              data-testid="arrival-preview-warning"
              className="mt-1 text-[11px] font-medium text-amber-700"
            >
              For this shift the first-half limit ({clock(limits.firstHalfUntil)}) is not before Second Half Start (
              {secondHalfStart}): a punch in between would count as both halves. Shorten a window or move Second Half
              Start later.
            </p>
          )}
        </>
      )}
    </div>
  );
}

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
import ProductionShiftConfigCard from "@/components/ProductionShiftConfigCard";

export default function AttendanceTab() {
  const { toast } = useToast();
  const updatePayrollSettings = useUpdatePayrollSettings();
  const { data: payrollSettingsData } = usePayrollSettings();

  // ── Attendance mode + production windows -loaded from DB ─────────────
  const [attMode, setAttMode] = useState({
    attendanceMode: "strict" as "strict" | "simple",
    simpleHalfShiftCutoff: "13:30",
    shiftPunctualityWindowMinutes: 60,
    permissionWindowMinutes: 60,
    afternoonLateWindowMinutes: 60,
    afternoonPermissionWindowMinutes: 60,
    afternoonLateCanCauseHalfShift: true,
    lastPunchPostShiftGraceHours: 9,
    firstPunchPreShiftBufferHours: 2,
    prodFirstHalfStart: "08:30",
    prodFirstHalfEnd: "12:30",
    prodSecondHalfStart: "13:30",
    prodSecondHalfEnd: "17:30",
    prodExtraStart: "17:50",
    prodExtraEnd: "20:00",
    halfShiftLateReferenceTime: "14:30",
    defaultShiftGraceMinutes: 15,
    defaultShiftFirstHalfEnd: "13:30",
    defaultShiftLunchDurationMinutes: 60,
    defaultShiftLunchGraceMinutes: 10,
  });

  // Attendance tab is split Staff / Production -Strict/Simple mode, the
  // punctuality window and the half-shift reference are all staff-only
  // concepts, so they live under Staff.
  const [attSubTab, setAttSubTab] = useState<"staff" | "production">("staff");

  useEffect(() => {
    if (!payrollSettingsData) return;
    setAttMode({
      attendanceMode: (payrollSettingsData.attendanceMode as "strict" | "simple") || "strict",
      simpleHalfShiftCutoff: payrollSettingsData.simpleHalfShiftCutoff || "13:30",
      shiftPunctualityWindowMinutes: payrollSettingsData.shiftPunctualityWindowMinutes ?? 60,
      permissionWindowMinutes: payrollSettingsData.permissionWindowMinutes ?? 60,
      afternoonLateWindowMinutes: payrollSettingsData.afternoonLateWindowMinutes ?? 60,
      afternoonPermissionWindowMinutes: payrollSettingsData.afternoonPermissionWindowMinutes ?? 60,
      afternoonLateCanCauseHalfShift: payrollSettingsData.afternoonLateCanCauseHalfShift ?? true,
      lastPunchPostShiftGraceHours: payrollSettingsData.lastPunchPostShiftGraceHours ?? 9,
      firstPunchPreShiftBufferHours: payrollSettingsData.firstPunchPreShiftBufferHours ?? 2,
      prodFirstHalfStart: payrollSettingsData.prodFirstHalfStart || "08:30",
      prodFirstHalfEnd: payrollSettingsData.prodFirstHalfEnd || "12:30",
      prodSecondHalfStart: payrollSettingsData.prodSecondHalfStart || "13:30",
      prodSecondHalfEnd: payrollSettingsData.prodSecondHalfEnd || "17:30",
      prodExtraStart: payrollSettingsData.prodExtraStart || "17:50",
      prodExtraEnd: payrollSettingsData.prodExtraEnd || "20:00",
      halfShiftLateReferenceTime: payrollSettingsData.halfShiftLateReferenceTime || "14:30",
      defaultShiftGraceMinutes: payrollSettingsData.defaultShiftGraceMinutes ?? 15,
      defaultShiftFirstHalfEnd: payrollSettingsData.defaultShiftFirstHalfEnd || "13:30",
      defaultShiftLunchDurationMinutes: payrollSettingsData.defaultShiftLunchDurationMinutes ?? 60,
      defaultShiftLunchGraceMinutes: payrollSettingsData.defaultShiftLunchGraceMinutes ?? 10,
    });
  }, [payrollSettingsData]);

  const saveAttendanceMode = async () => {
    try {
      await updatePayrollSettings.mutateAsync({
        attendanceMode: attMode.attendanceMode,
        simpleHalfShiftCutoff: attMode.simpleHalfShiftCutoff,
        shiftPunctualityWindowMinutes: attMode.shiftPunctualityWindowMinutes,
        permissionWindowMinutes: attMode.permissionWindowMinutes,
        afternoonLateWindowMinutes: attMode.afternoonLateWindowMinutes,
        afternoonPermissionWindowMinutes: attMode.afternoonPermissionWindowMinutes,
        afternoonLateCanCauseHalfShift: attMode.afternoonLateCanCauseHalfShift,
        lastPunchPostShiftGraceHours: attMode.lastPunchPostShiftGraceHours,
        firstPunchPreShiftBufferHours: attMode.firstPunchPreShiftBufferHours,
        prodFirstHalfStart: attMode.prodFirstHalfStart,
        prodFirstHalfEnd: attMode.prodFirstHalfEnd,
        prodSecondHalfStart: attMode.prodSecondHalfStart,
        prodSecondHalfEnd: attMode.prodSecondHalfEnd,
        prodExtraStart: attMode.prodExtraStart,
        prodExtraEnd: attMode.prodExtraEnd,
        halfShiftLateReferenceTime: attMode.halfShiftLateReferenceTime,
        defaultShiftGraceMinutes: attMode.defaultShiftGraceMinutes,
        defaultShiftFirstHalfEnd: attMode.defaultShiftFirstHalfEnd,
        defaultShiftLunchDurationMinutes: attMode.defaultShiftLunchDurationMinutes,
        defaultShiftLunchGraceMinutes: attMode.defaultShiftLunchGraceMinutes,
      } as never);
      toast({
        title: "Attendance settings saved",
        description: `Mode: ${attMode.attendanceMode === "simple" ? "Simple (morning + evening punch)" : "Strict (4-punch engine)"}. Applies to new calculations.`,
      });
    } catch {
      toast({ title: "Failed to save attendance settings", variant: "destructive" });
    }
  };

  return (
    <>
      {/* Staff / Production split -Strict/Simple mode, the punctuality
                window, night relaxation and the half-shift reference are all
                staff-only concepts, so they live under Staff. Production has
                its own segment-based engine with no mode switch. */}
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
                <p className="font-bold text-slate-800 mb-1">Shared by both modes -the Full vs Half Shift decision</p>
                <p>
                  A <strong>Full Shift</strong> needs a first punch <em>and</em> a distinct last punch, and both must
                  fall within the <strong>Shift Punctuality Window</strong> (below) of the employee's assigned shift
                  start/end time. Only one punch, or punching outside that window, caps the day at{" "}
                  <strong>Half Shift</strong>. Shift start/end and the small grace period come from the shift assigned
                  to each employee in <strong>Manage Shift</strong> — an employee with no assigned shift has no
                  reference, so this never applies to them.
                </p>
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                <div className="p-3 rounded-lg bg-white border border-amber-200">
                  <p className="font-bold text-amber-800 mb-1">Strict Mode</p>
                  <p>
                    Expects all 4 punches -morning IN, lunch OUT, lunch return, evening OUT. On top of the shared
                    decision above it <strong>additionally tracks lunch-return lateness</strong>. Choose this when you
                    need to police the lunch break.
                  </p>
                </div>
                <div className="p-3 rounded-lg bg-white border border-green-200">
                  <p className="font-bold text-green-800 mb-1">Simple Mode</p>
                  <p>
                    Only the first and last punch of the day matter -<strong>no lunch tracking at all</strong>.
                    Everything else behaves exactly as in Strict Mode. Choose this when the lunch break isn't punched or
                    isn't policed.
                  </p>
                </div>
              </div>
              <div className="p-3 rounded-lg bg-white border border-indigo-200">
                <p className="font-bold text-indigo-800 mb-1">Night Shift Relaxation</p>
                <p>
                  Not a timing rule -it's a <strong>feature switch</strong>. When on, the Night Shift page appears in
                  the sidebar, where you grant relaxation to individual employees who worked late the previous night so
                  their next-morning arrival isn't penalised. Turning it off only hides that page; it doesn't change any
                  calculation on its own.
                </p>
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
                    Tracks all 4 punches: morning IN, lunch OUT, lunch return, evening OUT. Half shift from missing
                    punches, and applies the 3-free-late penalty rule.
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
                    Morning punch + evening last punch = full shift. No lunch-break tracking. Late = morning punch
                    beyond grace period. Early leave is flagged.
                  </p>
                </button>
              </div>

              {/* Both modes now share the same Full/Half Shift decision -a first
                    AND a distinct last punch, both within the punctuality window
                    below of the employee's assigned shift start/end time. Strict
                    mode additionally tracks lunch-return lateness on top of this. */}
              <div className="grid sm:grid-cols-2 gap-4 p-3 bg-amber-50/50 border border-amber-100 rounded-lg">
                <div className="space-y-1.5">
                  <Label className="text-xs">Shift Punctuality Window -Maximum First Punch Allowed (minutes)</Label>
                  <p className="text-[11px] text-gray-500 -mt-1">
                    First punch must be within this many minutes of shift start (and last punch within the same window
                    of shift end) to still count as Full Shift
                  </p>
                  <Input
                    type="number"
                    min={0}
                    step={5}
                    value={attMode.shiftPunctualityWindowMinutes}
                    onChange={(e) =>
                      setAttMode((a) => ({
                        ...a,
                        shiftPunctualityWindowMinutes: Math.max(0, Number(e.target.value) || 0),
                      }))
                    }
                    className="max-w-[140px]"
                  />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <p className="text-[11px] text-gray-500">
                    Applies to every employee, every day -arriving within this window still counts toward a Full Shift
                    (though it's flagged <strong>Late</strong> once past the shift's own small Grace Period, set per
                    shift in <strong>Manage Shift</strong>). Only arriving <strong>past this window</strong> caps the
                    day at Half Shift. Applies to both calculation modes, staff only. Shift start/end times and grace
                    period always come from the shift assigned to each employee -an employee with no shift assigned has
                    no reference to check against, so this never applies to them.
                  </p>
                </div>
              </div>

              {/* Auto-Permission zone -inserted between the punctuality window above
                    and Half Shift. A first/last punch past the window but still inside
                    this extra width is auto-detected Permission instead of Half Shift,
                    purely from punch timing (see Late Detection tab for the daily/weekly
                    caps and the With/Without Permission split). */}
              <div className="grid sm:grid-cols-2 gap-4 p-3 bg-emerald-50/50 border border-emerald-100 rounded-lg">
                <div className="space-y-1.5">
                  <Label className="text-xs">Permission Zone Width -Morning/Departure (minutes)</Label>
                  <p className="text-[11px] text-gray-500 -mt-1">
                    Extra minutes past the punctuality window above during which a late arrival or early departure is
                    auto-detected as <strong>Permission</strong> instead of Half Shift.
                  </p>
                  <Input
                    type="number"
                    min={0}
                    step={5}
                    value={attMode.permissionWindowMinutes}
                    onChange={(e) =>
                      setAttMode((a) => ({ ...a, permissionWindowMinutes: Math.max(0, Number(e.target.value) || 0) }))
                    }
                    className="max-w-[140px]"
                  />
                </div>
                <div className="space-y-1.5 sm:col-span-2 border-t border-emerald-200 pt-3">
                  <p className="text-[11px] font-semibold text-emerald-900">
                    Afternoon (Night Late) -lunch return, strict mode only
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
                <div className="flex items-center justify-between sm:col-span-2 bg-white rounded-lg border border-emerald-100 p-3">
                  <div>
                    <Label className="text-xs">Night Late Can Cause Half Shift</Label>
                    <p className="text-[11px] text-gray-500">
                      When off, a very late lunch return is only ever flagged -it never demotes the day to Half Shift on
                      its own.
                    </p>
                  </div>
                  <Switch
                    checked={attMode.afternoonLateCanCauseHalfShift}
                    onCheckedChange={(v) => setAttMode((a) => ({ ...a, afternoonLateCanCauseHalfShift: v }))}
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
                      Historical only -no longer used for new calculations since the punctuality window above replaced
                      it. Kept only for reference.
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

              {/* Half Shift late reference -was a hardcoded 14:30 constant
                    in the engine until it became configurable here. */}
              <div className="grid sm:grid-cols-2 gap-4 p-3 bg-rose-50/50 border border-rose-100 rounded-lg">
                <div className="space-y-1.5">
                  <Label className="text-xs">Half Shift -Late Reference Time</Label>
                  <p className="text-[11px] text-gray-500 -mt-1">
                    On a day that already resolved to Half Shift, the arrival is flagged
                    <strong> Late</strong> only if the first punch is strictly after this time. An afternoon half-shift
                    that starts on time is a half day, not a late day.
                  </p>
                  <Input
                    type="time"
                    value={attMode.halfShiftLateReferenceTime}
                    onChange={(e) => setAttMode((a) => ({ ...a, halfShiftLateReferenceTime: e.target.value }))}
                    className="max-w-[140px]"
                  />
                </div>
                <div className="space-y-1.5">
                  <p className="text-[11px] text-gray-500">
                    Compared to the minute -a punch anywhere inside the reference minute counts as "on time", only the
                    next minute onward is Late. Full Shift days never use this; they use the shift's own start time +
                    grace period.
                  </p>
                </div>
              </div>

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

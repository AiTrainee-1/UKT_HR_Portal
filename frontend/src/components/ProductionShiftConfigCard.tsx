import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { Plus, Timer, Trash2 } from "lucide-react";
import {
  useProductionShiftConfig, useUpdateProductionShiftConfig,
  useCreateProductionShiftSegment, useUpdateProductionShiftSegment, useDeleteProductionShiftSegment,
  type ProductionShiftSegment as ProdSegment,
} from "@/lib/api-client/custom-hooks";

// Punch times + dynamic shift-value segments shared by ManageShift and Settings —
// production employees have no gender split, so a single config applies to everyone.
export default function ProductionShiftConfigCard() {
  const { toast } = useToast();
  const { data: config, isLoading } = useProductionShiftConfig();
  const updateConfig = useUpdateProductionShiftConfig();
  const createSegment = useCreateProductionShiftSegment();
  const updateSegment = useUpdateProductionShiftSegment();
  const deleteSegment = useDeleteProductionShiftSegment();

  const [punches, setPunches] = useState({ punch1Time: "08:30", punch2Time: "12:45", punch3Time: "13:30", punch4Time: "20:00", graceMinutes: 10 });
  const [loaded, setLoaded] = useState(false);
  if (config && !loaded) {
    setPunches({
      punch1Time: config.punch1Time, punch2Time: config.punch2Time,
      punch3Time: config.punch3Time, punch4Time: config.punch4Time,
      graceMinutes: config.graceMinutes,
    });
    setLoaded(true);
  }

  const savePunches = () => {
    updateConfig.mutate(punches, {
      onSuccess: () => toast({ title: "Punch times updated" }),
      onError: () => toast({ title: "Failed to update punch times", variant: "destructive" }),
    });
  };

  const segments = config?.segments ?? [];
  const totalShiftValue = segments.filter(s => s.isActive).reduce((sum, s) => sum + s.shiftValue, 0);

  const addSegment = () => {
    createSegment.mutate(
      { label: "New Segment", startTime: "08:30", endTime: "10:30", shiftValue: 0.25, order: segments.length + 1, isActive: true },
      { onError: () => toast({ title: "Failed to add segment", variant: "destructive" }) },
    );
  };

  return (
    <Card className="border-0 shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-bold flex items-center gap-2"><Timer size={15} /> Production Punch Times & Shift Segments</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Punch 1 (Arrival)</Label>
                <Input type="time" value={punches.punch1Time} onChange={(e) => setPunches((p) => ({ ...p, punch1Time: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Punch 2 (Lunch Out)</Label>
                <Input type="time" value={punches.punch2Time} onChange={(e) => setPunches((p) => ({ ...p, punch2Time: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Punch 3 (Lunch Return)</Label>
                <Input type="time" value={punches.punch3Time} onChange={(e) => setPunches((p) => ({ ...p, punch3Time: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Punch 4 (Departure)</Label>
                <Input type="time" value={punches.punch4Time} onChange={(e) => setPunches((p) => ({ ...p, punch4Time: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Grace (minutes)</Label>
                <Input type="number" value={punches.graceMinutes} onChange={(e) => setPunches((p) => ({ ...p, graceMinutes: Number(e.target.value) }))} />
              </div>
            </div>
            <Button size="sm" onClick={savePunches} disabled={updateConfig.isPending}>{updateConfig.isPending ? "Saving…" : "Save Punch Times"}</Button>

            <Separator />

            <div className="flex items-center justify-between">
              <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide">Shift-Value Segments (Total: {totalShiftValue.toFixed(2)})</p>
              <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={addSegment}><Plus size={12} /> Add Segment</Button>
            </div>

            <div className="space-y-2">
              {segments.map((seg) => (
                <SegmentRow
                  key={seg.id}
                  segment={seg}
                  onSave={(data) => updateSegment.mutate({ id: seg.id, data })}
                  onDelete={() => deleteSegment.mutate(seg.id)}
                />
              ))}
              {segments.length === 0 && (
                <p className="text-xs text-muted-foreground py-3 text-center">No segments configured yet.</p>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function SegmentRow({ segment, onSave, onDelete }: {
  segment: ProdSegment;
  onSave: (data: Partial<{ label: string; startTime: string; endTime: string; shiftValue: number; isActive: boolean }>) => void;
  onDelete: () => void;
}) {
  const [label, setLabel] = useState(segment.label);
  const [startTime, setStartTime] = useState(segment.startTime);
  const [endTime, setEndTime] = useState(segment.endTime);
  const [shiftValue, setShiftValue] = useState(segment.shiftValue);

  const dirty = label !== segment.label || startTime !== segment.startTime || endTime !== segment.endTime || shiftValue !== segment.shiftValue;

  return (
    <div className="flex items-center gap-2 p-2 rounded-md border bg-muted/20">
      <Input className="h-8 text-xs flex-1" value={label} onChange={(e) => setLabel(e.target.value)} />
      <Input className="h-8 text-xs w-28" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
      <span className="text-xs text-muted-foreground">–</span>
      <Input className="h-8 text-xs w-28" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
      <Input className="h-8 text-xs w-20" type="number" step="0.25" value={shiftValue} onChange={(e) => setShiftValue(Number(e.target.value))} />
      <div className="flex items-center gap-1.5 shrink-0" title={segment.isActive ? "Segment is counted in shift calculation — switch off to exclude it" : "Segment is EXCLUDED from shift calculation — switch on to count it"}>
        <Switch checked={segment.isActive} onCheckedChange={(v) => onSave({ isActive: v })} />
        <span className={`text-[10px] font-bold w-11 ${segment.isActive ? "text-green-600" : "text-red-500"}`}>
          {segment.isActive ? "ON" : "OFF"}
        </span>
      </div>
      {dirty && (
        <Button size="sm" className="h-8 text-xs" onClick={() => onSave({ label, startTime, endTime, shiftValue })}>Save</Button>
      )}
      <Button variant="ghost" size="icon" className="h-8 w-8 text-red-400 hover:text-red-600" onClick={onDelete}><Trash2 size={13} /></Button>
    </div>
  );
}

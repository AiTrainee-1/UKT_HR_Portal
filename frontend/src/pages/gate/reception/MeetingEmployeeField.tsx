import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useVisitorCheckEmployeePhone, type EmployeeContact } from "@/lib/api-client/custom-hooks";

/**
 * "Are you meeting a specific employee?" -> Yes: collects the employee's name + phone, resolves them against the HRMS
 * Employee table by phone (backend outpass_visitor_views.py::visitor_check_employee_phone, through the branch's visitor QR
 * token) and shows the matched person before the visit is recorded; that employee then gets an arrival notification
 * (email + WhatsApp). -> No: the free-text "whom are you meeting" as before.
 *
 * Shared by the visitor's own QR form (pages/gate/VisitorGate.tsx: its "New Visitor" and "Already Visited" steps), the
 * HR Register visitor dialog (Visitors page) and the reception desk's Register visitor (which passes `lookup`, its own
 * desk-authenticated call, instead of a QR token). The test ids are the QR form's.
 */
export function MeetingEmployeeField({
  token,
  whomToMeet,
  onWhomToMeetChange,
  onMeetingEmployeeIdChange,
  question = "Are you meeting a specific employee? *",
  whomLabel = "Whom are you meeting? *",
  unavailable = null,
  lookup,
}: {
  /** The branch's visitor QR token: the look-up is the QR form's own (not used when `lookup` is given). */
  token: string;
  whomToMeet: string;
  onWhomToMeetChange: (v: string) => void;
  onMeetingEmployeeIdChange: (id: number | undefined) => void;
  question?: string;
  whomLabel?: string;
  /** Why the look-up cannot run yet ("Choose the branch first."); the Look Up button then says so instead. */
  unavailable?: string | null;
  /** Looks the employee up by phone instead of the QR form's call (the reception desk sends its own token). */
  lookup?: (phone: string) => Promise<{ found: boolean; employee?: EmployeeContact }>;
}) {
  const [mode, setMode] = useState<"no" | "yes">("no");
  const [namePart, setNamePart] = useState("");
  const [phonePart, setPhonePart] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [matched, setMatched] = useState<EmployeeContact | null>(null);
  const [looking, setLooking] = useState(false);
  const checkMutation = useVisitorCheckEmployeePhone(token);

  const chooseMode = (next: "no" | "yes") => {
    setMode(next);
    setError(null);
    if (next === "no") {
      setMatched(null);
      onMeetingEmployeeIdChange(undefined);
      onWhomToMeetChange("");
    } else {
      onWhomToMeetChange(namePart);
    }
  };

  const changeName = (v: string) => {
    setNamePart(v);
    if (!matched) onWhomToMeetChange(v);
  };

  const showResult = (res: { found: boolean; employee?: EmployeeContact }) => {
    if (res.found && res.employee) {
      setMatched(res.employee);
      onMeetingEmployeeIdChange(res.employee.id);
      onWhomToMeetChange(res.employee.name);
    } else {
      setError("No employee found with this phone number. You can still continue with the name you entered.");
      setMatched(null);
      onMeetingEmployeeIdChange(undefined);
      onWhomToMeetChange(namePart);
    }
  };

  const runLookup = () => {
    setError(null);
    if (unavailable || (!lookup && !token)) {
      setError(unavailable ?? "The employee look-up is not available right now. Type the name instead.");
      return;
    }
    if (!phonePart.trim()) {
      setError("Please enter the employee's phone number.");
      return;
    }
    if (lookup) {
      setLooking(true);
      lookup(phonePart.trim())
        .then(showResult, () => setError("Could not verify right now. Please try again."))
        .finally(() => setLooking(false));
      return;
    }
    checkMutation.mutate(
      { phone: phonePart.trim() },
      { onSuccess: showResult, onError: () => setError("Could not verify right now. Please try again.") },
    );
  };
  const pending = looking || checkMutation.isPending;

  const clearMatch = () => {
    setMatched(null);
    onMeetingEmployeeIdChange(undefined);
    onWhomToMeetChange(namePart);
  };

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div>
        <p className="text-sm font-medium mb-1.5">{question}</p>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant={mode === "yes" ? "default" : "outline"}
            aria-pressed={mode === "yes"}
            onClick={() => chooseMode("yes")}
          >
            Yes
          </Button>
          <Button
            type="button"
            size="sm"
            variant={mode === "no" ? "default" : "outline"}
            aria-pressed={mode === "no"}
            onClick={() => chooseMode("no")}
          >
            No
          </Button>
        </div>
      </div>

      {mode === "no" ? (
        <div className="space-y-1.5">
          <Label htmlFor="meeting-whom">{whomLabel}</Label>
          <Input
            id="meeting-whom"
            value={whomToMeet}
            onChange={(e) => onWhomToMeetChange(e.target.value)}
            data-testid="input-whom-freetext"
          />
        </div>
      ) : matched ? (
        <div className="rounded-md border bg-muted/40 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="font-semibold truncate">{matched.name}</p>
              <p className="text-xs text-muted-foreground truncate">
                {matched.department ?? "—"}
                {matched.designation ? ` · ${matched.designation}` : ""}
              </p>
              {matched.phone && <p className="text-xs text-muted-foreground">{matched.phone}</p>}
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={clearMatch}>
              Change
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="space-y-1.5">
            <Label htmlFor="meeting-emp-name">Employee's name</Label>
            <Input
              id="meeting-emp-name"
              value={namePart}
              onChange={(e) => changeName(e.target.value)}
              placeholder="e.g. Priya Sharma"
              data-testid="input-meeting-emp-name"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="meeting-emp-phone">Employee's phone number *</Label>
            <div className="flex gap-2">
              <Input
                id="meeting-emp-phone"
                value={phonePart}
                onChange={(e) => setPhonePart(e.target.value)}
                placeholder="10-digit number"
                inputMode="tel"
                data-testid="input-meeting-emp-phone"
              />
              <Button type="button" onClick={runLookup} disabled={pending} data-testid="button-lookup-employee">
                {pending ? "Checking…" : "Look Up"}
              </Button>
            </div>
          </div>
          {error && (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

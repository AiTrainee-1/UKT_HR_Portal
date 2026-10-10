import { useState } from "react";
import {
  Download,
  Eye,
  FileClock,
  FileMinus,
  FileSignature,
  Info,
  Loader2,
  MessageCircle,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import {
  downloadDocumentPdf,
  previewDocumentPdf,
  useListResignations,
  useWhatsAppExperienceLetter,
  useWhatsAppResignation,
} from "@/lib/api-client/custom-hooks";
import { formatDate, parseYmd, todayYmd } from "../career/dates";
import { Chip } from "../career/parts";
import { lastDayBeforeJoining } from "./logic";

type Busy = "preview" | "download" | null;

type Props = {
  employeeId: number;
  joinDate?: string | null;
  designation?: string | null;
  department?: string | null;
  token: string | null;
};

const errorText = (err: unknown): string => {
  const e = err as { response?: { data?: { error?: string } }; message?: string };
  return e?.response?.data?.error || e?.message || "Unknown error";
};

/** The letters the system writes for an employee on demand: offer, experience and resignation. Nothing is stored. */
export default function LettersTab({ employeeId, joinDate, designation, department, token }: Props) {
  const { toast } = useToast();
  const [lastWorkingDay, setLastWorkingDay] = useState(() => todayYmd());
  const [offerBusy, setOfferBusy] = useState<Busy>(null);
  const [experienceBusy, setExperienceBusy] = useState<Busy>(null);
  const [resignationBusy, setResignationBusy] = useState<Busy>(null);
  const [experienceWhatsAppBusy, setExperienceWhatsAppBusy] = useState(false);
  const [resignationWhatsAppBusy, setResignationWhatsAppBusy] = useState(false);
  const whatsappExperienceMutation = useWhatsAppExperienceLetter();
  const whatsappResignationMutation = useWhatsAppResignation();

  const { data: approvedResignations, isLoading: resignationLoading } = useListResignations("approved");
  const resignation = (approvedResignations ?? []).find((r) => r.employeeId === employeeId) ?? null;

  const dateValid = parseYmd(lastWorkingDay) !== null;
  const beforeJoining = lastDayBeforeJoining(lastWorkingDay, joinDate);

  const generate = async (url: string, mode: "preview" | "download", setBusy: (b: Busy) => void, failure: string) => {
    setBusy(mode);
    try {
      if (mode === "preview") await previewDocumentPdf(url, () => token);
      else await downloadDocumentPdf(url, () => token);
    } catch {
      toast({ title: failure, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const sendExperienceWhatsApp = async () => {
    setExperienceWhatsAppBusy(true);
    try {
      const result = await whatsappExperienceMutation.mutateAsync({ employeeId, lastWorkingDate: lastWorkingDay });
      toast({ title: "Experience letter sent", description: `Delivered to ${result.sentTo} via WhatsApp.` });
    } catch (err) {
      toast({ title: "Failed to send via WhatsApp", description: errorText(err), variant: "destructive" });
    } finally {
      setExperienceWhatsAppBusy(false);
    }
  };

  const sendResignationWhatsApp = async () => {
    if (!resignation) return;
    setResignationWhatsAppBusy(true);
    try {
      const result = await whatsappResignationMutation.mutateAsync(resignation.id);
      toast({ title: "Resignation letter sent", description: `Delivered to ${result.sentTo} via WhatsApp.` });
    } catch (err) {
      toast({ title: "Failed to send via WhatsApp", description: errorText(err), variant: "destructive" });
    } finally {
      setResignationWhatsAppBusy(false);
    }
  };

  const generating = (busy: Busy, mode: "preview" | "download", idle: string) => (busy === mode ? "Generating…" : idle);

  return (
    <div className="space-y-3" data-testid="letters-tab">
      <p className="flex items-start gap-1.5 text-xs text-gray-500">
        <Info size={13} className="mt-0.5 shrink-0" />
        Letters are written when you ask for them, from the templates in Company Documents Settings and this employee's
        current details ({[designation, department].filter(Boolean).join(" · ") || "no designation or department"}
        {joinDate ? `, joined ${formatDate(joinDate)}` : ""}). Nothing is saved here.
      </p>
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="rounded-2xl">
          <CardContent className="flex h-full flex-col gap-3 p-4">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-50">
              <FileSignature size={16} className="text-indigo-600" />
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-800">Offer letter</p>
              <p className="mt-0.5 text-xs text-gray-400">
                Generated from current designation, department, and salary.
              </p>
            </div>
            <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={() =>
                  generate(
                    `/api/employees/${employeeId}/offer-letter/pdf`,
                    "preview",
                    setOfferBusy,
                    "Failed to generate Offer Letter",
                  )
                }
                disabled={offerBusy !== null}
                data-testid="offer-preview"
              >
                <Eye size={14} /> {generating(offerBusy, "preview", "Preview")}
              </Button>
              <Button
                size="sm"
                className="gap-1.5"
                onClick={() =>
                  generate(
                    `/api/employees/${employeeId}/offer-letter/pdf`,
                    "download",
                    setOfferBusy,
                    "Failed to generate Offer Letter",
                  )
                }
                disabled={offerBusy !== null}
                data-testid="offer-download"
              >
                <Download size={14} /> {generating(offerBusy, "download", "Download")}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-2xl">
          <CardContent className="flex h-full flex-col gap-3 p-4">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-50">
              <FileClock size={16} className="text-indigo-600" />
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-800">Experience letter</p>
              <div className="mt-2 space-y-1">
                <Label htmlFor="last-working-day" className="text-xs">
                  Last working day
                </Label>
                <Input
                  id="last-working-day"
                  type="date"
                  className="h-9"
                  value={lastWorkingDay}
                  onChange={(e) => setLastWorkingDay(e.target.value)}
                  aria-invalid={!dateValid || beforeJoining}
                  data-testid="last-working-day"
                />
                {!dateValid && (
                  <p className="flex items-start gap-1 text-xs text-red-600" role="alert">
                    <TriangleAlert size={12} className="mt-0.5 shrink-0" /> Pick the last working day.
                  </p>
                )}
                {dateValid && beforeJoining && (
                  <p className="flex items-start gap-1 text-xs text-amber-700" data-testid="before-joining-warning">
                    <TriangleAlert size={12} className="mt-0.5 shrink-0" /> That is before the joining date (
                    {formatDate(joinDate)}).
                  </p>
                )}
              </div>
            </div>
            <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={() =>
                  generate(
                    `/api/employees/${employeeId}/experience-letter/pdf?lastWorkingDate=${lastWorkingDay}`,
                    "preview",
                    setExperienceBusy,
                    "Failed to generate Experience Letter",
                  )
                }
                disabled={experienceBusy !== null || !dateValid}
                data-testid="experience-preview"
              >
                <Eye size={14} /> {generating(experienceBusy, "preview", "Preview")}
              </Button>
              <Button
                size="sm"
                className="gap-1.5"
                onClick={() =>
                  generate(
                    `/api/employees/${employeeId}/experience-letter/pdf?lastWorkingDate=${lastWorkingDay}`,
                    "download",
                    setExperienceBusy,
                    "Failed to generate Experience Letter",
                  )
                }
                disabled={experienceBusy !== null || !dateValid}
                data-testid="experience-download"
              >
                <Download size={14} /> {generating(experienceBusy, "download", "Download")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 border-emerald-200 text-emerald-700 hover:bg-emerald-50"
                onClick={sendExperienceWhatsApp}
                disabled={experienceWhatsAppBusy || !dateValid}
                data-testid="experience-whatsapp"
              >
                {experienceWhatsAppBusy ? <Loader2 size={14} className="animate-spin" /> : <MessageCircle size={14} />}
                {experienceWhatsAppBusy ? "Sending…" : "WhatsApp"}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-2xl">
          <CardContent className="flex h-full flex-col gap-3 p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-50">
                <FileMinus size={16} className="text-indigo-600" />
              </div>
              {!resignationLoading &&
                (resignation ? (
                  <Chip className="border-emerald-200 bg-emerald-50 text-emerald-700">Resignation approved</Chip>
                ) : (
                  <Chip className="border-gray-200 bg-gray-50 text-gray-500">No approved resignation</Chip>
                ))}
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-800">Resignation letter</p>
              <p className="mt-0.5 text-xs text-gray-400">
                {resignation
                  ? `Acceptance letter for this employee's approved resignation${resignation.lastWorkingDate ? ` (last working day ${formatDate(resignation.lastWorkingDate)})` : ""}.`
                  : "Available once this employee's resignation is approved."}
              </p>
            </div>
            <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={() =>
                  resignation &&
                  generate(
                    `/api/recruitment/resignations/${resignation.id}/pdf`,
                    "preview",
                    setResignationBusy,
                    "Failed to generate Resignation Letter",
                  )
                }
                disabled={!resignation || resignationBusy !== null}
                data-testid="resignation-preview"
              >
                <Eye size={14} /> {generating(resignationBusy, "preview", "Preview")}
              </Button>
              <Button
                size="sm"
                className="gap-1.5"
                onClick={() =>
                  resignation &&
                  generate(
                    `/api/recruitment/resignations/${resignation.id}/pdf`,
                    "download",
                    setResignationBusy,
                    "Failed to generate Resignation Letter",
                  )
                }
                disabled={!resignation || resignationBusy !== null}
                data-testid="resignation-download"
              >
                <Download size={14} /> {generating(resignationBusy, "download", "Download")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 border-emerald-200 text-emerald-700 hover:bg-emerald-50"
                onClick={sendResignationWhatsApp}
                disabled={!resignation || resignationWhatsAppBusy}
                data-testid="resignation-whatsapp"
              >
                {resignationWhatsAppBusy ? <Loader2 size={14} className="animate-spin" /> : <MessageCircle size={14} />}
                {resignationWhatsAppBusy ? "Sending…" : "WhatsApp"}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

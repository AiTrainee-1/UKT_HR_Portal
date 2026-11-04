import { useMemo, useState } from "react";
import { Copy, FileImage, FileText, Loader2, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { VIEW_SAFE_ATTR } from "@/lib/view-only-lock";
import { canShareFile, copyText, type ShareOutcome } from "./export";

type Format = "png" | "pdf";

/**
 * Share the board: the picture or the PDF through the browser's share sheet (a phone: WhatsApp, mail, Drive ...). A browser
 * that cannot hand a file to another app downloads it instead, and the summary text below is there to paste beside it.
 * Sharing only reads, so the dialog is view-safe.
 */
export default function ShareDialog({
  open,
  onClose,
  summary,
  onShare,
}: {
  open: boolean;
  onClose: () => void;
  /** The WhatsApp-ready text (hods/logic shareSummary). */
  summary: string;
  /** Builds the file and shares (or downloads) it. */
  onShare: (format: Format) => Promise<ShareOutcome>;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<Format | null>(null);
  // whether this browser can share files at all: a phone usually can, most desktop browsers cannot
  const shareable = useMemo(
    () => (typeof File === "function" ? canShareFile(new File(["x"], "board.png", { type: "image/png" })) : false),
    [],
  );

  const share = async (format: Format) => {
    if (busy) return;
    setBusy(format);
    try {
      const outcome = await onShare(format);
      if (outcome === "downloaded") {
        toast({
          title: format === "png" ? "Picture downloaded" : "PDF downloaded",
          description: "Attach it in WhatsApp or mail, and paste the summary with it.",
        });
      } else if (outcome === "shared") {
        onClose();
      }
    } catch (err) {
      toast({
        title: "Could not share",
        description: err instanceof Error ? err.message : "Something went wrong while making the file.",
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  const copy = async () => {
    const ok = await copyText(summary);
    toast(
      ok
        ? { title: "Summary copied", description: "Paste it into WhatsApp." }
        : { title: "Could not copy", description: "Select the text and copy it by hand.", variant: "destructive" },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-lg" data-testid="hod-share" {...{ [VIEW_SAFE_ATTR]: "" }}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Share2 size={18} className="text-indigo-600" aria-hidden /> Share the HoD board
          </DialogTitle>
          <DialogDescription>
            {shareable
              ? "Opens your phone's share sheet with the file: pick WhatsApp, mail or any other app."
              : "This browser cannot hand a file to another app: the file is downloaded instead. Attach it in WhatsApp, and paste the summary with it."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Button
            variant="outline"
            className="h-11 justify-start gap-2 border-indigo-200 text-indigo-700 hover:bg-indigo-50"
            onClick={() => void share("png")}
            disabled={busy !== null}
            data-testid="hod-share-png"
          >
            {busy === "png" ? <Loader2 size={15} className="animate-spin" /> : <FileImage size={15} />}
            {shareable ? "Share picture (PNG)" : "Download picture (PNG)"}
          </Button>
          <Button
            variant="outline"
            className="h-11 justify-start gap-2 border-red-200 text-red-700 hover:bg-red-50"
            onClick={() => void share("pdf")}
            disabled={busy !== null}
            data-testid="hod-share-pdf"
          >
            {busy === "pdf" ? <Loader2 size={15} className="animate-spin" /> : <FileText size={15} />}
            {shareable ? "Share PDF" : "Download PDF"}
          </Button>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="hod-share-summary" className="text-xs font-semibold text-gray-700">
            Summary for WhatsApp
          </label>
          <Textarea
            id="hod-share-summary"
            value={summary}
            readOnly
            rows={8}
            className="font-mono text-xs"
            data-testid="hod-share-summary"
          />
          <Button variant="secondary" className="w-full gap-2" onClick={() => void copy()} data-testid="hod-share-copy">
            <Copy size={14} /> Copy summary
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

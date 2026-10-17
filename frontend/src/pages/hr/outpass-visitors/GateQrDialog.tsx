import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Download, QrCode as QrCodeIcon } from "lucide-react";

// ── Gate QR ───────────────────────────────────────────────────────────────

export function GateQrDialog({
  kind,
  token,
  branchName,
}: {
  kind: "outpass" | "visitor";
  token?: string;
  branchName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [qrImage, setQrImage] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !token) return;
    let cancelled = false;
    const url = `${window.location.origin}/gate/${kind}/${token}`;
    QRCode.toDataURL(url, { width: 220, margin: 1, color: { dark: "#0f172a", light: "#ffffff" } }).then((img) => {
      if (!cancelled) setQrImage(img);
    });
    return () => {
      cancelled = true;
    };
  }, [open, token, kind]);

  const download = () => {
    if (!qrImage) return;
    const a = document.createElement("a");
    a.href = qrImage;
    a.download = `${kind}-gate-qr${branchName ? `-${branchName.toLowerCase().replace(/\s+/g, "-")}` : ""}.png`;
    a.click();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="outline" size="sm" className="gap-1.5" disabled={!token} onClick={() => setOpen(true)}>
        <QrCodeIcon size={14} /> Gate QR
      </Button>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {kind === "outpass" ? "Outpass" : "Visitor"} Gate QR{branchName ? ` — ${branchName}` : ""}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3 py-2">
          {qrImage ? (
            <img src={qrImage} alt="Gate QR code" className="rounded-lg border" width={220} height={220} />
          ) : (
            <div className="h-[220px] w-[220px] rounded-lg border bg-gray-50 animate-pulse" />
          )}
          <Button variant="outline" size="sm" className="gap-1.5" disabled={!qrImage} onClick={download}>
            <Download size={14} /> Download QR
          </Button>
          <p className="text-xs text-muted-foreground text-center max-w-xs">
            This QR is permanent for this branch — print it once and reuse it at the gate. Scanning it opens the{" "}
            {kind === "outpass" ? "outpass" : "visitor"} form on any phone, no login required.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

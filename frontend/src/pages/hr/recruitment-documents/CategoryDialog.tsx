import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Download, Eye, FileImage, FileText, Loader2, MessageCircle, Trash2, Upload } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  downloadDocumentPdf,
  EMPLOYEE_DOCUMENT_CATEGORIES,
  previewDocumentPdf,
  useDeleteEmployeeDocument,
  useUploadEmployeeDocument,
  useWhatsAppEmployeeDocument,
  type EmployeeDocumentCategory,
  type EmployeeDocumentItem,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { formatDate } from "../career/dates";
import { checkUpload, MAX_UPLOAD_BYTES } from "./logic";

type Props = {
  employeeId: number;
  employeeName: string;
  category: EmployeeDocumentCategory;
  documents: EmployeeDocumentItem[];
  token: string | null;
  onClose: () => void;
};

const COMPLETION_STATS_KEY = ["/api/recruitment/employee-documents/completion-stats"];

const isImage = (name: string) => /\.(jpe?g|png)$/i.test(name);

const errorText = (err: unknown): string => {
  const e = err as { response?: { data?: { error?: string } }; message?: string };
  return e?.response?.data?.error || e?.message || "Unknown error";
};

/** The files in one category for one employee: view, download, send on WhatsApp, delete, and upload more. */
export default function CategoryDialog({ employeeId, employeeName, category, documents, token, onClose }: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [whatsappBusyId, setWhatsappBusyId] = useState<number | null>(null);
  const [toDelete, setToDelete] = useState<EmployeeDocumentItem | null>(null);
  const uploadMutation = useUploadEmployeeDocument();
  const deleteMutation = useDeleteEmployeeDocument();
  const whatsappMutation = useWhatsAppEmployeeDocument();
  const label = EMPLOYEE_DOCUMENT_CATEGORIES.find((c) => c.value === category)?.label ?? category;

  async function uploadFiles(list: FileList | File[]) {
    const files = Array.from(list);
    if (files.length === 0) return;
    // The server's own checks, made first so a wrong file is explained without a round trip.
    const rejected = files.map((f) => checkUpload(f)).filter((m): m is string => m !== null);
    const accepted = files.filter((f) => checkUpload(f) === null);
    setProblems(rejected);
    if (accepted.length === 0) return;
    setUploading(true);
    const failed: string[] = [];
    let done = 0;
    for (const file of accepted) {
      try {
        await uploadMutation.mutateAsync({ employeeId, category, file });
        done += 1;
      } catch (err) {
        failed.push(`"${file.name}": ${errorText(err)}`);
      }
    }
    setUploading(false);
    // the completion figures on the tracker move when a required document arrives (the upload hook only refreshes the file list)
    if (done > 0) queryClient.invalidateQueries({ queryKey: COMPLETION_STATS_KEY });
    if (failed.length) setProblems((p) => [...p, ...failed]);
    if (done > 0)
      toast({ title: done === 1 ? "Document uploaded" : `${done} documents uploaded`, description: accepted[0].name });
    if (failed.length && done === 0) toast({ title: "Upload failed", description: failed[0], variant: "destructive" });
  }

  async function handleView(doc: EmployeeDocumentItem) {
    try {
      await previewDocumentPdf(doc.fileUrl, () => token);
    } catch {
      toast({ title: "Failed to open document", variant: "destructive" });
    }
  }

  async function handleDownload(doc: EmployeeDocumentItem) {
    try {
      await downloadDocumentPdf(doc.fileUrl, () => token);
    } catch {
      toast({ title: "Failed to download document", variant: "destructive" });
    }
  }

  async function handleWhatsApp(doc: EmployeeDocumentItem) {
    setWhatsappBusyId(doc.id);
    try {
      const result = await whatsappMutation.mutateAsync(doc.id);
      toast({ title: "Sent via WhatsApp", description: `Delivered to ${result.sentTo}` });
    } catch (err) {
      toast({ title: "Failed to send via WhatsApp", description: errorText(err), variant: "destructive" });
    } finally {
      setWhatsappBusyId(null);
    }
  }

  async function handleDelete() {
    const doc = toDelete;
    setToDelete(null);
    if (!doc) return;
    setBusyId(doc.id);
    try {
      await deleteMutation.mutateAsync(doc.id);
      toast({ title: "Document deleted" });
    } catch {
      toast({ title: "Failed to delete document", variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg" data-testid="category-dialog">
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
          <DialogDescription>
            {employeeName} ·{" "}
            {documents.length === 0 ? "no files yet" : `${documents.length} file${documents.length === 1 ? "" : "s"}`}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-72 space-y-2 overflow-y-auto">
          {documents.length === 0 ? (
            <p className="py-4 text-center text-sm text-gray-400" data-testid="category-empty">
              No files uploaded yet.
            </p>
          ) : (
            documents.map((doc) => {
              const Icon = isImage(doc.originalFilename) ? FileImage : FileText;
              return (
                <div
                  key={doc.id}
                  className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"
                  data-testid={`doc-${doc.id}`}
                >
                  <Icon size={16} className="shrink-0 text-indigo-500" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{doc.originalFilename}</p>
                    <p className="truncate text-[11px] text-gray-400">
                      {doc.uploadedAt ? `Uploaded ${formatDate(doc.uploadedAt)}` : "Upload date unknown"}
                      {doc.uploadedBy ? ` by ${doc.uploadedBy}` : ""}
                    </p>
                  </div>
                  <button
                    onClick={() => handleView(doc)}
                    className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100"
                    title="View"
                    aria-label={`View ${doc.originalFilename}`}
                  >
                    <Eye size={14} />
                  </button>
                  <button
                    onClick={() => handleDownload(doc)}
                    className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100"
                    title="Download"
                    aria-label={`Download ${doc.originalFilename}`}
                  >
                    <Download size={14} />
                  </button>
                  <button
                    onClick={() => handleWhatsApp(doc)}
                    disabled={whatsappBusyId === doc.id}
                    className="rounded-md p-1.5 text-emerald-600 hover:bg-emerald-50 disabled:opacity-40"
                    title="Send via WhatsApp"
                    aria-label={`Send ${doc.originalFilename} via WhatsApp`}
                  >
                    {whatsappBusyId === doc.id ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <MessageCircle size={14} />
                    )}
                  </button>
                  <button
                    onClick={() => setToDelete(doc)}
                    disabled={busyId === doc.id}
                    className="rounded-md p-1.5 text-red-500 hover:bg-red-50 disabled:opacity-40"
                    title="Delete"
                    aria-label={`Delete ${doc.originalFilename}`}
                    data-testid={`doc-delete-${doc.id}`}
                  >
                    {busyId === doc.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                  </button>
                </div>
              );
            })
          )}
        </div>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".pdf,.jpg,.jpeg,.png"
          className="hidden"
          onChange={(e) => {
            const files = e.target.files ? Array.from(e.target.files) : [];
            e.target.value = "";
            void uploadFiles(files);
          }}
          data-testid="upload-input"
        />
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void uploadFiles(e.dataTransfer.files);
          }}
          className={cn(
            "flex flex-col items-center gap-2 rounded-xl border-2 border-dashed p-4 text-center transition-colors",
            dragging ? "border-indigo-400 bg-indigo-50" : "border-gray-200 bg-gray-50/50",
          )}
        >
          <Button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="gap-2"
            data-testid="upload-button"
          >
            {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            {uploading ? "Uploading…" : "Upload file"}
          </Button>
          <p className="text-xs text-gray-500">
            or drop files here · PDF, JPG or PNG, up to {MAX_UPLOAD_BYTES / 1024 / 1024} MB each
          </p>
        </div>
        {problems.length > 0 && (
          <ul className="space-y-0.5 text-xs text-red-600" role="alert" data-testid="upload-problems">
            {problems.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        )}
      </DialogContent>

      <AlertDialog open={toDelete !== null} onOpenChange={(o) => !o && setToDelete(null)}>
        <AlertDialogContent data-testid="delete-doc-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this file?</AlertDialogTitle>
            <AlertDialogDescription>
              {toDelete ? `"${toDelete.originalFilename}" will be removed from ${employeeName}'s ${label}.` : ""} This
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-red-600 text-white hover:bg-red-700"
              data-testid="delete-doc-yes"
            >
              Delete file
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}

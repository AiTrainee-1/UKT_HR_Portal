import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StatusBadge } from "@/components/ui/status-badge";
import { useToast } from "@/hooks/use-toast";
import { Paperclip, Pencil } from "lucide-react";
import {
  useGmailControlTemplates,
  useGmailTemplatePreview,
  useUpdateGmailControlTemplate,
  type GmailControlTemplate,
} from "@/lib/api-client/custom-hooks";
import { fmtDateTime, useDebounced } from "./shared";

function TemplateStatus({ t }: { t: GmailControlTemplate }) {
  if (!t.isEnabled) return <StatusBadge tone="neutral">Disabled</StatusBadge>;
  if (t.moduleEnabled === false) return <StatusBadge tone="warning">Module is OFF</StatusBadge>;
  return <StatusBadge tone="success">Active</StatusBadge>;
}

function EditDialog({ template, onClose }: { template: GmailControlTemplate; onClose: () => void }) {
  const { toast } = useToast();
  const update = useUpdateGmailControlTemplate();
  const previewer = useGmailTemplatePreview();
  const [subject, setSubject] = useState(template.subject);
  const [body, setBody] = useState(template.messageBody);
  const [enabled, setEnabled] = useState(template.isEnabled);
  const [preview, setPreview] = useState({
    subject: template.previewSubject,
    html: template.previewHtml,
    error: null as string | null,
  });
  // Where a clicked variable goes: whichever of the two boxes was used last.
  const [focus, setFocus] = useState<"subject" | "body">("body");
  const subjectInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const debouncedSubject = useDebounced(subject, 300);
  const debouncedBody = useDebounced(body, 300);

  useEffect(() => {
    setSubject(template.subject);
    setBody(template.messageBody);
    setEnabled(template.isEnabled);
  }, [template]);

  // Show the email exactly as it will read, with sample values, as HR types.
  useEffect(() => {
    previewer.mutate(
      { emailType: template.emailType, subject: debouncedSubject, messageBody: debouncedBody },
      { onSuccess: (r) => setPreview({ subject: r.subject, html: r.previewHtml, error: r.error }) },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSubject, debouncedBody, template.emailType]);

  const insert = (name: string) => {
    const token = `{{${name}}}`;
    if (focus === "subject") {
      // The details table only makes sense in the wording.
      if (name === "details") return;
      const el = subjectInput.current;
      const start = el?.selectionStart ?? subject.length;
      const end = el?.selectionEnd ?? subject.length;
      setSubject(subject.slice(0, start) + token + subject.slice(end));
      requestAnimationFrame(() => {
        el?.focus();
        el?.setSelectionRange(start + token.length, start + token.length);
      });
      return;
    }
    const el = textarea.current;
    const start = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? body.length;
    setBody(body.slice(0, start) + token + body.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const save = () =>
    update.mutate(
      { emailType: template.emailType, data: { subject, messageBody: body, isEnabled: enabled } },
      {
        onSuccess: () => {
          toast({ title: `${template.label} email saved` });
          onClose();
        },
        onError: (e) => toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" }),
      },
    );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-4xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{template.label}</DialogTitle>
          {template.description && <p className="text-xs text-gray-500">{template.description}</p>}
        </DialogHeader>
        <div className="grid md:grid-cols-2 gap-5">
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <p className="text-sm font-semibold">Send this email</p>
                <p className="text-xs text-gray-500">Turn off to stop this type going out, whatever else is on.</p>
              </div>
              <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Send this email" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="template-subject">
                Subject
              </Label>
              <Input
                id="template-subject"
                ref={subjectInput}
                value={subject}
                onFocus={() => setFocus("subject")}
                onChange={(e) => setSubject(e.target.value)}
                placeholder={template.defaultSubject}
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="template-body">
                Email text
              </Label>
              <Textarea
                id="template-body"
                ref={textarea}
                rows={11}
                value={body}
                onFocus={() => setFocus("body")}
                onChange={(e) => setBody(e.target.value)}
                placeholder={template.defaultMessage}
                className="font-mono text-xs"
              />
              <p className="text-[11px] text-gray-500">
                Leave a box blank to send the default. A blank line starts a new paragraph, and **double asterisks**
                make text bold. A line whose placeholders are all empty is left out. The colours and layout around your
                text stay the same for every email.
              </p>
            </div>
            {(template.variables.length > 0 || template.details.length > 0) && (
              <div className="space-y-1.5">
                <p className="text-xs font-semibold text-gray-500">
                  Insert a variable into the {focus === "subject" ? "subject" : "email text"}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {template.variables.map((v) => (
                    <button
                      key={v.name}
                      type="button"
                      onClick={() => insert(v.name)}
                      title={`${v.help} — e.g. ${v.sample || "(empty)"}`}
                      className="rounded-md border bg-slate-50 px-2 py-1 text-[11px] font-mono text-gray-700 hover:bg-emerald-50 hover:border-emerald-300"
                    >
                      {`{{${v.name}}}`}
                    </button>
                  ))}
                  {template.details.length > 0 && focus === "body" && (
                    <button
                      type="button"
                      onClick={() => insert("details")}
                      title={`Where the details table goes: ${template.details.map((d) => d.label).join(", ")}`}
                      className="rounded-md border border-dashed bg-slate-50 px-2 py-1 text-[11px] font-mono text-gray-700 hover:bg-emerald-50 hover:border-emerald-300"
                    >
                      {"{{details}}"}
                    </button>
                  )}
                </div>
                {template.details.length > 0 && (
                  <p className="text-[11px] text-gray-500">
                    <code>{"{{details}}"}</code> marks where the table of{" "}
                    {template.details.map((d) => d.label).join(", ")} goes; without it the table is added at the end.
                  </p>
                )}
              </div>
            )}
            {template.attachment && (
              <p className="text-[11px] text-gray-500 flex items-center gap-1.5">
                <Paperclip size={11} /> Attached automatically: {template.attachment}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <p className="text-xs font-semibold text-gray-500">Preview (sample values)</p>
            <div className="rounded-lg border bg-white overflow-hidden">
              <p className="px-3 py-2 text-xs border-b bg-slate-50" data-testid="template-preview-subject">
                <span className="text-gray-400">Subject: </span>
                <span className="font-semibold text-gray-800">{preview.subject}</span>
              </p>
              <iframe
                title={`${template.label} email preview`}
                srcDoc={preview.html}
                sandbox=""
                className="w-full h-[26rem] bg-white"
                data-testid="template-preview"
              />
            </div>
            {preview.error && (
              <p className="text-[11px] text-red-700" role="alert">
                {preview.error}
              </p>
            )}
          </div>
        </div>
        <DialogFooter className="gap-2">
          {(body || subject) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setBody("");
                setSubject("");
              }}
            >
              Use defaults
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={update.isPending}>
            {update.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function TemplatesTab() {
  const { data, isLoading } = useGmailControlTemplates();
  const [editing, setEditing] = useState<GmailControlTemplate | null>(null);

  if (isLoading || !data) return <Skeleton className="h-96 rounded-2xl" />;

  // Groups in the order the server lists them, one per module.
  const groups = Array.from(new Map(data.map((t) => [t.category, t.categoryLabel])).entries());

  return (
    <div className="space-y-5">
      <p className="text-xs text-gray-500">
        The subject and text of every email the HRMS sends, in one place. Use variables such as{" "}
        <code>{"{{employee_name}}"}</code> where the recipient's name, dates and so on should appear; the editor lists
        the ones each email has and shows a live preview of the finished email. Attachments (the salary slip, the
        letter) are added automatically.
      </p>
      {groups.map(([category, label]) => {
        const rows = data.filter((t) => t.category === category);
        return (
          <div key={category}>
            <p className="text-xs font-bold uppercase tracking-wide text-gray-500 mb-2">{label}</p>
            <div className="rounded-xl border bg-white overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-gray-500">
                  <tr className="text-left">
                    <th className="px-3 py-2 font-semibold">Email</th>
                    <th className="px-3 py-2 font-semibold">Status</th>
                    <th className="px-3 py-2 font-semibold">Wording</th>
                    <th className="px-3 py-2 font-semibold text-right">Sent</th>
                    <th className="px-3 py-2 font-semibold text-right">Failed</th>
                    <th className="px-3 py-2 font-semibold">Last email</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((t) => (
                    <tr key={t.emailType} className="border-t" data-testid={`template-${t.emailType}`}>
                      <td className="px-3 py-2">
                        <p className="font-semibold text-gray-800">{t.label}</p>
                        {t.description && <p className="text-[10px] text-gray-400 max-w-md">{t.description}</p>}
                      </td>
                      <td className="px-3 py-2">
                        <TemplateStatus t={t} />
                      </td>
                      <td className="px-3 py-2">
                        {t.customised ? (
                          <Badge variant="outline" className="text-[10px]">
                            Customised
                          </Badge>
                        ) : (
                          <span className="text-gray-400">Default</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{t.total}</td>
                      <td
                        className={`px-3 py-2 text-right tabular-nums ${t.failed ? "text-red-600 font-semibold" : "text-gray-400"}`}
                      >
                        {t.failed}
                      </td>
                      <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{fmtDateTime(t.lastSentAt)}</td>
                      <td className="px-3 py-2 text-right">
                        <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={() => setEditing(t)}>
                          <Pencil size={11} /> Edit
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
      {editing && <EditDialog template={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

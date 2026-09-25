import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StatusBadge } from "@/components/ui/status-badge";
import { useToast } from "@/hooks/use-toast";
import { Pencil } from "lucide-react";
import {
  useUpdateWhatsAppControlTemplate,
  useWhatsAppControlTemplates,
  useWhatsAppTemplatePreview,
  type WhatsAppControlTemplate,
} from "@/lib/api-client/custom-hooks";
import { fmtDateTime, useDebounced } from "./shared";

/** Shows text the way WhatsApp does: *bold* and _italic_ instead of the raw marks. */
function WhatsAppText({ text }: { text: string }) {
  const parts = text.split(/(\*[^*\n]+\*|_[^_\n]+_)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.length > 2 && part.startsWith("*") && part.endsWith("*")) return <b key={i}>{part.slice(1, -1)}</b>;
        if (part.length > 2 && part.startsWith("_") && part.endsWith("_")) return <i key={i}>{part.slice(1, -1)}</i>;
        return part;
      })}
    </>
  );
}

function TemplateStatus({ t }: { t: WhatsAppControlTemplate }) {
  if (!t.isEnabled) return <StatusBadge tone="neutral">Disabled</StatusBadge>;
  if (t.moduleEnabled === false) return <StatusBadge tone="warning">Module is OFF</StatusBadge>;
  if (t.featureEnabled === false) return <StatusBadge tone="warning">Feature is OFF</StatusBadge>;
  return <StatusBadge tone="success">Active</StatusBadge>;
}

function EditDialog({ template, onClose }: { template: WhatsAppControlTemplate; onClose: () => void }) {
  const { toast } = useToast();
  const update = useUpdateWhatsAppControlTemplate();
  const previewer = useWhatsAppTemplatePreview();
  const [body, setBody] = useState(template.messageBody);
  const [enabled, setEnabled] = useState(template.isEnabled);
  const [preview, setPreview] = useState({ text: template.preview, error: null as string | null });
  const textarea = useRef<HTMLTextAreaElement>(null);
  const debouncedBody = useDebounced(body, 300);

  useEffect(() => {
    setBody(template.messageBody);
    setEnabled(template.isEnabled);
  }, [template]);

  // Show the wording exactly as it will read, with sample values, as HR types.
  useEffect(() => {
    previewer.mutate(
      { documentType: template.documentType, messageBody: debouncedBody },
      { onSuccess: (r) => setPreview({ text: r.preview, error: r.error }) },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedBody, template.documentType]);

  const insert = (name: string) => {
    const el = textarea.current;
    const token = `{{${name}}}`;
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
      { documentType: template.documentType, data: { messageBody: body, isEnabled: enabled } },
      {
        onSuccess: () => {
          toast({ title: `${template.label} message saved` });
          onClose();
        },
        onError: (e) => toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" }),
      },
    );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{template.label}</DialogTitle>
          {template.description && <p className="text-xs text-gray-500">{template.description}</p>}
        </DialogHeader>
        <div className="grid md:grid-cols-2 gap-5">
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <p className="text-sm font-semibold">Send this message</p>
                <p className="text-xs text-gray-500">Turn off to stop this type going out, whatever else is on.</p>
              </div>
              <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Send this message" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="template-body">
                Message text
              </Label>
              <Textarea
                id="template-body"
                ref={textarea}
                rows={11}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder={template.defaultMessage}
                className="font-mono text-xs"
              />
              <p className="text-[11px] text-gray-500">
                Leave blank to send the default text. *bold*, _italic_ and emojis work in WhatsApp. A line whose
                placeholders are all empty is left out.
              </p>
            </div>
            {template.variables.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-semibold text-gray-500">Insert a variable</p>
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
                </div>
              </div>
            )}
          </div>
          <div className="space-y-2">
            <p className="text-xs font-semibold text-gray-500">Preview (sample values)</p>
            <pre
              className="whitespace-pre-wrap rounded-lg bg-emerald-50 border border-emerald-100 p-3 text-xs text-gray-800 font-sans min-h-40 max-h-96 overflow-auto"
              data-testid="template-preview"
            >
              <WhatsAppText text={preview.text} />
            </pre>
            {preview.error && (
              <p className="text-[11px] text-red-700" role="alert">
                {preview.error}
              </p>
            )}
          </div>
        </div>
        <DialogFooter className="gap-2">
          {body && (
            <Button variant="ghost" size="sm" onClick={() => setBody("")}>
              Use default
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
  const { data, isLoading } = useWhatsAppControlTemplates();
  const [editing, setEditing] = useState<WhatsAppControlTemplate | null>(null);

  if (isLoading || !data) return <Skeleton className="h-96 rounded-2xl" />;

  // Groups in the order the server lists them, one per module.
  const groups = Array.from(new Map(data.map((t) => [t.category, t.categoryLabel])).entries());

  return (
    <div className="space-y-5">
      <p className="text-xs text-gray-500">
        The text of every message the HRMS sends, in one place. Messages go out through your linked WhatsApp number, so
        there are no templates to get approved — edit freely. Use variables such as <code>{"{{employee_name}}"}</code>{" "}
        or <code>{"{{date}}"}</code> where the employee's name, dates and so on should appear; the editor lists the ones
        each message has and shows a live preview.
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
                    <th className="px-3 py-2 font-semibold">Message</th>
                    <th className="px-3 py-2 font-semibold">Status</th>
                    <th className="px-3 py-2 font-semibold">Wording</th>
                    <th className="px-3 py-2 font-semibold text-right">Sent</th>
                    <th className="px-3 py-2 font-semibold text-right">Failed</th>
                    <th className="px-3 py-2 font-semibold">Last sent</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((t) => (
                    <tr key={t.documentType} className="border-t" data-testid={`template-${t.documentType}`}>
                      <td className="px-3 py-2">
                        <p className="font-semibold text-gray-800">{t.label}</p>
                        {t.description && <p className="text-[10px] text-gray-400 max-w-md">{t.description}</p>}
                      </td>
                      <td className="px-3 py-2">
                        <TemplateStatus t={t} />
                      </td>
                      <td className="px-3 py-2">
                        {!t.hasWording ? (
                          <span className="text-gray-400">Contact card</span>
                        ) : t.customised ? (
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
                        {t.hasWording && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 gap-1 text-xs"
                            onClick={() => setEditing(t)}
                          >
                            <Pencil size={11} /> Edit
                          </Button>
                        )}
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

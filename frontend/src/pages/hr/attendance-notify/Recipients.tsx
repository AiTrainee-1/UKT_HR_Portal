import { useState, type KeyboardEvent } from "react";
import {
  AlertTriangle,
  Bookmark,
  BookmarkPlus,
  Building2,
  Hash,
  Loader2,
  Phone,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Users,
  UsersRound,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import {
  useAttendanceNotifyChatChannels,
  useAttendanceNotifyRecipientLists,
  useAttendanceNotifyWhatsAppGroups,
  useDeleteAttendanceNotifyRecipientList,
  useRefreshAttendanceNotifyWhatsAppGroups,
  useSaveAttendanceNotifyRecipientList,
  type NotifyChatChannel,
  type NotifyRecipientList,
  type NotifyRecipientSet,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { addEmails, errorText, normalisePhone, phoneLabel, whenText } from "./logic";
import { Field, Segmented, ToggleRow } from "./parts";

type RecipientsProps = {
  value: NotifyRecipientSet;
  onChange: (patch: Partial<NotifyRecipientSet>) => void;
};

const toggleId = (ids: number[], id: number) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);

// ─── saved lists (WhatsApp numbers / email addresses) ─────────────────────────────────────────────────────────────

/**
 * The saved lists of a channel: pick any number of them (they are read when the automation sends, so a list changed later
 * is followed), save what is typed in as a new list, delete one (asked first).
 */
function SavedLists({
  channel,
  picked,
  onPick,
  canSave,
  itemsToSave,
  describe,
}: {
  channel: "whatsapp" | "email";
  picked: number[];
  onPick: (ids: number[]) => void;
  /** Something is typed in to save as a list. */
  canSave: boolean;
  itemsToSave: () => NotifyRecipientList["numbers"] | NotifyRecipientList["emails"];
  describe: (l: NotifyRecipientList) => string;
}) {
  const { toast } = useToast();
  const lists = useAttendanceNotifyRecipientLists(channel);
  const save = useSaveAttendanceNotifyRecipientList();
  const remove = useDeleteAttendanceNotifyRecipientList();
  const [name, setName] = useState("");
  const [confirming, setConfirming] = useState<number | null>(null);
  const items = lists.data ?? [];
  const missing = picked.filter((id) => lists.data && !items.some((l) => l.id === id));
  const what = channel === "whatsapp" ? "numbers" : "addresses";

  const saveList = async () => {
    try {
      const saved = await save.mutateAsync({ name: name.trim(), channel, items: itemsToSave() });
      setName("");
      toast({
        title: `List “${saved.name}” saved`,
        description: `Pick it in any ${channel === "whatsapp" ? "WhatsApp" : "Gmail"} automation. The ${what} typed here stay on this automation too.`,
      });
    } catch (err) {
      toast({ title: "Could not save the list", description: errorText(err), variant: "destructive" });
    }
  };

  const deleteList = async (l: NotifyRecipientList) => {
    try {
      await remove.mutateAsync(l.id);
      setConfirming(null);
      onPick(picked.filter((id) => id !== l.id));
      toast({ title: `List “${l.name}” deleted` });
    } catch (err) {
      toast({ title: "Could not delete the list", description: errorText(err), variant: "destructive" });
    }
  };

  return (
    <div className="space-y-2 rounded-xl border border-slate-100 bg-slate-50 p-3" data-testid={`an-lists-${channel}`}>
      <p className="flex items-center gap-1.5 text-xs font-semibold text-slate-700">
        <Bookmark size={13} /> Saved lists
      </p>
      {lists.isLoading ? (
        <p className="text-xs text-slate-500">Loading the saved lists…</p>
      ) : lists.isError ? (
        <p className="text-xs text-red-600">The saved lists could not be loaded.</p>
      ) : items.length === 0 ? (
        <p className="text-xs text-slate-500">
          No saved list yet. Type some {what} above, then save them as a list here.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {items.map((l) => {
            const on = picked.includes(l.id);
            return (
              <li key={l.id} className="flex items-center">
                {confirming === l.id ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-2.5 py-1 text-xs text-red-800">
                    Delete “{l.name}”? Automations using it stop sending to it.
                    <button
                      type="button"
                      onClick={() => void deleteList(l)}
                      disabled={remove.isPending}
                      className="font-bold underline"
                      data-testid={`an-list-delete-yes-${l.id}`}
                    >
                      Delete list
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirming(null)}
                      className="font-semibold text-slate-600"
                      data-view-safe
                    >
                      Keep
                    </button>
                  </span>
                ) : (
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full border text-xs font-semibold",
                      on ? "border-blue-600 bg-blue-600 text-white" : "border-slate-200 bg-white text-slate-700",
                    )}
                  >
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() => onPick(toggleId(picked, l.id))}
                      className="py-1 pl-2.5 pr-1.5"
                      title={describe(l)}
                      data-view-safe
                      data-testid={`an-list-${l.id}`}
                    >
                      {l.name} <span className={on ? "text-blue-100" : "text-slate-400"}>· {describe(l)}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirming(l.id)}
                      aria-label={`Delete the list ${l.name}`}
                      className={cn(
                        "rounded-full p-1 pr-2",
                        on ? "text-blue-100" : "text-slate-400 hover:text-red-600",
                      )}
                      data-testid={`an-list-delete-${l.id}`}
                    >
                      <Trash2 size={12} />
                    </button>
                  </span>
                )}
              </li>
            );
          })}
          {missing.map((id) => (
            <li key={id}>
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs text-amber-800">
                A list that no longer exists
                <button
                  type="button"
                  onClick={() => onPick(picked.filter((x) => x !== id))}
                  aria-label="Remove the missing list"
                  data-testid={`an-list-missing-${id}`}
                >
                  <X size={12} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name for a new list, e.g. HR team"
          className="h-8 w-56 bg-white text-xs"
          aria-label="Name of the new list"
          data-testid={`an-list-name-${channel}`}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 gap-1.5 bg-white"
          onClick={() => void saveList()}
          disabled={!canSave || !name.trim() || save.isPending}
          title={canSave ? undefined : `Type some ${what} above first`}
          data-testid={`an-list-save-${channel}`}
        >
          {save.isPending ? <Loader2 size={13} className="animate-spin" /> : <BookmarkPlus size={13} />}
          Save these {what} as a list
        </Button>
      </div>
    </div>
  );
}

// ─── WhatsApp ──────────────────────────────────────────────────────────────────────────────────────────────────────

export function WhatsAppRecipients({
  value,
  onChange,
  connectedNumber,
}: RecipientsProps & { connectedNumber: string }) {
  const [phone, setPhone] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [groupsAsked, setGroupsAsked] = useState(false);
  const [groupSearch, setGroupSearch] = useState("");
  const groups = useAttendanceNotifyWhatsAppGroups(groupsAsked);
  const refreshGroups = useRefreshAttendanceNotifyWhatsAppGroups();

  const addNumber = () => {
    const n = normalisePhone(phone);
    if (!phone.trim()) return setError("Type a number first.");
    if (!n)
      return setError(`“${phone.trim()}” is not a WhatsApp number. Use 10 digits (98765 43210) or +country code.`);
    if (value.numbers.some((x) => x.value === n)) return setError(`${phoneLabel(n)} is already on the list.`);
    if (connectedNumber && normalisePhone(connectedNumber) === n && value.connected)
      return setError("That is the connected number, which already gets the report.");
    onChange({ numbers: [...value.numbers, { value: n, label: label.trim() }] });
    setPhone("");
    setLabel("");
    setError(null);
  };
  const onEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addNumber();
    }
  };

  const data = groups.data;
  const pickedGroups = new Set(value.groups.map((g) => g.id));
  const shownGroups = (data?.groups ?? []).filter((g) =>
    g.name.toLowerCase().includes(groupSearch.trim().toLowerCase()),
  );
  const toggleGroup = (g: { id: string; name: string }) =>
    onChange({
      groups: pickedGroups.has(g.id)
        ? value.groups.filter((x) => x.id !== g.id)
        : [...value.groups, { id: g.id, name: g.name }],
    });

  return (
    <div className="space-y-4" data-testid="an-recipients-whatsapp">
      <ToggleRow
        id="an-connected"
        label="Also send to the connected WhatsApp number"
        hint={
          connectedNumber
            ? `The number the HRMS's WhatsApp is linked to: ${phoneLabel(connectedNumber)}.`
            : "No connected number is set yet: set it once on the WhatsApp tab."
        }
      >
        <Switch
          id="an-connected"
          checked={value.connected}
          onCheckedChange={(connected) => onChange({ connected })}
          data-testid="an-connected"
        />
      </ToggleRow>

      <Field
        label={`Numbers (${value.numbers.length})`}
        hint="Indian mobile numbers can be typed with or without +91. Give each a label so the history says who it was."
        error={error}
        testId="an-numbers"
      >
        {value.numbers.length > 0 && (
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
            {value.numbers.map((n) => {
              const bad = !normalisePhone(n.value);
              return (
                <li key={n.value} className="flex items-center gap-2 px-3 py-2" data-testid={`an-number-${n.value}`}>
                  <Phone size={13} className={bad ? "text-red-500" : "text-emerald-600"} aria-hidden />
                  <span className={cn("font-mono text-sm", bad ? "text-red-700" : "text-slate-900")}>
                    {phoneLabel(n.value)}
                  </span>
                  <Input
                    value={n.label}
                    onChange={(e) =>
                      onChange({
                        numbers: value.numbers.map((x) => (x.value === n.value ? { ...x, label: e.target.value } : x)),
                      })
                    }
                    placeholder="Label (optional)"
                    className="ml-auto h-7 w-40 text-xs"
                    aria-label={`Label for ${phoneLabel(n.value)}`}
                  />
                  <button
                    type="button"
                    onClick={() => onChange({ numbers: value.numbers.filter((x) => x.value !== n.value) })}
                    aria-label={`Remove ${phoneLabel(n.value)}`}
                    className="rounded-full p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                    data-testid={`an-number-remove-${n.value}`}
                  >
                    <X size={14} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={phone}
            onChange={(e) => {
              setPhone(e.target.value);
              setError(null);
            }}
            onKeyDown={onEnter}
            placeholder="98765 43210"
            inputMode="tel"
            className="h-9 w-44"
            aria-label="WhatsApp number"
            data-testid="an-number-input"
          />
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={onEnter}
            placeholder="Label, e.g. HR Manager"
            className="h-9 w-48"
            aria-label="Label for the number"
            data-testid="an-number-label"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 gap-1.5"
            onClick={addNumber}
            data-testid="an-number-add"
          >
            <Plus size={14} /> Add number
          </Button>
        </div>
      </Field>

      <SavedLists
        channel="whatsapp"
        picked={value.listIds}
        onPick={(listIds) => onChange({ listIds })}
        canSave={value.numbers.length > 0}
        itemsToSave={() => value.numbers}
        describe={(l) => `${l.numbers.length} number${l.numbers.length === 1 ? "" : "s"}`}
      />

      <div className="space-y-2" data-testid="an-groups">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-slate-700">
            <UsersRound size={13} /> WhatsApp groups ({value.groups.length})
          </p>
          {!groupsAsked ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 gap-1.5"
              onClick={() => setGroupsAsked(true)}
              data-view-safe
              data-testid="an-groups-load"
            >
              <Users size={13} /> Load WhatsApp groups
            </Button>
          ) : (
            data?.supported && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-8 gap-1.5 text-slate-600"
                onClick={() => refreshGroups.mutate()}
                disabled={refreshGroups.isPending}
                data-view-safe
                data-testid="an-groups-refresh"
              >
                <RefreshCw size={13} className={refreshGroups.isPending ? "animate-spin" : ""} /> Ask WhatsApp again
              </Button>
            )
          )}
        </div>
        {value.groups.length > 0 && (
          <ul className="flex flex-wrap gap-1.5">
            {value.groups.map((g) => (
              <li
                key={g.id}
                className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 py-0.5 pl-2.5 pr-1 text-xs font-semibold text-emerald-800"
              >
                {g.name}
                <button
                  type="button"
                  onClick={() => onChange({ groups: value.groups.filter((x) => x.id !== g.id) })}
                  aria-label={`Remove the group ${g.name}`}
                  className="rounded-full p-0.5 hover:bg-emerald-100"
                >
                  <X size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {!groupsAsked ? (
          <p className="text-[11px] text-slate-500">
            The groups are read from WhatsApp only when you ask (it can take a few seconds).
          </p>
        ) : groups.isLoading ? (
          <p className="flex items-center gap-1.5 text-xs text-slate-500">
            <Loader2 size={13} className="animate-spin" /> Asking WhatsApp for the groups…
          </p>
        ) : groups.isError ? (
          <p className="text-xs text-red-600" data-testid="an-groups-error">
            The groups could not be read: {errorText(groups.error) ?? "the server did not answer"}.
          </p>
        ) : data && !data.supported ? (
          <p
            className="flex items-start gap-1.5 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
            data-testid="an-groups-unsupported"
          >
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            {data.note || "WhatsApp groups are not available with the WhatsApp set up on this server."}
          </p>
        ) : data ? (
          <div className="space-y-2 rounded-xl border border-slate-200 bg-white p-2" data-testid="an-groups-picker">
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <Input
                value={groupSearch}
                onChange={(e) => setGroupSearch(e.target.value)}
                placeholder="Search groups"
                className="h-8 pl-7 text-xs"
                aria-label="Search groups"
              />
            </div>
            {data.groups.length === 0 ? (
              <p className="px-1 py-2 text-xs text-slate-500">
                {data.note || "The linked WhatsApp is not in any group."}
              </p>
            ) : (
              <ul className="max-h-56 space-y-0.5 overflow-y-auto">
                {shownGroups.map((g) => (
                  <li key={g.id}>
                    <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-slate-50">
                      <Checkbox
                        checked={pickedGroups.has(g.id)}
                        onCheckedChange={() => toggleGroup(g)}
                        data-testid={`an-group-${g.id}`}
                      />
                      <span className="min-w-0 flex-1 truncate">{g.name}</span>
                      {g.size !== null && <span className="text-[11px] text-slate-400">{g.size} members</span>}
                    </label>
                  </li>
                ))}
                {shownGroups.length === 0 && <li className="px-2 py-2 text-xs text-slate-500">No group matches.</li>}
              </ul>
            )}
            {data.fetchedAt && <p className="px-1 text-[10px] text-slate-400">Read {whenText(data.fetchedAt)}</p>}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ─── Gmail ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function AddressField({
  id,
  label,
  list,
  others,
  onChange,
  hint,
}: {
  id: "to" | "cc" | "bcc";
  label: string;
  list: string[];
  /** The addresses in the other two fields (an address goes in one of them only). */
  others: string[];
  onChange: (next: string[]) => void;
  hint?: string;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const commit = () => {
    if (!text.trim()) return;
    const next = addEmails(list, text, others);
    onChange(next.list);
    const problems = [
      next.invalid.length ? `Not an email address: ${next.invalid.join(", ")}.` : "",
      next.duplicates.length ? `Already added: ${next.duplicates.join(", ")}.` : "",
    ].filter(Boolean);
    setError(problems.length ? problems.join(" ") : null);
    // what could not be added stays in the box to be corrected
    setText(next.invalid.join(", "));
  };
  return (
    <Field label={label} htmlFor={`an-email-${id}`} error={error} hint={hint} testId={`an-email-${id}-field`}>
      <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-2 py-1.5 focus-within:ring-2 focus-within:ring-blue-500">
        {list.map((e) => (
          <span
            key={e}
            className="inline-flex items-center gap-1 rounded-full bg-rose-50 py-0.5 pl-2.5 pr-1 text-xs font-medium text-rose-800"
            data-testid={`an-email-${id}-chip`}
          >
            {e}
            <button
              type="button"
              onClick={() => onChange(list.filter((x) => x !== e))}
              aria-label={`Remove ${e}`}
              className="rounded-full p-0.5 hover:bg-rose-100"
            >
              <X size={11} />
            </button>
          </span>
        ))}
        <input
          id={`an-email-${id}`}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "," || e.key === ";") {
              e.preventDefault();
              commit();
            } else if (e.key === "Backspace" && !text && list.length) onChange(list.slice(0, -1));
          }}
          onBlur={commit}
          placeholder={list.length ? "" : "name@company.com, press Enter"}
          className="min-w-40 flex-1 bg-transparent text-sm outline-none"
          data-testid={`an-email-${id}`}
        />
      </div>
    </Field>
  );
}

export function EmailRecipients({
  value,
  onChange,
  emailFormat,
  attachPdf,
  subject,
  onEmailChange,
}: RecipientsProps & {
  emailFormat: "text" | "html";
  attachPdf: boolean;
  subject: string;
  onEmailChange: (patch: { emailFormat?: "text" | "html"; attachPdf?: boolean; subject?: string }) => void;
}) {
  const all = [...value.to, ...value.cc, ...value.bcc];
  const without = (l: string[]) => all.filter((e) => !l.includes(e));
  return (
    <div className="space-y-4" data-testid="an-recipients-email">
      <AddressField
        id="to"
        label="To"
        list={value.to}
        others={without(value.to)}
        onChange={(to) => onChange({ to })}
        hint="Type or paste addresses; a comma, Enter or leaving the box adds them."
      />
      <div className="grid gap-4 md:grid-cols-2">
        <AddressField
          id="cc"
          label="CC"
          list={value.cc}
          others={without(value.cc)}
          onChange={(cc) => onChange({ cc })}
        />
        <AddressField
          id="bcc"
          label="BCC"
          list={value.bcc}
          others={without(value.bcc)}
          onChange={(bcc) => onChange({ bcc })}
          hint="BCC addresses are not shown to the others."
        />
      </div>

      <SavedLists
        channel="email"
        picked={value.listIds}
        onPick={(listIds) => onChange({ listIds })}
        canSave={all.length > 0}
        itemsToSave={() => ({ to: value.to, cc: value.cc, bcc: value.bcc })}
        describe={(l) => {
          const n = l.emails.to.length + l.emails.cc.length + l.emails.bcc.length;
          return `${n} address${n === 1 ? "" : "es"}`;
        }}
      />

      <div className="space-y-3 rounded-xl border border-slate-100 p-3" data-testid="an-email-details">
        <p className="text-xs font-semibold text-slate-700">The email</p>
        <Field label="Format">
          <Segmented
            options={[
              { value: "html", label: "HTML report" },
              { value: "text", label: "Plain text body" },
            ]}
            value={emailFormat}
            onChange={(v) => onEmailChange({ emailFormat: v })}
            ariaLabel="Email format"
            testId="an-email-format"
          />
        </Field>
        <ToggleRow
          id="an-attach-pdf"
          label="Attach the report as a PDF"
          hint="The same report as a PDF file, handy to print or forward."
        >
          <Switch
            id="an-attach-pdf"
            checked={attachPdf}
            onCheckedChange={(on) => onEmailChange({ attachPdf: on })}
            data-testid="an-attach-pdf"
          />
        </ToggleRow>
        <Field
          label="Subject (optional)"
          htmlFor="an-subject"
          hint="Leave it empty for the usual subject with the report's date."
        >
          <Input
            id="an-subject"
            value={subject}
            onChange={(e) => onEmailChange({ subject: e.target.value })}
            placeholder="Attendance report"
            maxLength={200}
            data-testid="an-subject"
          />
        </Field>
      </div>
    </div>
  );
}

// ─── Internal Chat ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Who reads a chat channel: everyone in its branch (a company channel) or in its department. */
export function ChatAudienceWarning({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-relaxed text-amber-900",
        className,
      )}
      role="note"
      data-testid="an-chat-warning"
    >
      <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
      <p>
        <b>Everyone in a channel reads what is posted there.</b> A company channel is read by every employee of that
        branch, and a department channel by everyone in that department. Only send a report all of them may see (names,
        absences, leave details and photos are in the detailed list).
      </p>
    </div>
  );
}

function ChannelOption({ c, on, onToggle }: { c: NotifyChatChannel; on: boolean; onToggle: () => void }) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2.5 transition-colors",
        on ? "border-indigo-300 bg-indigo-50" : "border-slate-200 bg-white hover:border-indigo-200",
      )}
    >
      <Checkbox checked={on} onCheckedChange={onToggle} className="mt-0.5" data-testid={`an-chat-channel-${c.id}`} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
          {c.type === "company" ? <Building2 size={13} /> : <Hash size={13} />}
          {c.name}
        </span>
        <span className="block text-[11px] text-slate-500">
          {c.type === "company" ? "Company channel" : "Department channel"}
          {c.branch ? ` · ${c.branch}` : ""}
          {c.members !== null ? ` · read by ${c.members.toLocaleString("en-IN")} people` : ""}
        </span>
        {c.note && <span className="mt-0.5 block text-[11px] text-slate-400">{c.note}</span>}
      </span>
    </label>
  );
}

export function ChatRecipients({ value, onChange }: RecipientsProps) {
  const channels = useAttendanceNotifyChatChannels();
  const items = channels.data ?? [];
  const company = items.filter((c) => c.type === "company");
  const departments = items.filter((c) => c.type === "department");
  const missing = value.channelIds.filter((id) => channels.data && !items.some((c) => c.id === id));
  const toggle = (id: number) => onChange({ channelIds: toggleId(value.channelIds, id) });

  return (
    <div className="space-y-4" data-testid="an-recipients-chat">
      <ChatAudienceWarning />
      {channels.isLoading ? (
        <p className="flex items-center gap-1.5 text-xs text-slate-500">
          <Loader2 size={13} className="animate-spin" /> Loading the chat channels…
        </p>
      ) : channels.isError ? (
        <p className="text-xs text-red-600">The chat channels could not be loaded.</p>
      ) : items.length === 0 ? (
        <p className="text-xs text-slate-500">There is no chat channel yet.</p>
      ) : (
        <>
          {company.length > 0 && (
            <Field label="Company channels (one per branch)">
              <div className="grid gap-2 md:grid-cols-2">
                {company.map((c) => (
                  <ChannelOption key={c.id} c={c} on={value.channelIds.includes(c.id)} onToggle={() => toggle(c.id)} />
                ))}
              </div>
            </Field>
          )}
          {departments.length > 0 && (
            <Field label="Department channels">
              <div className="grid max-h-72 gap-2 overflow-y-auto md:grid-cols-2">
                {departments.map((c) => (
                  <ChannelOption key={c.id} c={c} on={value.channelIds.includes(c.id)} onToggle={() => toggle(c.id)} />
                ))}
              </div>
            </Field>
          )}
        </>
      )}
      {missing.length > 0 && (
        <p className="flex flex-wrap items-center gap-2 text-xs text-amber-800">
          {missing.length} chosen channel{missing.length === 1 ? " no longer exists" : "s no longer exist"}.
          <button
            type="button"
            className="font-semibold underline"
            onClick={() => onChange({ channelIds: value.channelIds.filter((id) => !missing.includes(id)) })}
            data-testid="an-chat-missing-remove"
          >
            Remove {missing.length === 1 ? "it" : "them"}
          </button>
        </p>
      )}
    </div>
  );
}

import { useState } from "react";
import { Loader2, Search, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useDebounced } from "@/hooks/use-debounced";
import { useToast } from "@/hooks/use-toast";
import { useMobileDevices, useSendMobileMessage, type MobileDeviceRow } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { errorText, plural } from "./logic";
import { PhoneNotificationCard } from "./PhonePreview";
import { Panel, useLockedWhy } from "./ui";

const TITLE_MAX = 60;
const MESSAGE_MAX = 500;

/**
 * Send a message: one message to one employee, saved in their app and pushed to their phones. For trying a phone, or a short
 * note that is not one of the system's messages. It is not sent on WhatsApp.
 */
export default function SendTab() {
  const { toast } = useToast();
  const locked = useLockedWhy();
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<MobileDeviceRow | null>(null);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  // asked once typing pauses, not once per letter (the last matches stay listed meanwhile)
  const searchText = useDebounced(text.trim());
  const search = useMobileDevices({ search: searchText, page: 1, pageSize: 6 });
  const send = useSendMobileMessage();
  const ready = !!picked && title.trim().length > 0 && message.trim().length > 0;

  const submit = () => {
    if (!picked) return;
    send.mutate(
      { employeeId: picked.id, title: title.trim(), message: message.trim() },
      {
        onSuccess: (row) => {
          const pushed = row.pushStatus === "sent" || row.pushStatus === "delivered";
          toast({
            title: pushed ? "Message sent to the phone" : "Message saved in the app",
            description: pushed
              ? `${picked.name} will see it on the lock screen and in the app.`
              : `${row.pushStatusLabel}. ${picked.name} can still read it in the app.`,
          });
          setTitle("");
          setMessage("");
        },
        onError: (e) =>
          toast({ title: "Could not send it", description: errorText(e, "Try again."), variant: "destructive" }),
      },
    );
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2" data-testid="pn-send">
      <Panel title="1. Choose the employee">
        <div className="space-y-2">
          <div className="relative">
            <Search
              size={13}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Name, code or phone number"
              className="h-9 pl-8 text-sm"
              aria-label="Find the employee"
            />
          </div>
          <div className="grid gap-1.5">
            {(search.data?.items ?? []).map((e) => (
              <button
                type="button"
                key={e.id}
                onClick={() => setPicked(e)}
                data-testid={`pn-pick-${e.employeeCode}`}
                aria-pressed={picked?.id === e.id}
                data-view-safe
                className={cn(
                  "flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                  picked?.id === e.id ? "border-sky-400 bg-sky-50" : "bg-card hover:bg-muted",
                )}
              >
                <span>
                  <b>{e.name}</b>{" "}
                  <span className="font-mono text-[11px] text-muted-foreground">({e.employeeCode})</span>
                </span>
                <span
                  className={cn(
                    "text-[11px] font-semibold",
                    e.muted ? "text-orange-700" : e.devices ? "text-emerald-700" : "text-amber-700",
                  )}
                >
                  {e.muted ? "Muted" : e.devices ? plural(e.devices, "phone") : "No phone yet"}
                </span>
              </button>
            ))}
            {search.data && search.data.items.length === 0 && (
              <p className="py-3 text-center text-xs text-muted-foreground">No employee matches.</p>
            )}
          </div>
        </div>
      </Panel>
      <Panel title="2. Write the message">
        <div className="space-y-3">
          {picked && (
            <p className="rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-900" data-testid="pn-picked">
              To <b>{picked.name}</b> ({picked.employeeCode})
              {picked.muted
                ? ". They are muted, so it will only be in the app."
                : picked.devices === 0
                  ? ". They have no phone registered, so it will only be in the app."
                  : ""}
            </p>
          )}
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={TITLE_MAX}
            placeholder="Title (shown first on the phone)"
            aria-label="Title"
            data-testid="pn-title"
          />
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={MESSAGE_MAX}
            rows={4}
            placeholder="The message"
            aria-label="Message"
            data-testid="pn-message"
          />
          <p className="-mt-1.5 text-right text-[11px] text-muted-foreground">
            {message.length} / {MESSAGE_MAX}
          </p>
          {/* how it will show, before it is sent */}
          <div className="space-y-1.5" data-testid="pn-send-preview-block">
            <p className="text-xs font-semibold">
              Preview <span className="font-normal text-muted-foreground">(how it shows on the phone)</span>
            </p>
            <PhoneNotificationCard
              title={title.trim() || "Title"}
              body={message.trim() || "The message"}
              dim={{ title: !title.trim(), body: !message.trim() }}
              testId="pn-send-preview"
              className="max-w-sm"
            />
          </div>
          <div className="flex justify-end">
            <Button
              className="gap-1.5"
              disabled={!ready || send.isPending || locked !== null}
              title={locked ?? undefined}
              onClick={submit}
              data-testid="pn-send-button"
            >
              {send.isPending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Send to the phone
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            It is saved in the employee&apos;s Notifications page and pushed to their phones. It is not sent on
            WhatsApp. Use it to try a phone, or for a short note that is not one of the system&apos;s messages.
          </p>
        </div>
      </Panel>
    </div>
  );
}

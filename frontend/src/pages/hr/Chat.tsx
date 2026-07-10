import { useEffect, useMemo, useRef, useState } from "react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MessageCircle, Send, X, CornerUpLeft } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  useChatChannels, useChatMessages, useSendChatMessage,
  type ChatMessageItem,
} from "@/lib/api-client/custom-hooks";

/**
 * Company-wide chat for the HR Portal. Same backend the Employee App chat
 * uses; HR only sees the company channel (department channels stay private
 * to their employees). Messages poll every few seconds — no WebSockets.
 */
export default function Chat() {
  const { toast } = useToast();
  const { data: channels } = useChatChannels();
  const companyChannel = useMemo(
    () => (channels ?? []).find(c => c.type === "company") ?? null,
    [channels],
  );

  const { data: messages, isLoading } = useChatMessages(companyChannel?.id ?? null);
  const sendMessage = useSendChatMessage();

  const [text, setText] = useState("");
  const [replyTo, setReplyTo] = useState<ChatMessageItem | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const lastCountRef = useRef(0);

  // Stick to the bottom when new messages arrive
  useEffect(() => {
    const count = messages?.length ?? 0;
    if (count !== lastCountRef.current) {
      lastCountRef.current = count;
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [messages]);

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed || !companyChannel) return;
    try {
      await sendMessage.mutateAsync({
        channelId: companyChannel.id,
        text: trimmed,
        replyToId: replyTo?.id,
      });
      setText("");
      setReplyTo(null);
    } catch {
      toast({ title: "Could not send the message", variant: "destructive" });
    }
  };

  return (
    <HrLayout>
      <div className="flex flex-col h-full gap-4">
        <div className="shrink-0">
          <h2 className="text-2xl font-black text-gray-900">Company Chat</h2>
          <p className="text-muted-foreground text-sm mt-0.5">
            One shared conversation with every staff member — messages sent here are
            visible in the Employee App's Company chat too.
          </p>
        </div>

        <Card className="border-0 shadow-sm flex-1 flex flex-col min-h-0">
          <CardHeader className="pb-3 border-b shrink-0">
            <CardTitle className="text-sm font-bold flex items-center gap-2">
              <MessageCircle size={15} className="text-blue-500" /> Company Channel
              <span className="ml-auto text-[10px] font-semibold text-green-600 bg-green-50 px-2 py-0.5 rounded-full">
                LIVE · refreshes automatically
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0 flex-1 flex flex-col min-h-0">
            {/* Messages */}
            <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3 bg-gray-50/50">
              {isLoading && <p className="text-sm text-center text-muted-foreground py-8">Loading messages…</p>}
              {!isLoading && (messages ?? []).length === 0 && (
                <p className="text-sm text-center text-muted-foreground py-8">
                  No messages yet — say hello to the whole company.
                </p>
              )}
              {(messages ?? []).map(m => (
                <div key={m.id} className={`flex ${m.isHr ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[75%] rounded-2xl px-3.5 py-2 shadow-sm ${
                    m.isHr ? "bg-blue-600 text-white" : "bg-white border"
                  }`}>
                    <div className="flex items-center gap-2">
                      <span className={`text-[11px] font-bold ${m.isHr ? "text-blue-100" : "text-blue-700"}`}>
                        {m.senderName}
                      </span>
                      {m.createdAt && (
                        <span className={`text-[10px] ${m.isHr ? "text-blue-200" : "text-gray-400"}`}>
                          {new Date(m.createdAt).toLocaleString("en-IN", {
                            day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
                          })}
                        </span>
                      )}
                    </div>
                    {m.replyTo && (
                      <div className={`mt-1 mb-1 px-2 py-1 rounded-lg border-l-2 text-[11px] ${
                        m.isHr ? "bg-blue-500/60 border-blue-200 text-blue-50" : "bg-gray-50 border-blue-300 text-gray-500"
                      }`}>
                        <span className="font-semibold">{m.replyTo.senderName}: </span>
                        <span className="line-clamp-2">{m.replyTo.text}</span>
                      </div>
                    )}
                    <p className="text-sm whitespace-pre-wrap break-words mt-0.5">{m.text}</p>
                    {m.reactions.length > 0 && (
                      <div className="flex gap-1 mt-1 flex-wrap">
                        {m.reactions.map(r => (
                          <span key={r.emoji} className={`text-[11px] px-1.5 py-0.5 rounded-full ${
                            m.isHr ? "bg-blue-500/60" : "bg-gray-100"
                          }`}>
                            {r.emoji} {r.count}
                          </span>
                        ))}
                      </div>
                    )}
                    {!m.isHr && (
                      <button
                        onClick={() => setReplyTo(m)}
                        className="mt-1 inline-flex items-center gap-1 text-[10px] text-gray-400 hover:text-blue-600"
                      >
                        <CornerUpLeft size={10} /> Reply
                      </button>
                    )}
                  </div>
                </div>
              ))}
              <div ref={bottomRef} />
            </div>

            {/* Composer */}
            <div className="border-t p-3 space-y-2 shrink-0">
              {replyTo && (
                <div className="flex items-center gap-2 px-3 py-1.5 bg-blue-50 border border-blue-100 rounded-lg text-xs text-blue-700">
                  <CornerUpLeft size={12} className="shrink-0" />
                  <span className="truncate">
                    Replying to <strong>{replyTo.senderName}</strong>: {replyTo.text}
                  </span>
                  <button onClick={() => setReplyTo(null)} className="ml-auto shrink-0 text-blue-400 hover:text-blue-700">
                    <X size={13} />
                  </button>
                </div>
              )}
              <div className="flex gap-2">
                <Input
                  value={text}
                  onChange={e => setText(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  placeholder={companyChannel ? "Type a message…" : "Connecting to chat…"}
                  disabled={!companyChannel || sendMessage.isPending}
                />
                <Button
                  size="sm"
                  className="gap-1.5 shrink-0"
                  onClick={handleSend}
                  disabled={!companyChannel || !text.trim() || sendMessage.isPending}
                >
                  <Send size={13} /> {sendMessage.isPending ? "Sending…" : "Send"}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </HrLayout>
  );
}

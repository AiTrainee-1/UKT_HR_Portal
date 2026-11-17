// chat: hooks/types split out of the former single custom-hooks.ts (see ./index.ts).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";
import { readChatReport, type NotifyChatReport } from "./attendance-notify";

// ── Chat (HR portal -company channel) ────────────────────────────────────────

/** An attendance report posted by Attendance Notify (attendance-notify.ts): the HR page draws it as a card; `text` stays
 *  the plain version (the mobile app shows that). Rows' photoUrl is a signed link. */
export type ChatReport = NotifyChatReport;

export type ChatChannelItem = {
  id: number;
  type: "company" | "department";
  departmentId: number | null;
  departmentName: string | null;
  /** "Company – Head Office", "Company (no branch)" or the department (2026-11-17; older servers send none). */
  name?: string;
  branchId?: number | null;
  branchName?: string | null;
};

export type ChatMessageItem = {
  id: number;
  senderId: number | null;
  senderName: string;
  isHr?: boolean;
  text: string;
  replyTo: { id: number; senderName: string; text: string } | null;
  reactions: { emoji: string; count: number; reactedByMe: boolean }[];
  createdAt: string | null;
  /** Set on an Attendance Notify report (null / missing on every other message). */
  report?: ChatReport | null;
};

export const useChatChannels = () =>
  useQuery<ChatChannelItem[]>({
    queryKey: ["/api/chat/channels"],
    queryFn: () => customFetch<ChatChannelItem[]>("/api/chat/channels"),
  });

export const useChatMessages = (channelId: number | null) =>
  useQuery<ChatMessageItem[]>({
    queryKey: ["/api/chat/channels", channelId, "messages"],
    queryFn: async () => {
      const rows = await customFetch<ChatMessageItem[]>(`/api/chat/channels/${channelId}/messages?limit=100`);
      // a report is read leniently: one the page cannot draw shows as the plain text
      return Array.isArray(rows) ? rows.map((m) => ({ ...m, report: readChatReport(m?.report) })) : [];
    },
    enabled: channelId != null,
    refetchInterval: 10_000,
  });

export const useSendChatMessage = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ channelId, text, replyToId }: { channelId: number; text: string; replyToId?: number }) =>
      customFetch<ChatMessageItem>(`/api/chat/channels/${channelId}/messages`, {
        method: "POST",
        body: JSON.stringify({ text, reply_to_id: replyToId }),
      }),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/chat/channels", vars.channelId, "messages"] });
    },
  });
};

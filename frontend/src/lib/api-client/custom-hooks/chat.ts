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

/** The message the server sends back for a post; with "all branches", how many other company chats got it too. */
export type ChatPostResult = ChatMessageItem & { alsoPostedIn?: number };

/**
 * May the viewer post this message in every branch's company chat at once (2026-11-17)? Only an HR admin who sees every
 * branch can: their channel list holds more than one company channel (the unbranched one and each branch's), and the open
 * channel must be one of them. The server checks it again and refuses anyone else.
 */
export function canPostToAllBranches(
  channels: readonly Pick<ChatChannelItem, "id" | "type">[] | undefined,
  open: Pick<ChatChannelItem, "id" | "type"> | null | undefined,
): boolean {
  if (!open || open.type !== "company") return false;
  const companies = (channels ?? []).filter((c) => c.type === "company");
  return companies.length > 1 && companies.some((c) => c.id === open.id);
}

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
    mutationFn: ({
      channelId,
      text,
      replyToId,
      allBranches,
    }: {
      channelId: number;
      text: string;
      replyToId?: number;
      /** Also post it in every other company chat (see canPostToAllBranches). Left out of the body unless true. */
      allBranches?: boolean;
    }) =>
      customFetch<ChatPostResult>(`/api/chat/channels/${channelId}/messages`, {
        method: "POST",
        body: JSON.stringify({ text, reply_to_id: replyToId, ...(allBranches ? { allBranches: true } : {}) }),
      }),
    onSuccess: (_data, vars) => {
      // posted in every company chat: each of them has a new message
      queryClient.invalidateQueries({
        queryKey: vars.allBranches ? ["/api/chat/channels"] : ["/api/chat/channels", vars.channelId, "messages"],
      });
    },
  });
};

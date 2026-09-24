// chat: hooks/types split out of the former single custom-hooks.ts (see ./index.ts).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";

// ── Chat (HR portal -company channel) ────────────────────────────────────────

export type ChatChannelItem = {
  id: number;
  type: "company" | "department";
  departmentId: number | null;
  departmentName: string | null;
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
};

export const useChatChannels = () =>
  useQuery<ChatChannelItem[]>({
    queryKey: ["/api/chat/channels"],
    queryFn: () => customFetch<ChatChannelItem[]>("/api/chat/channels"),
  });

export const useChatMessages = (channelId: number | null) =>
  useQuery<ChatMessageItem[]>({
    queryKey: ["/api/chat/channels", channelId, "messages"],
    queryFn: () => customFetch<ChatMessageItem[]>(`/api/chat/channels/${channelId}/messages?limit=100`),
    enabled: channelId != null,
    refetchInterval: 4000,
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

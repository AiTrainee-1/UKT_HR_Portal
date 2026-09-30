// support: the public HR / software-support contact the employee apps show (Settings -> HR Contact), see ./index.ts.
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";
import {
  isSupportContact,
  readCachedSupportContact,
  writeCachedSupportContact,
  type SupportContact,
} from "../../support-contact";

export const getSupportContactQueryKey = () => ["/api/support-contact"] as const;

/**
 * The contact to show when someone needs help. The last good answer is kept on the device and served straight
 * away, then refreshed; if the refresh fails (the server is down: exactly when it is needed) the kept copy stays.
 */
export const useSupportContact = () =>
  useQuery<SupportContact>({
    queryKey: getSupportContactQueryKey(),
    queryFn: async () => {
      const data = await customFetch<unknown>("/api/support-contact");
      if (!isSupportContact(data)) throw new Error("Unexpected support contact response");
      writeCachedSupportContact(data);
      return data;
    },
    initialData: () => readCachedSupportContact() ?? undefined,
    // The kept copy is a starting point, not the truth: always ask again on mount.
    initialDataUpdatedAt: 0,
    staleTime: 5 * 60_000,
    retry: false,
  });

import { useQueries } from "@tanstack/react-query";
import { customFetch } from "@/lib/api-client/custom-fetch";
import type { IdCardData } from "@/lib/api-client/custom-hooks";
import { CARD_CHUNK, chunk, orderCards } from "./logic";

/**
 * The cards of the selected employees, fetched in pieces of CARD_CHUNK ids (the ids travel in the URL, and a long one is
 * refused by the server). Same query key as useIdCards, so a piece already fetched is shared. The cards come back in the
 * order the employees were selected.
 */
export function useIdCardsInChunks(ids: number[]) {
  return useQueries({
    queries: chunk(ids, CARD_CHUNK).map((part) => ({
      queryKey: ["/api/idcard", part.join(",")],
      queryFn: () => customFetch<IdCardData[]>(`/api/idcard?ids=${part.join(",")}`),
      // keep showing the cards already there while a changed selection is fetched
      placeholderData: (previous: IdCardData[] | undefined) => previous,
    })),
    combine: (results) => ({
      cards: orderCards(
        results.flatMap((r) => r.data ?? []),
        ids,
      ),
      isLoading: results.some((r) => r.isLoading),
      isFetching: results.some((r) => r.isFetching),
      isError: results.some((r) => r.isError),
      refetch: () => results.forEach((r) => void r.refetch()),
    }),
  });
}

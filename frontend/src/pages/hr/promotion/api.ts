import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@/lib/api-client/custom-fetch";
import type { PromotionRecord } from "./logic";

/** How many promotions the page asks for. The server caps it (2000); the default would be only the newest 200. */
export const PROMOTION_LIMIT = 2000;

/**
 * Every promotion, newest first. The key starts with "/api/promotions" on purpose: promoting and deleting
 * (useCreatePromotion / useDeletePromotion) invalidate that prefix, so this list refreshes itself.
 */
export const usePromotionHistory = () =>
  useQuery<PromotionRecord[]>({
    queryKey: ["/api/promotions", "all", PROMOTION_LIMIT],
    queryFn: () => customFetch<PromotionRecord[]>(`/api/promotions?limit=${PROMOTION_LIMIT}`),
  });

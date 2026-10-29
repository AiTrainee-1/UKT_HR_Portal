// Geo Attendance -> Journey History. The list of every tracked On-Duty journey, and (when one is open) that journey's page.
// The filters live here, so coming Back from a journey shows the same list as it was left.
import { useCallback, useState } from "react";
import JourneyDetail from "./JourneyDetail";
import JourneyList, { DEFAULT_FILTERS, type JourneyFilters } from "./JourneyList";

export default function JourneyHistoryTab({
  journeyId,
  onJourneyChange,
}: {
  journeyId: number | null;
  onJourneyChange: (id: number | null) => void;
}) {
  const [filters, setFilters] = useState<JourneyFilters>(DEFAULT_FILTERS);
  const patch = useCallback((next: Partial<JourneyFilters>) => setFilters((f) => ({ ...f, ...next })), []);

  if (journeyId !== null) {
    return <JourneyDetail key={journeyId} id={journeyId} onBack={() => onJourneyChange(null)} />;
  }
  return <JourneyList filters={filters} onFilters={patch} onOpen={onJourneyChange} />;
}

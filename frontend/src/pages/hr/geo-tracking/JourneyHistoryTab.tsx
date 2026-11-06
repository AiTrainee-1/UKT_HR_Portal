// Geo Attendance -> Journey History. The list of every tracked On-Duty journey with the Journey Simulation picker above it, one
// journey's page (/journeys/12), or that journey replayed on the map (/journeys/12/simulate). The filters live here, so coming
// Back from a journey (or from its replay) shows the same list as it was left.
import { useCallback, useState } from "react";
import JourneyDetail from "./JourneyDetail";
import JourneyList, { DEFAULT_FILTERS, type JourneyFilters } from "./JourneyList";
import type { GeoView } from "./routes";
import JourneySimulation from "./simulation/JourneySimulation";
import SimulationPicker from "./simulation/SimulationPicker";

export default function JourneyHistoryTab({
  journeyId,
  view = "journey",
  onJourneyChange,
  onSimulate,
}: {
  journeyId: number | null;
  view?: GeoView;
  onJourneyChange: (id: number | null) => void;
  /** Replay a journey on the map (the page opens /journeys/<id>/simulate). Without it there is no replay to offer. */
  onSimulate?: (id: number) => void;
}) {
  const [filters, setFilters] = useState<JourneyFilters>(DEFAULT_FILTERS);
  const patch = useCallback((next: Partial<JourneyFilters>) => setFilters((f) => ({ ...f, ...next })), []);

  if (journeyId !== null && view === "simulate") {
    return (
      <JourneySimulation
        key={`simulate-${journeyId}`}
        id={journeyId}
        onBack={() => onJourneyChange(null)}
        onOpenJourney={onJourneyChange}
      />
    );
  }
  if (journeyId !== null) {
    return (
      <JourneyDetail
        key={journeyId}
        id={journeyId}
        onBack={() => onJourneyChange(null)}
        onSimulate={onSimulate ? () => onSimulate(journeyId) : undefined}
      />
    );
  }
  return (
    <div className="space-y-4">
      {onSimulate && <SimulationPicker onSimulate={onSimulate} />}
      <JourneyList filters={filters} onFilters={patch} onOpen={onJourneyChange} onSimulate={onSimulate} />
    </div>
  );
}

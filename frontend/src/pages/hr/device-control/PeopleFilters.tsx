import { useEffect, useRef, useState } from "react";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { DeviceControlDevice, DeviceMode } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import {
  LINK_LABEL,
  NO_FILTERS,
  activeFilterCount,
  describeDeviceFilter,
  filtersActive,
  type PushFilters,
} from "./logic";

const SEARCH_DELAY_MS = 300;

const MODE_LABEL: Record<DeviceMode, string> = {
  any: "Is on any of these",
  all: "Is on all of these",
  none: "Is NOT on any of these",
};

/** Everything the Data Push list can be narrowed by. The same filters work for "who is on this device", "who is on
 *  several", "in a device but not in the HRMS" and "in the HRMS but not on a device". */
export default function PeopleFilters({
  filters,
  onChange,
  devices,
  departments,
  shown,
  total,
}: {
  filters: PushFilters;
  onChange: (next: PushFilters) => void;
  devices: DeviceControlDevice[];
  departments: { id: number; name: string }[];
  shown: number;
  total: number;
}) {
  const set = (patch: Partial<PushFilters>) => onChange({ ...filters, ...patch });

  // The search box is typed into freely; the list asks the server once the typing pauses.
  const [text, setText] = useState(filters.search);
  const committed = useRef(filters.search);
  const latest = useRef({ filters, onChange });
  useEffect(() => {
    latest.current = { filters, onChange };
  });
  useEffect(() => {
    // the filters changed from outside (Clear filters, a stat card, a link): the box follows
    if (filters.search !== committed.current) {
      committed.current = filters.search;
      setText(filters.search);
    }
  }, [filters.search]);
  useEffect(() => {
    if (text === committed.current) return;
    const timer = setTimeout(() => {
      committed.current = text;
      latest.current.onChange({ ...latest.current.filters, search: text });
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text]);
  const clearSearch = () => {
    committed.current = "";
    setText("");
    set({ search: "" });
  };
  const deviceChip = describeDeviceFilter(filters, devices);
  const toggleDevice = (id: number, on: boolean) =>
    set({ devices: on ? [...new Set([...filters.devices, id])] : filters.devices.filter((d) => d !== id) });
  const active = filtersActive(filters);

  return (
    <div className="space-y-3 rounded-2xl border bg-white p-3" data-testid="push-filters">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="relative flex-1">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search by name, ID, card number or department"
            aria-label="Search people"
            className="h-10 pl-9 pr-9"
            data-testid="push-search"
          />
          {text && (
            <button
              type="button"
              onClick={clearSearch}
              aria-label="Clear search"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:text-gray-700"
            >
              <X size={14} />
            </button>
          )}
        </div>

        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              className={cn(
                "h-10 justify-start gap-2",
                filters.devices.length > 0 && "border-[#006496] text-[#006496]",
              )}
              data-testid="push-device-filter"
            >
              <SlidersHorizontal size={14} />
              {filters.devices.length > 0 ? deviceChip : "Which device"}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80 space-y-3" data-testid="push-device-popover">
            <Select value={filters.deviceMode} onValueChange={(v) => set({ deviceMode: v as DeviceMode })}>
              <SelectTrigger aria-label="Device filter mode" data-testid="push-device-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(MODE_LABEL) as DeviceMode[]).map((m) => (
                  <SelectItem key={m} value={m}>
                    {MODE_LABEL[m]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="max-h-60 space-y-1 overflow-y-auto">
              {devices.map((d) => (
                <label
                  key={d.id}
                  className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-slate-50"
                >
                  <Checkbox
                    checked={filters.devices.includes(d.id)}
                    onCheckedChange={(c) => toggleDevice(d.id, c === true)}
                    data-testid={`push-device-option-${d.id}`}
                    aria-label={d.name}
                  />
                  <span className="min-w-0 flex-1 truncate font-medium text-slate-700">{d.name}</span>
                </label>
              ))}
            </div>
            {filters.devices.length > 0 && (
              <Button variant="ghost" size="sm" onClick={() => set({ devices: [], deviceMode: "any" })}>
                Clear devices
              </Button>
            )}
          </PopoverContent>
        </Popover>

        <div className="grid grid-cols-2 gap-2 lg:flex">
          <Select value={filters.link} onValueChange={(v) => set({ link: v as PushFilters["link"] })}>
            <SelectTrigger className="h-10 lg:w-56" aria-label="Filter by HRMS" data-testid="push-filter-link">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Everyone</SelectItem>
              <SelectItem value="linked">{LINK_LABEL.linked}</SelectItem>
              <SelectItem value="device_only">{LINK_LABEL.device_only}</SelectItem>
              <SelectItem value="hrms_only">In HRMS, {LINK_LABEL.hrms_only.toLowerCase()}</SelectItem>
              <SelectItem value="inactive_on_device">{LINK_LABEL.inactive_on_device}, on a device</SelectItem>
            </SelectContent>
          </Select>
          <Select value={filters.count} onValueChange={(v) => set({ count: v as PushFilters["count"] })}>
            <SelectTrigger
              className="h-10 lg:w-56"
              aria-label="Filter by number of devices"
              data-testid="push-filter-count"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any number of devices</SelectItem>
              <SelectItem value="single">On one device</SelectItem>
              <SelectItem value="multiple">On several devices</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
          <Select value={filters.role} onValueChange={(v) => set({ role: v as PushFilters["role"] })}>
            <SelectTrigger className="h-9 sm:w-44" aria-label="Filter by role" data-testid="push-filter-role">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any role</SelectItem>
              <SelectItem value="admin">Has a special role</SelectItem>
              <SelectItem value="user">Normal users only</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={filters.employmentType || "all"}
            onValueChange={(v) => set({ employmentType: v === "all" ? "" : (v as PushFilters["employmentType"]) })}
          >
            <SelectTrigger
              className="h-9 sm:w-52"
              aria-label="Filter by employment type"
              data-testid="push-filter-employment"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Staff and production</SelectItem>
              <SelectItem value="staff">Staff</SelectItem>
              <SelectItem value="production">Production</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={filters.departmentId ? String(filters.departmentId) : "all"}
            onValueChange={(v) => set({ departmentId: v === "all" ? null : Number(v) })}
          >
            <SelectTrigger
              className="h-9 sm:w-52"
              aria-label="Filter by department"
              data-testid="push-filter-department"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All departments</SelectItem>
              {departments.map((d) => (
                <SelectItem key={d.id} value={String(d.id)}>
                  {d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <label className="col-span-2 flex items-center gap-2 text-xs font-medium text-slate-600 sm:col-span-1">
            <Switch
              checked={filters.differs}
              onCheckedChange={(c) => set({ differs: c })}
              data-testid="push-filter-differs"
            />
            Details differ between devices
          </label>
        </div>
        <p className="text-xs text-gray-500" data-testid="push-count">
          Showing <b>{shown.toLocaleString("en-IN")}</b> of {total.toLocaleString("en-IN")}
          {active && (
            <button
              type="button"
              onClick={() => onChange(NO_FILTERS)}
              className="ml-2 font-semibold text-blue-600 hover:underline"
              data-testid="push-clear-filters"
            >
              Clear {activeFilterCount(filters)} filter{activeFilterCount(filters) === 1 ? "" : "s"}
            </button>
          )}
        </p>
      </div>
    </div>
  );
}

"use client";

import { useAction, useMutation, usePaginatedQuery, useQuery_experimental } from "convex/react";
import { Route } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { inputClassName } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useMinuteNow } from "@/lib/use-minute-now";
import { useCompany } from "./company-context";
import {
  ConfirmDialog,
  RecordMenu,
  StartTripDialog,
  TripDetailDialog,
  errorMessage,
  type TripSheetTrip,
} from "./fleet-dialogs";
import {
  formatDuration,
  formatKm,
  formatTime,
  openTripStatusChip,
  tripStatusChip,
  type FleetTripRow,
  type FleetVehicleRow,
} from "./fleet-format";
import { FleetPage, useFleetAccess } from "./fleet-shell";
import {
  DashedPanel,
  EmptyPanel,
  FleetCard,
  FleetNotice,
  LoadMore,
  QueryError,
  SectionHeading,
  SkeletonBlock,
} from "./fleet-ui";

const DAY_MS = 86_400_000;
const periodOptions = [
  { value: "7d", label: "7 days", days: 7 },
  { value: "30d", label: "30 days", days: 30 },
  { value: "90d", label: "90 days", days: 90 },
  { value: "all", label: "All time", days: null },
] as const;

export function TripsPage() {
  const { activeCompanyId } = useCompany();
  const { canLog, canManage, canView, timeZone } = useFleetAccess();
  const now = useMinuteNow();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const vehicleParam = searchParams.get("vehicle") ?? "";
  const period = searchParams.get("period") ?? "30d";
  // The cutoff is anchored when the page opens so the subscription does not
  // restart (and lose pagination) every minute.
  const [filterAnchor] = useState(() => Math.floor(Date.now() / 60_000) * 60_000);
  const periodOption = periodOptions.find((option) => option.value === period);
  // "all" keeps its null sentinel; only an unknown period falls back to 30 days.
  const periodDays = periodOption ? periodOption.days : 30;

  const [notice, setNotice] = useState<string | null>(null);
  const [returningId, setReturningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startOpen, setStartOpen] = useState(false);
  const [editingTrip, setEditingTrip] = useState<FleetTripRow | null>(null);
  const [deletingTrip, setDeletingTrip] = useState<FleetTripRow | null>(null);
  const [sheetTrip, setSheetTrip] = useState<FleetTripRow | null>(null);
  const returnTrip = useAction(api.fleet.returnTrip);
  const deleteTrip = useMutation(api.fleet.deleteTrip);

  const openTripsResult = useQuery_experimental({
    query: api.fleet.listOpenTrips,
    args: activeCompanyId && canView ? { companyId: activeCompanyId } : "skip",
  });
  const vehiclesResult = useQuery_experimental({
    query: api.fleet.listVehicles,
    args: activeCompanyId && canView ? { companyId: activeCompanyId, now } : "skip",
  });
  const vehicles = (vehiclesResult.status === "success" ? vehiclesResult.data.vehicles : []) as FleetVehicleRow[];
  const vehicleFilter = vehicles.some((vehicle) => vehicle._id === vehicleParam) ? vehicleParam : "";
  const since = periodDays === null ? undefined : filterAnchor - periodDays * DAY_MS;
  const tripsQuery = usePaginatedQuery(
    api.fleet.listTrips,
    activeCompanyId
      ? {
          companyId: activeCompanyId,
          ...(vehicleFilter ? { vehicleId: vehicleFilter as Id<"fleetVehicles"> } : {}),
          ...(since !== undefined ? { since } : {}),
        }
      : "skip",
    { initialNumItems: 20 },
  );
  const trips = tripsQuery.results as FleetTripRow[];
  const openTrips = (openTripsResult.status === "success"
    ? openTripsResult.data.trips
    : []) as FleetTripRow[];

  const queryError =
    openTripsResult.status === "error" || vehiclesResult.status === "error" || !activeCompanyId;
  const loading =
    openTripsResult.status === "pending" ||
    vehiclesResult.status === "pending" ||
    tripsQuery.status === "LoadingFirstPage";

  function setFilter(key: "vehicle" | "period", value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  function clearFilters() {
    router.push(pathname, { scroll: false });
  }

  async function markReturned(trip: FleetTripRow) {
    if (returningId || !activeCompanyId) return;
    setReturningId(trip._id);
    setError(null);
    try {
      await returnTrip({ companyId: activeCompanyId, tripId: trip._id });
      setNotice("Trip marked returned.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setReturningId(null);
    }
  }

  const filteredEmpty = Boolean(vehicleFilter) || period !== "30d";

  return (
    <FleetPage
      title="Trips"
      description="Vehicles out now, and every trip logged."
      activeTab="trips"
      actions={
        canLog ? (
          <Button
            type="button"
            variant="primary"
            className="h-11 w-full sm:h-10 sm:w-auto"
            onClick={() => setStartOpen(true)}
          >
            <Route className="h-4 w-4" aria-hidden="true" />
            Start trip
          </Button>
        ) : undefined
      }
    >
      {notice && <FleetNotice message={notice} onDismiss={() => setNotice(null)} />}
      {error && (
        <FleetNotice
          tone="error"
          message={error}
          action={
            <Button type="button" variant="secondary" className="h-9" onClick={() => setError(null)}>
              Dismiss
            </Button>
          }
        />
      )}
      {queryError && (
        <QueryError
          message="Could not load trips. Check your connection and try again."
          onRetry={() => window.location.reload()}
        />
      )}

      {queryError ? null : loading ? (
        <TripsSkeleton />
      ) : (
        <>
          <section aria-labelledby="fleet-out-now">
            <SectionHeading
              id="fleet-out-now"
              title={`Out now ${openTrips.length > 0 ? `· ${openTrips.length}` : ""}`}
              description="Vehicles currently on a logged trip."
            />
            {openTrips.length === 0 ? (
              <DashedPanel>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span>No vehicles are out right now.</span>
                  {canLog && (
                    <Button type="button" variant="primary" className="h-10" onClick={() => setStartOpen(true)}>
                      Start trip
                    </Button>
                  )}
                </div>
              </DashedPanel>
            ) : (
              <div className="grid gap-2 lg:grid-cols-2">
                {openTrips.map((trip) => {
                  const chip = openTripStatusChip({ status: trip.status, arrivedAt: trip.arrivedAt });
                  const pending = returningId === trip._id;
                  return (
                    <FleetCard key={trip._id} className="p-3.5">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <Link
                              href={`/fleet/vehicles/${trip.vehicleId}`}
                              className="truncate text-sm font-semibold text-[var(--ink)] hover:underline"
                            >
                              {trip.vehicle?.name ?? "Unknown vehicle"}
                            </Link>
                            <Badge tone={chip.tone}>{chip.label}</Badge>
                            {trip.offRoute && <Badge tone="yellow">Off route</Badge>}
                          </div>
                          <p className="mt-0.5 truncate text-[13px] text-[var(--ink-secondary)]">
                            {trip.driver?.name ?? "Unknown driver"} → {trip.destination}
                          </p>
                          <p className="mt-0.5 text-[12px] text-[var(--ink-muted)]">
                            {trip.arrivedAt != null
                              ? `Left ${formatTime(trip.departedAt, timeZone)} · arrived ${formatTime(trip.arrivedAt, timeZone)} · waiting to return`
                              : `Left ${formatTime(trip.departedAt, timeZone)} · ${formatDuration(now - trip.departedAt)}`}
                          </p>
                        </div>
                        <div className="flex w-full flex-wrap gap-2 sm:w-auto">
                          <Button asChild variant="ghost" className="h-10">
                            <Link href={`/fleet/vehicles/${trip.vehicleId}`}>View vehicle</Link>
                          </Button>
                          {canLog && (
                            <Button
                              type="button"
                              variant="primary"
                              className="h-10 flex-1 sm:flex-none"
                              disabled={pending}
                              onClick={() => void markReturned(trip)}
                            >
                              {pending ? "Marking…" : "Mark returned"}
                            </Button>
                          )}
                        </div>
                      </div>
                    </FleetCard>
                  );
                })}
              </div>
            )}
          </section>

          <section aria-labelledby="fleet-trip-history">
            <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
              <SectionHeading id="fleet-trip-history" title="Trip history" />
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1.5 text-[12px] text-[var(--ink-muted)]">
                  <span className="sr-only">Filter trips by vehicle</span>
                  <select
                    aria-label="Filter trips by vehicle"
                    value={vehicleFilter}
                    onChange={(event) => setFilter("vehicle", event.target.value)}
                    className={cn(inputClassName, "h-10 w-auto max-w-[190px] text-[13px]")}
                  >
                    <option value="">All vehicles</option>
                    {vehicles.map((vehicle) => (
                      <option key={vehicle._id} value={vehicle._id}>{vehicle.name}</option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-1.5 text-[12px] text-[var(--ink-muted)]">
                  <span className="sr-only">Filter trips by period</span>
                  <select
                    aria-label="Filter trips by period"
                    value={period}
                    onChange={(event) => setFilter("period", event.target.value)}
                    className={cn(inputClassName, "h-10 w-auto text-[13px]")}
                  >
                    {periodOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
              </div>
            </div>

            {trips.length === 0 ? (
              filteredEmpty ? (
                <DashedPanel>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span>
                      {vehicleFilter
                        ? period === "all"
                          ? "No trips for this vehicle."
                          : `No trips for this vehicle in the last ${periodDays} days.`
                        : "No trips match these filters."}
                    </span>
                    <Button type="button" variant="secondary" className="h-10" onClick={clearFilters}>
                      Clear filters
                    </Button>
                  </div>
                </DashedPanel>
              ) : (
                <EmptyPanel
                  icon={Route}
                  title="No trips yet"
                  body="Start a trip when a vehicle leaves the warehouse."
                  action={
                    canLog ? (
                      <Button type="button" variant="primary" className="h-10" onClick={() => setStartOpen(true)}>
                        Start trip
                      </Button>
                    ) : undefined
                  }
                />
              )
            ) : (
              <>
                <div className="hidden overflow-x-auto rounded-md border border-[var(--hairline)] md:block">
                  <table className="task-table min-w-[760px]" aria-label="Trip history">
                    <thead>
                      <tr>
                        <th scope="col">Vehicle</th>
                        <th scope="col">Destination</th>
                        <th scope="col">Driver</th>
                        <th scope="col">Left</th>
                        <th scope="col">Back</th>
                        <th scope="col" className="text-right">Km</th>
                        <th scope="col">Status</th>
                        {canManage && <th scope="col"><span className="sr-only">Actions</span></th>}
                      </tr>
                    </thead>
                    <tbody>
                      {trips.map((trip) => {
                        const chip = tripStatusChip(trip);
                        return (
                          <tr
                            key={trip._id}
                            tabIndex={0}
                            onClick={() => setSheetTrip(trip)}
                            onKeyDown={(event) => {
                              if (event.target !== event.currentTarget) return;
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                setSheetTrip(trip);
                              }
                            }}
                            className="cursor-pointer hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
                          >
                            <td>
                              <Link
                                href={`/fleet/vehicles/${trip.vehicleId}`}
                                onClick={(event) => event.stopPropagation()}
                                className="font-medium text-[var(--ink)] hover:underline"
                              >
                                {trip.vehicle?.name ?? "Unknown vehicle"}
                              </Link>
                              {trip.vehicle?.displayName && (
                                <div className="text-[11px] text-[var(--ink-faint)]">{trip.vehicle.registrationNumber}</div>
                              )}
                            </td>
                            <td className="max-w-[220px] truncate">
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setSheetTrip(trip);
                                }}
                                className="flex w-full items-center gap-1.5 text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
                                aria-label={`Open trip to ${trip.destination}`}
                              >
                                <span className="truncate">{trip.destination}</span>
                                {trip.offRoute && <Badge tone="yellow">Off route</Badge>}
                              </button>
                            </td>
                            <td>{trip.driver?.name ?? "—"}</td>
                            <td className="whitespace-nowrap">{formatTime(trip.departedAt, timeZone)}</td>
                            <td className="whitespace-nowrap">{trip.returnedAt ? formatTime(trip.returnedAt, timeZone) : "—"}</td>
                            <td className="text-right tabular-nums">{formatKm(trip.actualDistanceKm ?? trip.distanceKm)}</td>
                            <td>
                              <span className="flex items-center gap-1.5">
                                <Badge tone={chip.tone}>{chip.label}</Badge>
                                {trip.autoReturned && <Badge tone="neutral">Auto</Badge>}
                              </span>
                            </td>
                            {canManage && (
                              <td className="w-10" onClick={(event) => event.stopPropagation()}>
                                <RecordMenu
                                  label={`trip to ${trip.destination}`}
                                  onEdit={() => setEditingTrip(trip)}
                                  onDelete={() => setDeletingTrip(trip)}
                                />
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="grid gap-2 md:hidden">
                  {trips.map((trip) => {
                    const chip = tripStatusChip(trip);
                    return (
                      <button
                        key={trip._id}
                        type="button"
                        onClick={() => setSheetTrip(trip)}
                        className="rounded-xl border border-[var(--hairline)] bg-[var(--surface)] p-3.5 text-left transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                      >
                        <span className="flex items-start justify-between gap-2">
                          <span className="truncate text-sm font-semibold text-[var(--ink)]">
                            {trip.vehicle?.name ?? "Unknown vehicle"}
                          </span>
                          <Badge tone={chip.tone}>{chip.label}</Badge>
                        </span>
                        <span className="mt-1 block truncate text-[13px] text-[var(--ink-secondary)]">
                          {trip.destination}
                        </span>
                        <span className="mt-0.5 block text-[12px] text-[var(--ink-muted)]">
                          {trip.driver?.name ?? "—"} · {formatTime(trip.departedAt, timeZone)}
                          {trip.returnedAt ? ` → ${formatTime(trip.returnedAt, timeZone)}` : " → still out"}
                        </span>
                        <span className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-[var(--ink-muted)]">
                          <span>{formatKm(trip.actualDistanceKm ?? trip.distanceKm)}</span>
                          {trip.offRoute && <Badge tone="yellow">Off route</Badge>}
                          {trip.autoReturned && <Badge tone="neutral">Auto</Badge>}
                        </span>
                      </button>
                    );
                  })}
                </div>

                <LoadMore status={tripsQuery.status} onLoadMore={tripsQuery.loadMore} label="Load more trips" />
              </>
            )}
          </section>

          {tripsQuery.status === "Exhausted" && trips.length >= 20 && (
            <p className="text-[12px] text-[var(--ink-faint)]">
              Showing trips from {periodOptions.find((option) => option.value === period)?.label.toLowerCase() ?? "30 days"}.
            </p>
          )}
        </>
      )}

      {activeCompanyId && startOpen && (
        <StartTripDialog
          companyId={activeCompanyId}
          now={now}
          canManage={canManage}
          timeZone={timeZone}
          onClose={() => setStartOpen(false)}
          onSaved={(message) => { setNotice(message); setStartOpen(false); }}
        />
      )}
      {activeCompanyId && sheetTrip && (
        <TripDetailDialog
          companyId={activeCompanyId}
          trip={tripSheetFromRow(sheetTrip)}
          canLog={canLog}
          canManage={canManage}
          timeZone={timeZone}
          onClose={() => setSheetTrip(null)}
          onEdit={
            canManage
              ? () => {
                  setEditingTrip(sheetTrip);
                  setSheetTrip(null);
                }
              : undefined
          }
          onSaved={(message) => { setNotice(message); setSheetTrip(null); }}
        />
      )}
      {activeCompanyId && editingTrip && (
        <StartTripDialog
          companyId={activeCompanyId}
          now={now}
          trip={editingTrip}
          canManage={canManage}
          timeZone={timeZone}
          onClose={() => setEditingTrip(null)}
          onSaved={(message) => { setNotice(message); setEditingTrip(null); }}
        />
      )}
      {activeCompanyId && deletingTrip && (
        <ConfirmDialog
          open
          title="Delete trip?"
          description={`This removes the trip to ${deletingTrip.destination} from history.`}
          onConfirm={async () => {
            await deleteTrip({ companyId: activeCompanyId, tripId: deletingTrip._id });
            setNotice("Trip deleted.");
          }}
          onClose={() => setDeletingTrip(null)}
        />
      )}
    </FleetPage>
  );
}

function TripsSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading trips">
      <SkeletonBlock className="h-5 w-24" />
      <div className="grid gap-2 lg:grid-cols-2">
        <SkeletonBlock className="h-24" />
        <SkeletonBlock className="h-24" />
      </div>
      <SkeletonBlock className="h-5 w-32" />
      {[0, 1, 2].map((index) => (
        <SkeletonBlock key={index} className="h-14" />
      ))}
    </div>
  );
}

function tripSheetFromRow(trip: FleetTripRow): TripSheetTrip {
  return {
    _id: trip._id,
    vehicleId: trip.vehicleId,
    vehicleName: trip.vehicle?.name ?? "Unknown vehicle",
    driverName: trip.driver?.name ?? null,
    destination: trip.destination,
    notes: trip.notes,
    status: trip.status,
    departedAt: trip.departedAt,
    returnedAt: trip.returnedAt,
    arrivedAt: trip.arrivedAt,
    autoReturned: trip.autoReturned,
    basePlaceId: trip.basePlaceId,
    placeId: trip.placeId,
    distanceKm: trip.distanceKm,
    actualDistanceKm: trip.actualDistanceKm,
    offRoute: trip.offRoute,
    maxDeviationKm: trip.maxDeviationKm,
  };
}

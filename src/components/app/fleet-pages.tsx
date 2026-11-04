"use client";

import { useAction, useMutation, usePaginatedQuery, useQuery, useQuery_experimental } from "convex/react";
import {
  AlertTriangle,
  ChevronsRight,
  ChevronRight,
  Clock,
  Fuel,
  Gauge,
  Loader2,
  MapPin,
  RefreshCw,
  Route,
  Settings2,
  Truck,
  Wrench,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, inputClassName } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { useMinuteNow } from "@/lib/use-minute-now";
import { useCompany } from "./company-context";
import { requestDetailDrawerClose } from "./detail-drawer-motion";
import {
  ConfirmDialog,
  FuelDialog,
  PhotoLightbox,
  RecordMenu,
  ServiceDialog,
  TripDialog,
  errorMessage,
} from "./fleet-dialogs";
import {
  formatAmount,
  formatDateOnly,
  formatDateTime,
  formatKm,
  formatKmPerL,
  formatLitres,
  monthOverMonthLabel,
  relativeTime,
  serviceRemainingLabel,
  serviceStatusLabel,
  serviceStatusTone,
  vehicleStatusChip,
  type FleetAlertRow,
  type FleetConnection,
  type FleetFuelRow,
  type FleetMaintenanceRow,
  type FleetServiceRow,
  type FleetTripRow,
  type FleetVehicleDetail,
  type FleetVehicleRow,
} from "./fleet-format";
import { FleetSettingsDialog } from "./fleet-settings";
import { PageHeader } from "./page-header";

export type FleetTab = "vehicles" | "trips" | "fuel" | "maintenance";
type LogState = { kind: "trip" | "fuel" | "service"; vehicleId?: Id<"fleetVehicles"> };

function hasCapability(active: { capabilities: string[] } | null | undefined, capability: string) {
  return Boolean(active?.capabilities.includes(capability));
}

function EmptyPanel({
  icon: Icon,
  title,
  body,
  action,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="task-empty">
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--surface-muted)] text-[var(--ink-faint)]">
        <Icon className="h-5 w-5" />
      </span>
      <div className="mt-3 text-[14px] font-semibold text-[var(--ink)]">{title}</div>
      <p className="mt-1 max-w-[300px] text-[13px] text-[var(--ink-muted)]">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

function TabSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Loading" aria-busy="true">
      {[0, 1, 2].map((index) => (
        <div key={index} className="h-32 animate-pulse rounded-md border border-[var(--hairline)] bg-[var(--surface-pressed)]" />
      ))}
    </div>
  );
}

function SectionHeading({ id, title, description, children }: { id?: string; title: string; description?: string; children?: React.ReactNode }) {
  return (
    <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
      <div className="min-w-0">
        <h2 id={id} className="text-sm font-semibold text-[var(--ink)]">{title}</h2>
        {description && <p className="mt-0.5 text-[12px] text-[var(--ink-muted)]">{description}</p>}
      </div>
      {children}
    </div>
  );
}

function LoadMore({
  status,
  onLoadMore,
  label,
}: {
  status: "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";
  onLoadMore: (count: number) => void;
  label: string;
}) {
  if (status === "Exhausted") return null;
  return (
    <div className="flex justify-center py-3" aria-live="polite">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-10"
        disabled={status !== "CanLoadMore"}
        onClick={() => onLoadMore(20)}
      >
        {status === "CanLoadMore" ? label : "Loading…"}
      </Button>
    </div>
  );
}

function AlertsPanel({
  alerts,
  now,
  onSelect,
}: {
  alerts: FleetAlertRow[];
  now: number;
  onSelect: (alert: FleetAlertRow) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const criticalCount = alerts.filter((alert) => alert.severity === "critical").length;
  const visible = expanded ? alerts : alerts.slice(0, 5);
  return (
    <section
      className="mb-4 rounded-lg border border-[var(--hairline)] bg-[var(--surface)]"
      aria-labelledby="fleet-alerts-heading"
    >
      <div className="flex items-center justify-between gap-3 border-b border-[var(--hairline)] px-3 py-2.5">
        <h2 id="fleet-alerts-heading" className="flex items-center gap-2 text-sm font-semibold text-[var(--ink)]">
          <AlertTriangle className="h-4 w-4 text-[var(--badge-yellow-fg)]" />
          Needs attention
          <Badge tone={criticalCount > 0 ? "red" : "yellow"}>{alerts.length}</Badge>
        </h2>
        {criticalCount > 0 && (
          <span className="text-[11px] font-medium uppercase tracking-[0.04em] text-[var(--badge-red-fg)]">
            {criticalCount} critical
          </span>
        )}
      </div>
      <ul className="divide-y divide-[var(--hairline)]">
        {visible.map((alert) => (
          <li key={alert.key}>
            <button
              type="button"
              onClick={() => onSelect(alert)}
              className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                  alert.severity === "critical" ? "bg-[var(--badge-red-fg)]" : "bg-[var(--badge-yellow-fg)]",
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-[13px] font-medium text-[var(--ink)]">{alert.title}</span>
                  {alert.at !== null && (
                    <span className="text-[11px] text-[var(--ink-faint)]">{relativeTime(alert.at, now)}</span>
                  )}
                </span>
                <span className="mt-0.5 block text-[12px] leading-4 text-[var(--ink-muted)]">{alert.message}</span>
              </span>
              <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-[var(--ink-faint)]" />
            </button>
          </li>
        ))}
      </ul>
      {alerts.length > 5 && (
        <div className="border-t border-[var(--hairline)] px-3 py-1.5">
          <button
            type="button"
            className="text-[12px] font-medium text-[var(--ink-secondary)] hover:text-[var(--ink)]"
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? "Show fewer" : `Show ${alerts.length - 5} more`}
          </button>
        </div>
      )}
    </section>
  );
}

function VehicleCard({
  vehicle,
  now,
  selected,
  onOpen,
}: {
  vehicle: FleetVehicleRow;
  now: number;
  selected: boolean;
  onOpen: () => void;
}) {
  const status = vehicleStatusChip(vehicle);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "group flex w-full flex-col gap-3 rounded-lg border border-[var(--hairline)] bg-[var(--surface)] p-4 text-left transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]",
        selected && "border-[var(--primary)]",
      )}
    >
      <span className="flex items-start justify-between gap-3">
        <span className="block min-w-0">
          <span className="block truncate text-base font-semibold tracking-[-0.01em] text-[var(--ink)]">{vehicle.name}</span>
          {vehicle.displayName && (
            <span className="block truncate text-[12px] text-[var(--ink-faint)]">{vehicle.registrationNumber}</span>
          )}
        </span>
        <Badge tone={status.tone}>{status.label}</Badge>
      </span>

      {vehicle.openTrip ? (
        <span className="block truncate text-[13px] text-[var(--ink-secondary)]">
          {vehicle.openTrip.driverName} → {vehicle.openTrip.destination}
        </span>
      ) : null}

      <span className="grid gap-1 text-[13px] text-[var(--ink-muted)]">
        <span className="flex items-center gap-1.5">
          <Gauge className="h-3.5 w-3.5 shrink-0 text-[var(--ink-faint)]" />
          {formatKm(vehicle.odometerKm)}
        </span>
        <span className="flex min-w-0 items-center gap-1.5">
          <Clock className="h-3.5 w-3.5 shrink-0 text-[var(--ink-faint)]" />
          <span className="shrink-0">{vehicle.lastSeenAt ? `Seen ${relativeTime(vehicle.lastSeenAt, now)}` : "Never seen"}</span>
          {vehicle.address && (
            <span className="truncate text-[var(--ink-faint)]">· {vehicle.address}</span>
          )}
        </span>
      </span>

      <span className="flex items-center justify-between gap-2 border-t border-[var(--hairline)] pt-3">
        <Badge tone={serviceStatusTone(vehicle.serviceStatus.status)}>
          {serviceStatusLabel(vehicle.serviceStatus.status)}
        </Badge>
        <ChevronRight className="h-4 w-4 text-[var(--ink-faint)] transition-transform group-hover:translate-x-0.5" />
      </span>
    </button>
  );
}

function VehiclesTab({
  companyId,
  now,
  selectedVehicleId,
}: {
  companyId: Id<"companies">;
  now: number;
  selectedVehicleId?: string;
}) {
  const router = useRouter();
  const result = useQuery(api.fleet.listVehicles, { companyId, now });

  if (result === undefined) return <TabSkeleton />;
  const vehicles = result.vehicles;
  if (vehicles.length === 0) {
    return (
      <EmptyPanel
        icon={Truck}
        title="No vehicles yet"
        body="The tracker is connected but has not reported any vehicles. Try Sync now, or check the tracker key in Settings."
      />
    );
  }

  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {vehicles.map((vehicle) => (
          <VehicleCard
            key={vehicle._id}
            vehicle={vehicle}
            now={now}
            selected={vehicle._id === selectedVehicleId}
            onOpen={() => router.push(`/fleet/${vehicle._id}`)}
          />
        ))}
      </div>
      {result.isTruncated && (
        <p className="mt-3 text-[12px] text-[var(--ink-faint)]">Showing the first 500 vehicles.</p>
      )}
    </div>
  );
}

function TripsTab({
  companyId,
  now,
  canLog,
  canManage,
  onLog,
}: {
  companyId: Id<"companies">;
  now: number;
  canLog: boolean;
  canManage: boolean;
  onLog: (kind: "trip") => void;
}) {
  const router = useRouter();
  const [vehicleFilter, setVehicleFilter] = useState("all");
  const [returningId, setReturningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingTrip, setEditingTrip] = useState<FleetTripRow | null>(null);
  const [deletingTrip, setDeletingTrip] = useState<FleetTripRow | null>(null);
  const returnTrip = useAction(api.fleet.returnTrip);
  const deleteTrip = useMutation(api.fleet.deleteTrip);
  const openTripsResult = useQuery(api.fleet.listOpenTrips, { companyId });
  const vehiclesResult = useQuery(api.fleet.listVehicles, { companyId, now });
  const paginationArgs = useMemo(
    () => ({
      companyId,
      ...(vehicleFilter !== "all" ? { vehicleId: vehicleFilter as Id<"fleetVehicles"> } : {}),
    }),
    [companyId, vehicleFilter],
  );
  const tripsQuery = usePaginatedQuery(api.fleet.listTrips, paginationArgs, { initialNumItems: 20 });
  const trips = tripsQuery.results as FleetTripRow[];
  const openTrips = (openTripsResult?.trips ?? []) as FleetTripRow[];

  async function markReturned(trip: FleetTripRow) {
    if (returningId) return;
    setReturningId(trip._id);
    setError(null);
    try {
      await returnTrip({ companyId, tripId: trip._id });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setReturningId(null);
    }
  }

  return (
    <div>
      <section className="mb-6" aria-labelledby="fleet-out-now">
        <SectionHeading
          id="fleet-out-now"
          title="Out now"
          description="Vehicles currently on a logged trip."
        />
        {openTripsResult === undefined ? (
          <div className="h-20 animate-pulse rounded-md border border-[var(--hairline)] bg-[var(--surface-pressed)]" />
        ) : openTrips.length === 0 ? (
          <p className="rounded-md border border-dashed border-[var(--hairline-strong)] px-3 py-4 text-[13px] text-[var(--ink-muted)]">
            No vehicles are out right now.
          </p>
        ) : (
          <div className="grid gap-2 lg:grid-cols-2">
            {openTrips.map((trip) => {
              const vehicleName = trip.vehicle?.name ?? "Unknown vehicle";
              const pending = returningId === trip._id;
              return (
                <div key={trip._id} className="rounded-md border border-[var(--hairline)] bg-[var(--surface)] p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <button
                        type="button"
                        className="truncate text-left text-sm font-semibold text-[var(--ink)] hover:underline"
                        onClick={() => router.push(`/fleet/${trip.vehicleId}`)}
                      >
                        {vehicleName}
                      </button>
                      <p className="truncate text-[13px] text-[var(--ink-secondary)]">
                        {trip.driver?.name ?? "Unknown driver"} → {trip.destination}
                      </p>
                      <p className="mt-0.5 text-[12px] text-[var(--ink-faint)]">
                        Departed {relativeTime(trip.departedAt, now)} · {formatDateTime(trip.departedAt)}
                      </p>
                    </div>
                    {canLog && (
                      <Button
                        type="button"
                        size="lg"
                        variant="primary"
                        className="h-11 shrink-0 px-4"
                        disabled={pending}
                        onClick={() => void markReturned(trip)}
                      >
                        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                        {pending ? "Marking…" : "Mark returned"}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {error && <p className="alert-error mb-3 rounded-md px-3 py-2 text-[13px]" role="alert">{error}</p>}

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-[var(--ink)]">Trip history</h2>
        {vehiclesResult && vehiclesResult.vehicles.length > 0 && (
          <label className="flex items-center gap-2 text-[12px] text-[var(--ink-muted)]">
            <span className="sr-only">Filter trips by vehicle</span>
            <select
              aria-label="Filter trips by vehicle"
              value={vehicleFilter}
              onChange={(event) => setVehicleFilter(event.target.value)}
              className={cn(inputClassName, "h-10 w-auto max-w-[220px] text-[13px]")}
            >
              <option value="all">All vehicles</option>
              {vehiclesResult.vehicles.map((vehicle) => (
                <option key={vehicle._id} value={vehicle._id}>{vehicle.name}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      {tripsQuery.status === "LoadingFirstPage" ? (
        <TabSkeleton />
      ) : trips.length === 0 ? (
        <EmptyPanel
          icon={Route}
          title={vehicleFilter === "all" ? "No trips yet" : "No trips for this vehicle"}
          body={vehicleFilter === "all" ? "Log a trip when a vehicle leaves the warehouse." : "Try another vehicle, or log a trip for this one."}
          action={canLog ? <Button type="button" variant="primary" onClick={() => onLog("trip")}>Log trip</Button> : undefined}
        />
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-md border border-[var(--hairline)] md:block">
            <table className="task-table min-w-[720px]">
              <thead>
                <tr>
                  <th scope="col">Vehicle</th>
                  <th scope="col">Driver</th>
                  <th scope="col">Destination</th>
                  <th scope="col">Departed</th>
                  <th scope="col">Returned</th>
                  <th scope="col" className="text-right">Distance</th>
                  {canManage && <th scope="col"><span className="sr-only">Actions</span></th>}
                </tr>
              </thead>
              <tbody>
                {trips.map((trip) => (
                  <tr key={trip._id}>
                    <td>
                      <button type="button" className="text-left font-medium text-[var(--ink)] hover:underline" onClick={() => router.push(`/fleet/${trip.vehicleId}`)}>
                        {trip.vehicle?.name ?? "Unknown vehicle"}
                      </button>
                      {trip.vehicle?.displayName && <div className="text-[11px] text-[var(--ink-faint)]">{trip.vehicle.registrationNumber}</div>}
                    </td>
                    <td>{trip.driver?.name ?? "—"}</td>
                    <td className="max-w-[220px] truncate">{trip.destination}</td>
                    <td className="whitespace-nowrap">{formatDateTime(trip.departedAt)}</td>
                    <td className="whitespace-nowrap">{trip.returnedAt ? formatDateTime(trip.returnedAt) : <Badge tone="blue">Out now</Badge>}</td>
                    <td className="text-right tabular-nums">{formatKm(trip.distanceKm)}</td>
                    {canManage && (
                      <td className="w-10">
                        <RecordMenu
                          label={`trip to ${trip.destination}`}
                          onEdit={() => setEditingTrip(trip)}
                          onDelete={() => setDeletingTrip(trip)}
                        />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid gap-2 md:hidden">
            {trips.map((trip) => (
              <div key={trip._id} className="rounded-md border border-[var(--hairline)] bg-[var(--surface)] p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-[var(--ink)]">{trip.vehicle?.name ?? "Unknown vehicle"}</div>
                    <div className="truncate text-[12px] text-[var(--ink-muted)]">{trip.driver?.name ?? "—"}</div>
                  </div>
                  {canManage && (
                    <RecordMenu
                      label={`trip to ${trip.destination}`}
                      onEdit={() => setEditingTrip(trip)}
                      onDelete={() => setDeletingTrip(trip)}
                    />
                  )}
                </div>
                <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[12px] text-[var(--ink-muted)]">
                  <div className="col-span-2 truncate"><span className="text-[var(--ink-faint)]">Destination </span>{trip.destination}</div>
                  <div><span className="text-[var(--ink-faint)]">Departed </span>{formatDateTime(trip.departedAt)}</div>
                  <div><span className="text-[var(--ink-faint)]">Returned </span>{trip.returnedAt ? formatDateTime(trip.returnedAt) : "Out now"}</div>
                  <div><span className="text-[var(--ink-faint)]">Distance </span>{formatKm(trip.distanceKm)}</div>
                </div>
              </div>
            ))}
          </div>

          <LoadMore status={tripsQuery.status} onLoadMore={tripsQuery.loadMore} label="Load more trips" />
        </>
      )}

      {editingTrip && (
        <TripDialog
          mode="edit"
          companyId={companyId}
          now={now}
          trip={editingTrip}
          onClose={() => setEditingTrip(null)}
        />
      )}
      {deletingTrip && (
        <ConfirmDialog
          open
          title="Delete trip?"
          description={`This removes the trip to ${deletingTrip.destination} from history.`}
          onConfirm={async () => { await deleteTrip({ companyId, tripId: deletingTrip._id }); }}
          onClose={() => setDeletingTrip(null)}
        />
      )}
    </div>
  );
}

function FuelStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-[var(--hairline)] bg-[var(--surface)] p-3">
      <div className="text-[11px] font-medium uppercase tracking-[0.04em] text-[var(--ink-faint)]">{label}</div>
      <div className="mt-1 text-lg font-semibold tracking-[-0.01em] text-[var(--ink)]">{value}</div>
    </div>
  );
}

function FuelTab({
  companyId,
  now,
  canLog,
  canManage,
  onLog,
}: {
  companyId: Id<"companies">;
  now: number;
  canLog: boolean;
  canManage: boolean;
  onLog: (kind: "fuel") => void;
}) {
  const [photo, setPhoto] = useState<{ url: string; label: string } | null>(null);
  const [editingEntry, setEditingEntry] = useState<FleetFuelRow | null>(null);
  const [deletingEntry, setDeletingEntry] = useState<FleetFuelRow | null>(null);
  const deleteFuelEntry = useMutation(api.fleet.deleteFuelEntry);
  const insights = useQuery(api.fleet.fuelInsights, { companyId, now });
  const fuelQuery = usePaginatedQuery(api.fleet.listFuelEntries, { companyId }, { initialNumItems: 20 });
  const rows = fuelQuery.results as FleetFuelRow[];

  return (
    <div>
      <section className="mb-5" aria-labelledby="fleet-fuel-summary">
        <SectionHeading id="fleet-fuel-summary" title="Spend this month" description="All fuel entries across the fleet." />
        {insights === undefined ? (
          <div className="grid gap-2 sm:grid-cols-3">
            {[0, 1, 2].map((index) => (
              <div key={index} className="h-20 animate-pulse rounded-md border border-[var(--hairline)] bg-[var(--surface-pressed)]" />
            ))}
          </div>
        ) : (
          <>
            <div className="grid gap-2 sm:grid-cols-3">
              <FuelStat label="This month" value={formatAmount(insights.fleet.currentMonthSpend)} />
              <FuelStat label="Last month" value={formatAmount(insights.fleet.previousMonthSpend)} />
              <FuelStat label="Change" value={monthOverMonthLabel(insights.fleet.monthOverMonthChange)} />
            </div>
            {insights.fleet.spendSpike && (
              <p className="mt-2 flex items-start gap-1.5 text-[12px] text-[var(--badge-yellow-fg)]">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                Spend is above 130% of the previous three-month average.
              </p>
            )}
            {insights.isTruncated && (
              <p className="mt-2 text-[12px] text-[var(--ink-faint)]">Based on the most recent 2,000 fill-ups.</p>
            )}
            {insights.byVehicle.length > 0 && (
              <div className="mt-3 rounded-md border border-[var(--hairline)] bg-[var(--surface)]">
                <h3 className="border-b border-[var(--hairline)] px-3 py-2 text-[12px] font-medium text-[var(--ink-muted)]">
                  By vehicle
                </h3>
                <ul className="divide-y divide-[var(--hairline)]">
                  {insights.byVehicle.map((row) => (
                    <li
                      key={row.vehicleId}
                      className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-[13px] font-medium text-[var(--ink)]">{row.name}</span>
                        {row.spendSpike && <Badge tone="yellow">Spike</Badge>}
                      </div>
                      <div className="flex items-center justify-between gap-3 text-[12px] sm:justify-end">
                        <span className="tabular-nums text-[var(--ink)]">{formatAmount(row.currentMonthSpend)}</span>
                        <span className="text-[var(--ink-muted)]">{monthOverMonthLabel(row.monthOverMonthChange)}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </section>

      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-[var(--ink)]">Fuel entries</h2>
      </div>

      {fuelQuery.status === "LoadingFirstPage" ? (
        <TabSkeleton />
      ) : rows.length === 0 ? (
        <EmptyPanel
          icon={Fuel}
          title="No fuel entries yet"
          body="Log a fill-up with a photo of the fuel gauge or receipt."
          action={canLog ? <Button type="button" variant="primary" onClick={() => onLog("fuel")}>Log fuel</Button> : undefined}
        />
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-md border border-[var(--hairline)] md:block">
            <table className="task-table min-w-[760px]">
              <thead>
                <tr>
                  <th scope="col">Vehicle</th>
                  <th scope="col">Date</th>
                  <th scope="col" className="text-right">Litres</th>
                  <th scope="col" className="text-right">Amount</th>
                  <th scope="col" className="text-right">Efficiency</th>
                  <th scope="col">Photo</th>
                  {canManage && <th scope="col"><span className="sr-only">Actions</span></th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((entry) => {
                  const name = entry.vehicle?.name ?? "Unknown vehicle";
                  return (
                    <tr key={entry._id}>
                      <td className="font-medium text-[var(--ink)]">{name}</td>
                      <td className="whitespace-nowrap">{formatDateTime(entry.filledAt)}</td>
                      <td className="text-right tabular-nums">{formatLitres(entry.litres)}</td>
                      <td className="text-right tabular-nums">{formatAmount(entry.amount)}</td>
                      <td className="text-right tabular-nums">
                        <div>{formatKmPerL(entry.kmPerL)}</div>
                        {entry.anomaly && (
                          <div className="text-[11px] text-[var(--badge-red-fg)]">
                            Low · median {formatKmPerL(entry.medianKmPerL)}
                          </div>
                        )}
                      </td>
                      <td>
                        {entry.photo.url ? (
                          <button
                            type="button"
                            className="h-9 w-9 rounded border border-[var(--hairline)] bg-[var(--surface-muted)] bg-cover bg-center"
                            style={{ backgroundImage: `url(${entry.photo.url})` }}
                            aria-label={`View fuel photo for ${name}`}
                            onClick={() => setPhoto({ url: entry.photo.url!, label: `Fuel photo · ${name}` })}
                          />
                        ) : (
                          <span className="text-[var(--ink-faint)]">—</span>
                        )}
                      </td>
                      {canManage && (
                        <td className="w-10">
                          <RecordMenu
                            label={`fuel entry for ${name}`}
                            onEdit={() => setEditingEntry(entry)}
                            onDelete={() => setDeletingEntry(entry)}
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
            {rows.map((entry) => {
              const name = entry.vehicle?.name ?? "Unknown vehicle";
              return (
                <div key={entry._id} className="rounded-md border border-[var(--hairline)] bg-[var(--surface)] p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      {entry.photo.url ? (
                        <button
                          type="button"
                          className="h-12 w-12 shrink-0 rounded border border-[var(--hairline)] bg-[var(--surface-muted)] bg-cover bg-center"
                          style={{ backgroundImage: `url(${entry.photo.url})` }}
                          aria-label={`View fuel photo for ${name}`}
                          onClick={() => setPhoto({ url: entry.photo.url!, label: `Fuel photo · ${name}` })}
                        />
                      ) : null}
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-[var(--ink)]">{name}</div>
                        <div className="text-[12px] text-[var(--ink-faint)]">{formatDateTime(entry.filledAt)}</div>
                      </div>
                    </div>
                    {canManage && (
                      <RecordMenu
                        label={`fuel entry for ${name}`}
                        onEdit={() => setEditingEntry(entry)}
                        onDelete={() => setDeletingEntry(entry)}
                      />
                    )}
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[12px] text-[var(--ink-muted)]">
                    <div><span className="text-[var(--ink-faint)]">Litres </span>{formatLitres(entry.litres)}</div>
                    <div><span className="text-[var(--ink-faint)]">Amount </span>{formatAmount(entry.amount)}</div>
                    <div className="col-span-2">
                      <span className="text-[var(--ink-faint)]">Efficiency </span>{formatKmPerL(entry.kmPerL)}
                      {entry.anomaly && (
                        <span className="ml-2 text-[var(--badge-red-fg)]">Low · median {formatKmPerL(entry.medianKmPerL)}</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <LoadMore status={fuelQuery.status} onLoadMore={fuelQuery.loadMore} label="Load more fuel entries" />
        </>
      )}

      {photo && <PhotoLightbox url={photo.url} label={photo.label} onClose={() => setPhoto(null)} />}
      {editingEntry && (
        <FuelDialog
          mode="edit"
          companyId={companyId}
          now={now}
          entry={editingEntry}
          onClose={() => setEditingEntry(null)}
        />
      )}
      {deletingEntry && (
        <ConfirmDialog
          open
          title="Delete fuel entry?"
          description={`This removes the fuel entry for ${deletingEntry.vehicle?.name ?? "this vehicle"} and its photo.`}
          onConfirm={async () => { await deleteFuelEntry({ companyId, entryId: deletingEntry._id }); }}
          onClose={() => setDeletingEntry(null)}
        />
      )}
    </div>
  );
}

function MaintenanceRow({
  row,
  canLog,
  onOpen,
  onLog,
}: {
  row: FleetMaintenanceRow;
  canLog: boolean;
  onOpen: () => void;
  onLog: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--hairline)] bg-[var(--surface)] p-3">
      <button type="button" className="min-w-0 flex-1 text-left" onClick={onOpen}>
        <span className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-semibold text-[var(--ink)]">{row.name}</span>
          <Badge tone={serviceStatusTone(row.serviceStatus.status)}>
            {serviceStatusLabel(row.serviceStatus.status)}
          </Badge>
        </span>
        {row.displayName && <span className="block text-[11px] text-[var(--ink-faint)]">{row.registrationNumber}</span>}
        <span className="mt-0.5 block text-[12px] text-[var(--ink-muted)]">
          {row.serviceStatus.status === "not_configured"
            ? "Set a service interval in the vehicle drawer."
            : row.serviceStatus.status === "unknown"
              ? "Log the last service to start tracking."
              : serviceRemainingLabel(row.serviceStatus)}
        </span>
      </button>
      {canLog && (
        <Button type="button" variant="secondary" className="h-10" onClick={onLog}>
          <Wrench className="h-4 w-4" />
          Log service
        </Button>
      )}
    </div>
  );
}

function MaintenanceTab({
  companyId,
  now,
  canLog,
  canManage,
  onLog,
}: {
  companyId: Id<"companies">;
  now: number;
  canLog: boolean;
  canManage: boolean;
  onLog: (kind: "service", vehicleId?: Id<"fleetVehicles">) => void;
}) {
  const router = useRouter();
  const [editingEntry, setEditingEntry] = useState<FleetServiceRow | null>(null);
  const [deletingEntry, setDeletingEntry] = useState<FleetServiceRow | null>(null);
  const deleteServiceEntry = useMutation(api.fleet.deleteServiceEntry);
  const dueResult = useQuery(api.fleet.maintenanceStatus, { companyId, now });
  const serviceQuery = usePaginatedQuery(api.fleet.listServiceEntries, { companyId }, { initialNumItems: 20 });
  const rows = serviceQuery.results as FleetServiceRow[];
  const allNotConfigured = Boolean(
    dueResult && dueResult.rows.length > 0 && dueResult.rows.every((row) => row.serviceStatus.status === "not_configured"),
  );

  return (
    <div>
      <section className="mb-6" aria-labelledby="fleet-service-schedule">
        <SectionHeading
          id="fleet-service-schedule"
          title="Service schedule"
          description="Sorted by urgency. Set intervals from a vehicle's drawer."
        />
        {dueResult === undefined ? (
          <div className="grid gap-2">
            {[0, 1].map((index) => (
              <div key={index} className="h-16 animate-pulse rounded-md border border-[var(--hairline)] bg-[var(--surface-pressed)]" />
            ))}
          </div>
        ) : dueResult.rows.length === 0 ? (
          <p className="rounded-md border border-dashed border-[var(--hairline-strong)] px-3 py-4 text-[13px] text-[var(--ink-muted)]">
            No vehicles yet. Connect the tracker and sync to see the service schedule.
          </p>
        ) : (
          <div className="grid gap-2">
            {allNotConfigured && (
              <p className="rounded-md border border-[var(--hairline)] bg-[var(--surface-muted)] px-3 py-2 text-[12px] text-[var(--ink-muted)]">
                Set a service interval on a vehicle to start tracking due dates and distances.
              </p>
            )}
            {dueResult.rows.map((row) => (
              <MaintenanceRow
                key={row.vehicleId}
                row={row}
                canLog={canLog}
                onOpen={() => router.push(`/fleet/${row.vehicleId}`)}
                onLog={() => onLog("service", row.vehicleId)}
              />
            ))}
          </div>
        )}
        {dueResult?.isTruncated && (
          <p className="mt-2 text-[12px] text-[var(--ink-faint)]">Showing the first 500 vehicles.</p>
        )}
      </section>

      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-[var(--ink)]">Service history</h2>
      </div>

      {serviceQuery.status === "LoadingFirstPage" ? (
        <TabSkeleton />
      ) : rows.length === 0 ? (
        <EmptyPanel
          icon={Wrench}
          title="No service entries yet"
          body="Log the last service so Cendro can track the next one."
          action={canLog ? <Button type="button" variant="primary" onClick={() => onLog("service")}>Log service</Button> : undefined}
        />
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-md border border-[var(--hairline)] md:block">
            <table className="task-table min-w-[720px]">
              <thead>
                <tr>
                  <th scope="col">Vehicle</th>
                  <th scope="col">Date</th>
                  <th scope="col">Description</th>
                  <th scope="col" className="text-right">Odometer</th>
                  <th scope="col" className="text-right">Cost</th>
                  {canManage && <th scope="col"><span className="sr-only">Actions</span></th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((entry) => {
                  const name = entry.vehicle?.name ?? "Unknown vehicle";
                  return (
                    <tr key={entry._id}>
                      <td className="font-medium text-[var(--ink)]">{name}</td>
                      <td className="whitespace-nowrap">{formatDateOnly(entry.servicedAt)}</td>
                      <td className="max-w-[260px] truncate">{entry.description}</td>
                      <td className="text-right tabular-nums">{formatKm(entry.odometerKm)}</td>
                      <td className="text-right tabular-nums">{entry.cost == null ? "—" : formatAmount(entry.cost)}</td>
                      {canManage && (
                        <td className="w-10">
                          <RecordMenu
                            label={`service for ${name}`}
                            onEdit={() => setEditingEntry(entry)}
                            onDelete={() => setDeletingEntry(entry)}
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
            {rows.map((entry) => {
              const name = entry.vehicle?.name ?? "Unknown vehicle";
              return (
                <div key={entry._id} className="rounded-md border border-[var(--hairline)] bg-[var(--surface)] p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-[var(--ink)]">{name}</div>
                      <div className="text-[12px] text-[var(--ink-faint)]">{formatDateOnly(entry.servicedAt)}</div>
                    </div>
                    {canManage && (
                      <RecordMenu
                        label={`service for ${name}`}
                        onEdit={() => setEditingEntry(entry)}
                        onDelete={() => setDeletingEntry(entry)}
                      />
                    )}
                  </div>
                  <p className="mt-1 text-[13px] text-[var(--ink-secondary)]">{entry.description}</p>
                  <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-[12px] text-[var(--ink-muted)]">
                    <div><span className="text-[var(--ink-faint)]">Odometer </span>{formatKm(entry.odometerKm)}</div>
                    <div><span className="text-[var(--ink-faint)]">Cost </span>{entry.cost == null ? "—" : formatAmount(entry.cost)}</div>
                  </div>
                </div>
              );
            })}
          </div>

          <LoadMore status={serviceQuery.status} onLoadMore={serviceQuery.loadMore} label="Load more service entries" />
        </>
      )}

      {editingEntry && (
        <ServiceDialog
          mode="edit"
          companyId={companyId}
          now={now}
          entry={editingEntry}
          onClose={() => setEditingEntry(null)}
        />
      )}
      {deletingEntry && (
        <ConfirmDialog
          open
          title="Delete service entry?"
          description={`This removes "${deletingEntry.description}" from history.`}
          onConfirm={async () => { await deleteServiceEntry({ companyId, entryId: deletingEntry._id }); }}
          onClose={() => setDeletingEntry(null)}
        />
      )}
    </div>
  );
}

function NotConnectedPanel({ canManage, onConnect }: { canManage: boolean; onConnect: () => void }) {
  return (
    <EmptyPanel
      icon={Truck}
      title="Connect your tracker"
      body={
        canManage
          ? "Add your TrackWorld / portalxs secret key to import vehicles, positions and odometers. Trips, fuel and service stay manual."
          : "Ask an admin to connect the company's GPS tracker. Vehicles and odometers will appear here automatically."
      }
      action={
        canManage ? (
          <Button type="button" variant="primary" className="h-10" onClick={onConnect}>
            Connect tracker
          </Button>
        ) : undefined
      }
    />
  );
}

export function FleetList({
  selectedVehicleId,
  tab,
  onTabChange,
}: {
  selectedVehicleId?: string;
  tab: FleetTab;
  onTabChange: (tab: FleetTab) => void;
}) {
  const { activeCompanyId, active } = useCompany();
  return (
    <FleetListContent
      key={`${activeCompanyId}:${active?.membership._id ?? "none"}`}
      selectedVehicleId={selectedVehicleId}
      tab={tab}
      onTabChange={onTabChange}
    />
  );
}

function FleetListContent({
  selectedVehicleId,
  tab,
  onTabChange,
}: {
  selectedVehicleId?: string;
  tab: FleetTab;
  onTabChange: (tab: FleetTab) => void;
}) {
  const router = useRouter();
  const { activeCompanyId, active } = useCompany();
  const now = useMinuteNow();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [log, setLog] = useState<LogState | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const canView = hasCapability(active, "fleet:view");
  const canLog = hasCapability(active, "fleet:log");
  const canManage = hasCapability(active, "fleet:manage");
  const connectionResult = useQuery(
    api.fleet.getConnection,
    activeCompanyId && canView ? { companyId: activeCompanyId } : "skip",
  );
  const connection = connectionResult as FleetConnection | undefined;
  const connected = connection?.connected === true;
  const alertsResult = useQuery(
    api.fleet.alerts,
    activeCompanyId && canView && connected ? { companyId: activeCompanyId, now } : "skip",
  );
  const syncNow = useAction(api.fleet.syncNow);

  async function handleSync() {
    if (!activeCompanyId || syncing) return;
    setSyncing(true);
    setSyncError(null);
    setSyncNote(null);
    try {
      const result = await syncNow({ companyId: activeCompanyId });
      setSyncNote(
        result.skipped
          ? "Already synced a moment ago."
          : `Synced ${result.vehicleCount ?? 0} vehicle${result.vehicleCount === 1 ? "" : "s"}.`,
      );
    } catch (err) {
      setSyncError(errorMessage(err));
    } finally {
      setSyncing(false);
    }
  }

  function openAlert(alert: FleetAlertRow) {
    if (alert.vehicleId) {
      router.push(`/fleet/${alert.vehicleId}`);
      return;
    }
    if (alert.kind === "tracker_sync_failing" && canManage) {
      setSettingsOpen(true);
      return;
    }
    if (alert.kind === "fuel_spend_spike") {
      onTabChange("fuel");
      return;
    }
    onTabChange("vehicles");
  }

  if (!canView) {
    return (
      <div>
        <PageHeader title="Fleet" description="Vehicles, trips, fuel and service in one place." />
        <EmptyPanel
          icon={Truck}
          title="Fleet is not available"
          body="You do not have access to Fleet in this workspace."
        />
      </div>
    );
  }

  const actions = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {connected && canLog && (
        <div className="flex w-full gap-2 sm:w-auto">
          <Button type="button" size="lg" variant="primary" className="h-10 flex-1 px-2 text-[13px] sm:flex-none sm:px-3 sm:text-sm" onClick={() => setLog({ kind: "trip" })}>
            <Route className="hidden h-4 w-4 sm:block" />
            Log trip
          </Button>
          <Button type="button" size="lg" variant="primary" className="h-10 flex-1 px-2 text-[13px] sm:flex-none sm:px-3 sm:text-sm" onClick={() => setLog({ kind: "fuel" })}>
            <Fuel className="hidden h-4 w-4 sm:block" />
            Log fuel
          </Button>
          <Button type="button" size="lg" variant="primary" className="h-10 flex-1 px-2 text-[13px] sm:flex-none sm:px-3 sm:text-sm" onClick={() => setLog({ kind: "service" })}>
            <Wrench className="hidden h-4 w-4 sm:block" />
            Log service
          </Button>
        </div>
      )}
      {connected && (
        <div className="flex items-center gap-2">
          <Button type="button" variant="secondary" className="h-10" onClick={() => void handleSync()} disabled={syncing}>
            <RefreshCw className={cn("h-4 w-4", syncing && "animate-spin")} />
            {syncing ? "Syncing…" : "Sync now"}
          </Button>
          <span className="text-[11px] text-[var(--ink-faint)]" aria-live="polite">
            {connection?.lastSyncAt ? `Synced ${relativeTime(connection.lastSyncAt, now)}` : "Not synced yet"}
          </span>
        </div>
      )}
      {canManage && (
        <Button type="button" variant="secondary" className="h-10" onClick={() => setSettingsOpen(true)}>
          <Settings2 className="h-4 w-4" />
          Settings
        </Button>
      )}
    </div>
  );

  return (
    <div>
      <PageHeader
        title="Fleet"
        description="Vehicles, trips, fuel and service in one place."
        actions={actions}
      />

      {syncError && <p className="alert-error mb-3 rounded-md px-3 py-2 text-[13px]" role="alert">{syncError}</p>}
      {syncNote && (
        <p className="mb-3 rounded-md bg-[var(--surface-muted)] px-3 py-2 text-[13px] text-[var(--ink-secondary)]" role="status">
          {syncNote}
        </p>
      )}

      {connectionResult === undefined ? (
        <TabSkeleton />
      ) : !connected ? (
        <NotConnectedPanel canManage={canManage} onConnect={() => setSettingsOpen(true)} />
      ) : (
        <>
          {alertsResult && alertsResult.alerts.length > 0 && (
            <AlertsPanel alerts={alertsResult.alerts as FleetAlertRow[]} now={now} onSelect={openAlert} />
          )}

          <Tabs value={tab} onValueChange={(value) => onTabChange(value as FleetTab)}>
            <TabsList className="mb-4 grid w-full grid-cols-2 gap-0.5 sm:flex sm:w-auto">
              <TabsTrigger value="vehicles" className="inline-flex min-h-9 items-center justify-center px-2 sm:px-3">Vehicles</TabsTrigger>
              <TabsTrigger value="trips" className="inline-flex min-h-9 items-center justify-center px-2 sm:px-3">Trips</TabsTrigger>
              <TabsTrigger value="fuel" className="inline-flex min-h-9 items-center justify-center px-2 sm:px-3">Fuel</TabsTrigger>
              <TabsTrigger value="maintenance" className="inline-flex min-h-9 items-center justify-center px-2 sm:px-3">Maintenance</TabsTrigger>
            </TabsList>

            <TabsContent value="vehicles">
              <VehiclesTab
                companyId={activeCompanyId!}
                now={now}
                selectedVehicleId={selectedVehicleId}
              />
            </TabsContent>
            <TabsContent value="trips">
              <TripsTab
                companyId={activeCompanyId!}
                now={now}
                canLog={canLog}
                canManage={canManage}
                onLog={(kind) => setLog({ kind })}
              />
            </TabsContent>
            <TabsContent value="fuel">
              <FuelTab
                companyId={activeCompanyId!}
                now={now}
                canLog={canLog}
                canManage={canManage}
                onLog={(kind) => setLog({ kind })}
              />
            </TabsContent>
            <TabsContent value="maintenance">
              <MaintenanceTab
                companyId={activeCompanyId!}
                now={now}
                canLog={canLog}
                canManage={canManage}
                onLog={(kind, vehicleId) => setLog({ kind, vehicleId })}
              />
            </TabsContent>
          </Tabs>
        </>
      )}

      {settingsOpen && activeCompanyId && (
        <FleetSettingsDialog
          open
          onOpenChange={setSettingsOpen}
          companyId={activeCompanyId}
          now={now}
          connection={connection}
        />
      )}

      {activeCompanyId && log?.kind === "trip" && (
        <TripDialog
          mode="create"
          companyId={activeCompanyId}
          now={now}
          preselectedVehicleId={log.vehicleId}
          onClose={() => setLog(null)}
        />
      )}
      {activeCompanyId && log?.kind === "fuel" && (
        <FuelDialog
          mode="create"
          companyId={activeCompanyId}
          now={now}
          preselectedVehicleId={log.vehicleId}
          onClose={() => setLog(null)}
        />
      )}
      {activeCompanyId && log?.kind === "service" && (
        <ServiceDialog
          mode="create"
          companyId={activeCompanyId}
          now={now}
          preselectedVehicleId={log.vehicleId}
          onClose={() => setLog(null)}
        />
      )}
    </div>
  );
}

function DetailLine({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ink-faint)]" />
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-medium uppercase tracking-[0.04em] text-[var(--ink-faint)]">{label}</div>
        <div className="break-words text-[13px] text-[var(--ink)]">{value}</div>
      </div>
    </div>
  );
}

function RenameForm({ companyId, vehicle }: { companyId: Id<"companies">; vehicle: FleetVehicleRow }) {
  const renameVehicle = useMutation(api.fleet.renameVehicle);
  const [name, setName] = useState(vehicle.displayName ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await renameVehicle({ companyId, vehicleId: vehicle._id, displayName: name.trim() });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="mt-4 rounded-md border border-[var(--hairline)] p-3" onSubmit={submit}>
      <label htmlFor="fleet-vehicle-name" className="text-[13px] font-medium text-[var(--ink-secondary)]">
        Vehicle name
      </label>
      <div className="mt-1.5 flex gap-2">
        <Input
          id="fleet-vehicle-name"
          className="h-10 text-sm"
          value={name}
          maxLength={100}
          placeholder={vehicle.registrationNumber}
          onChange={(event) => setName(event.target.value)}
        />
        <Button type="submit" variant="secondary" className="h-10 shrink-0" disabled={saving}>
          {saving ? "Saving…" : "Rename"}
        </Button>
      </div>
      <p className="mt-1 text-[11px] text-[var(--ink-faint)]">Leave blank to use the registration number.</p>
      {error && <p className="alert-error mt-2 rounded-md px-2 py-1.5 text-[12px]" role="alert">{error}</p>}
    </form>
  );
}

function ServiceIntervalForm({ companyId, vehicle }: { companyId: Id<"companies">; vehicle: FleetVehicleRow }) {
  const setServiceInterval = useMutation(api.fleet.setServiceInterval);
  const [km, setKm] = useState(vehicle.serviceStatus.serviceIntervalKm?.toString() ?? "");
  const [days, setDays] = useState(vehicle.serviceStatus.serviceIntervalDays?.toString() ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    const kmValue = km.trim() === "" ? null : Number(km);
    const daysValue = days.trim() === "" ? null : Number(days);
    if (kmValue !== null && (!Number.isFinite(kmValue) || kmValue <= 0)) {
      setError("Service distance must be greater than zero.");
      return;
    }
    if (daysValue !== null && (!Number.isInteger(daysValue) || daysValue <= 0)) {
      setError("Service interval must be a whole number of days.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await setServiceInterval({
        companyId,
        vehicleId: vehicle._id,
        serviceIntervalKm: kmValue,
        serviceIntervalDays: daysValue,
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="mt-4 rounded-md border border-[var(--hairline)] p-3" onSubmit={submit}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <label htmlFor="fleet-service-interval-km" className="text-[13px] font-medium text-[var(--ink-secondary)]">
            Every (km)
          </label>
          <Input
            id="fleet-service-interval-km"
            className="h-10 text-sm"
            inputMode="numeric"
            value={km}
            onChange={(event) => setKm(event.target.value)}
            placeholder="e.g. 5000"
          />
        </div>
        <div className="grid gap-1.5">
          <label htmlFor="fleet-service-interval-days" className="text-[13px] font-medium text-[var(--ink-secondary)]">
            Every (days)
          </label>
          <Input
            id="fleet-service-interval-days"
            className="h-10 text-sm"
            inputMode="numeric"
            value={days}
            onChange={(event) => setDays(event.target.value)}
            placeholder="e.g. 180"
          />
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <p className="text-[11px] text-[var(--ink-faint)]">Either or both. Leave blank to stop tracking that dimension.</p>
        <Button type="submit" variant="secondary" className="h-10 shrink-0" disabled={saving}>
          {saving ? "Saving…" : "Save interval"}
        </Button>
      </div>
      {error && <p className="alert-error mt-2 rounded-md px-2 py-1.5 text-[12px]" role="alert">{error}</p>}
    </form>
  );
}

function VehicleDetailSkeleton() {
  return (
    <div className="animate-pulse">
      <div className="h-8 w-48 rounded bg-[var(--surface-pressed)]" />
      <div className="mt-3 h-4 w-64 rounded bg-[var(--surface-pressed)]" />
      <div className="mt-6 h-40 rounded-md bg-[var(--surface-pressed)]" />
      <div className="mt-4 h-24 rounded-md bg-[var(--surface-pressed)]" />
    </div>
  );
}

export function VehicleDetail({ id }: { id: string }) {
  const { activeCompanyId, active } = useCompany();
  return (
    <VehicleDetailContent
      key={`${activeCompanyId}:${id}:${active?.membership._id ?? "none"}`}
      id={id}
    />
  );
}

function VehicleDetailContent({ id }: { id: string }) {
  const router = useRouter();
  const { activeCompanyId, active } = useCompany();
  const now = useMinuteNow();
  const [log, setLog] = useState<LogState | null>(null);
  const canLog = hasCapability(active, "fleet:log");
  const canManage = hasCapability(active, "fleet:manage");
  const detailResult = useQuery_experimental({
    query: api.fleet.getVehicle,
    args: activeCompanyId
      ? { companyId: activeCompanyId, vehicleId: id as Id<"fleetVehicles">, now }
      : "skip",
  });
  const detail = detailResult.status === "success" ? (detailResult.data as FleetVehicleDetail) : undefined;

  function close() {
    if (!requestDetailDrawerClose("/fleet")) router.push("/fleet");
  }

  if (detailResult.status === "error") {
    return (
      <div className="task-empty">
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--surface-muted)] text-[var(--ink-faint)]">
          <Truck className="h-5 w-5" />
        </span>
        <div className="mt-3 text-[14px] font-semibold text-[var(--ink)]">Vehicle not found</div>
        <p className="mt-1 max-w-[300px] text-[13px] text-[var(--ink-muted)]">
          This vehicle may have been removed, or you no longer have access to it.
        </p>
        <Button className="mt-4" size="sm" variant="ghost" onClick={close}>Back to fleet</Button>
      </div>
    );
  }

  if (!detail) {
    return (
      <div>
        <div className="-mt-7 -mx-6 mb-5 flex items-center gap-1 px-2 md:-mt-8 md:-mx-9 md:px-3">
          <button type="button" className="task-icon-btn" aria-label="Close vehicle details" onClick={close}>
            <ChevronsRight className="h-5 w-5" />
          </button>
        </div>
        <VehicleDetailSkeleton />
      </div>
    );
  }

  const vehicle = detail.vehicle;
  const status = vehicleStatusChip(vehicle);

  return (
    <div>
      <div className="-mt-7 -mx-6 mb-5 flex items-center gap-1 border-b border-[var(--hairline)] px-2 pb-2 md:-mt-8 md:-mx-9 md:px-3 lg:border-0">
        <button type="button" className="task-icon-btn" aria-label="Close vehicle details" onClick={close}>
          <ChevronsRight className="h-5 w-5" />
        </button>
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--ink-faint)]">Vehicle</span>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="break-words text-xl font-semibold tracking-[-0.02em] text-[var(--ink)]">{vehicle.name}</h2>
          {vehicle.displayName && (
            <p className="mt-0.5 text-[13px] text-[var(--ink-faint)]">{vehicle.registrationNumber}</p>
          )}
        </div>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {canLog && vehicle.status !== "on_trip" && (
          <Button type="button" variant="primary" className="h-10" onClick={() => setLog({ kind: "trip", vehicleId: vehicle._id })}>
            <Route className="h-4 w-4" />
            Log trip
          </Button>
        )}
        {canLog && (
          <>
            <Button type="button" variant="secondary" className="h-10" onClick={() => setLog({ kind: "fuel", vehicleId: vehicle._id })}>
              <Fuel className="h-4 w-4" />
              Log fuel
            </Button>
            <Button type="button" variant="secondary" className="h-10" onClick={() => setLog({ kind: "service", vehicleId: vehicle._id })}>
              <Wrench className="h-4 w-4" />
              Log service
            </Button>
          </>
        )}
      </div>

      <div className="mt-4 grid gap-3 rounded-md border border-[var(--hairline)] bg-[var(--surface)] p-3">
        <DetailLine icon={Gauge} label="Odometer" value={formatKm(vehicle.odometerKm)} />
        <DetailLine
          icon={Clock}
          label="Last seen"
          value={vehicle.lastSeenAt ? relativeTime(vehicle.lastSeenAt, now) : "Never seen"}
        />
        <DetailLine icon={MapPin} label="Last known address" value={vehicle.address || "—"} />
        {vehicle.openTrip && (
          <DetailLine
            icon={Route}
            label="On trip"
            value={`${vehicle.openTrip.driverName} → ${vehicle.openTrip.destination} · departed ${relativeTime(vehicle.openTrip.departedAt, now)}`}
          />
        )}
        <DetailLine
          icon={Wrench}
          label="Service"
          value={
            <span className="flex flex-wrap items-center gap-2">
              <Badge tone={serviceStatusTone(vehicle.serviceStatus.status)}>
                {serviceStatusLabel(vehicle.serviceStatus.status)}
              </Badge>
              <span className="text-[12px] text-[var(--ink-muted)]">
                {vehicle.serviceStatus.status === "not_configured"
                  ? "No interval set"
                  : vehicle.serviceStatus.status === "unknown"
                    ? "Log the last service to start tracking"
                    : serviceRemainingLabel(vehicle.serviceStatus)}
              </span>
            </span>
          }
        />
      </div>

      {canManage && (
        <>
          <RenameForm companyId={activeCompanyId!} vehicle={vehicle} />
          <ServiceIntervalForm companyId={activeCompanyId!} vehicle={vehicle} />
        </>
      )}

      <section className="mt-6" aria-labelledby="fleet-recent-trips">
        <SectionHeading id="fleet-recent-trips" title="Recent trips" />
        {detail.recentTrips.length === 0 ? (
          <p className="text-[13px] text-[var(--ink-muted)]">No trips logged yet.</p>
        ) : (
          <div className="divide-y divide-[var(--hairline)] rounded-md border border-[var(--hairline)] bg-[var(--surface)]">
            {detail.recentTrips.map((trip) => (
              <div key={trip._id} className="px-3 py-2.5">
                <div className="flex flex-wrap items-center justify-between gap-1">
                  <span className="text-[13px] font-medium text-[var(--ink)]">{trip.destination}</span>
                  <Badge tone={trip.status === "open" ? "blue" : "neutral"}>
                    {trip.status === "open" ? "Out now" : "Returned"}
                  </Badge>
                </div>
                <div className="mt-0.5 text-[12px] text-[var(--ink-muted)]">
                  {trip.driverName ?? "Unknown driver"} · {formatDateTime(trip.departedAt)}
                  {trip.returnedAt ? ` – ${formatDateTime(trip.returnedAt)}` : ""} · {formatKm(trip.distanceKm)}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="mt-6" aria-labelledby="fleet-recent-fuel">
        <SectionHeading id="fleet-recent-fuel" title="Recent fuel" description="Efficiency is full-to-full between fill-ups." />
        {detail.recentFuel.length === 0 ? (
          <p className="text-[13px] text-[var(--ink-muted)]">No fuel entries yet.</p>
        ) : (
          <div className="divide-y divide-[var(--hairline)] rounded-md border border-[var(--hairline)] bg-[var(--surface)]">
            {detail.recentFuel.map((entry) => (
              <div key={entry._id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                <div className="min-w-0">
                  <div className="text-[13px] text-[var(--ink)]">
                    {formatLitres(entry.litres)} · {formatAmount(entry.amount)}
                  </div>
                  <div className="text-[12px] text-[var(--ink-muted)]">
                    {formatDateTime(entry.filledAt)}
                    {entry.driverName ? ` · ${entry.driverName}` : ""}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[13px] tabular-nums text-[var(--ink)]">{formatKmPerL(entry.kmPerL)}</div>
                  {entry.anomaly && (
                    <div className="text-[11px] text-[var(--badge-red-fg)]">
                      Low · median {formatKmPerL(entry.medianKmPerL)}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="mt-6" aria-labelledby="fleet-recent-services">
        <SectionHeading id="fleet-recent-services" title="Recent services" />
        {detail.recentServices.length === 0 ? (
          <p className="text-[13px] text-[var(--ink-muted)]">No service entries yet.</p>
        ) : (
          <div className="divide-y divide-[var(--hairline)] rounded-md border border-[var(--hairline)] bg-[var(--surface)]">
            {detail.recentServices.map((entry) => (
              <div key={entry._id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                <div className="min-w-0">
                  <div className="text-[13px] text-[var(--ink)]">{entry.description}</div>
                  <div className="text-[12px] text-[var(--ink-muted)]">
                    {formatDateOnly(entry.servicedAt)} · {formatKm(entry.odometerKm)}
                  </div>
                </div>
                <div className="text-[13px] tabular-nums text-[var(--ink)]">
                  {entry.cost == null ? "—" : formatAmount(entry.cost)}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {activeCompanyId && log?.kind === "trip" && (
        <TripDialog
          mode="create"
          companyId={activeCompanyId}
          now={now}
          preselectedVehicleId={log.vehicleId ?? vehicle._id}
          onClose={() => setLog(null)}
        />
      )}
      {activeCompanyId && log?.kind === "fuel" && (
        <FuelDialog
          mode="create"
          companyId={activeCompanyId}
          now={now}
          preselectedVehicleId={log.vehicleId ?? vehicle._id}
          onClose={() => setLog(null)}
        />
      )}
      {activeCompanyId && log?.kind === "service" && (
        <ServiceDialog
          mode="create"
          companyId={activeCompanyId}
          now={now}
          preselectedVehicleId={log.vehicleId ?? vehicle._id}
          onClose={() => setLog(null)}
        />
      )}
    </div>
  );
}

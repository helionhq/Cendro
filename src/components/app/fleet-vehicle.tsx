"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useAction, useMutation, useQuery_experimental } from "convex/react";
import {
  AlertTriangle,
  ExternalLink,
  MapPin,
  MoreHorizontal,
  Truck,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useMinuteNow } from "@/lib/use-minute-now";
import { useCompany } from "./company-context";
import {
  DialogError,
  DialogFooter,
  Field,
  FleetDialogFrame,
  FuelDialog,
  PhotoLightbox,
  ServiceDialog,
  StartTripDialog,
  TripDetailDialog,
  errorMessage,
  type TripSheetTrip,
} from "./fleet-dialogs";
import {
  alertSeverityLabel,
  formatAmount,
  formatDayLabel,
  formatDateTime,
  formatDuration,
  formatKm,
  formatKmPerL,
  formatLitres,
  formatTime,
  formatTimeRange,
  googleMapsUrl,
  relativeTime,
  serviceRemainingLabel,
  serviceStatusLabel,
  serviceStatusTone,
  vehicleStatusChip,
  type FleetBoardVehicle,
  type FleetConnection,
  type FleetTripRow,
  type FleetVehicleDetail,
  type FleetVehicleTimeline,
  type FleetVehicleTimelineLoggedTrip,
  type FleetVehicleTimelineTrackerTrip,
} from "./fleet-format";
import { FleetStandalonePage, useFleetAccess } from "./fleet-shell";
import {
  EmptyPanel,
  FleetCard,
  FleetNotice,
  QueryError,
  SectionHeading,
  SectionLink,
  SkeletonBlock,
} from "./fleet-ui";

export function VehiclePage({ id }: { id: string }) {
  const { activeCompanyId } = useCompany();
  const { canView } = useFleetAccess();
  if (!activeCompanyId || !canView) {
    return (
      <FleetStandalonePage title="Vehicle">
        <EmptyPanel
          icon={Truck}
          title="Vehicle not found"
          body="This vehicle may have been removed, or you no longer have access to it."
          action={
            <Button asChild variant="secondary" className="h-10">
              <Link href="/fleet">Back to Fleet</Link>
            </Button>
          }
        />
      </FleetStandalonePage>
    );
  }
  return (
    <VehicleContent
      key={activeCompanyId}
      companyId={activeCompanyId}
      vehicleId={id as Id<"fleetVehicles">}
    />
  );
}

function VehicleContent({
  companyId,
  vehicleId,
}: {
  companyId: Id<"companies">;
  vehicleId: Id<"fleetVehicles">;
}) {
  const { canLog, canManage, timeZone } = useFleetAccess();
  const now = useMinuteNow();
  const [notice, setNotice] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [startOpen, setStartOpen] = useState(false);
  const [fuelOpen, setFuelOpen] = useState(false);
  const [serviceOpen, setServiceOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [intervalOpen, setIntervalOpen] = useState(false);
  const [photo, setPhoto] = useState<{ url: string; label: string } | null>(null);
  const [sheetTrip, setSheetTrip] = useState<TripSheetTrip | null>(null);
  const [sheetEditTrip, setSheetEditTrip] = useState<FleetTripRow | null>(null);
  const [editingTrip, setEditingTrip] = useState<FleetTripRow | null>(null);
  const [returning, setReturning] = useState(false);
  const [loggingOverride, setLoggingOverride] = useState<boolean | null>(null);
  const [loggingSaving, setLoggingSaving] = useState(false);
  const [loggingError, setLoggingError] = useState<string | null>(null);
  const returnTrip = useAction(api.fleet.returnTrip);
  const setVehicleTripLogging = useMutation(api.fleetMonitoring.setVehicleTripLogging);

  const detailResult = useQuery_experimental({
    query: api.fleet.getVehicle,
    args: { companyId, vehicleId, now },
  });
  const timelineResult = useQuery_experimental({
    query: api.fleetDashboard.vehicleTimeline,
    args: { companyId, vehicleId, now, days: 7 },
  });
  const overviewResult = useQuery_experimental({
    query: api.fleetDashboard.overview,
    args: { companyId, now },
  });
  const connectionResult = useQuery_experimental({
    query: api.fleet.getConnection,
    args: { companyId },
  });
  const detail = detailResult.status === "success" ? (detailResult.data as FleetVehicleDetail) : undefined;
  const timeline =
    timelineResult.status === "success" ? (timelineResult.data as FleetVehicleTimeline) : undefined;
  const boardRow = (overviewResult.status === "success"
    ? (overviewResult.data.vehicleBoard as FleetBoardVehicle[])
    : []
  ).find((vehicle) => vehicle._id === vehicleId);
  const connection =
    connectionResult.status === "success" ? (connectionResult.data as FleetConnection) : undefined;

  if (detailResult.status === "error") {
    if (detailResult.error.message.includes("Vehicle not found.")) {
      return (
        <FleetStandalonePage title="Vehicle">
          <EmptyPanel
            icon={Truck}
            title="Vehicle not found"
            body="This vehicle may have been removed, or you no longer have access to it."
            action={
              <Button asChild variant="secondary" className="h-10">
                <Link href="/fleet">Back to Fleet</Link>
              </Button>
            }
          />
        </FleetStandalonePage>
      );
    }
    return (
      <FleetStandalonePage title="Vehicle">
        <QueryError
          message="Could not load this vehicle. Check your connection and try again."
          onRetry={() => window.location.reload()}
        />
      </FleetStandalonePage>
    );
  }

  if (!detail) {
    return (
      <FleetStandalonePage title="Vehicle">
        <div className="space-y-4" aria-busy="true" aria-label="Loading vehicle">
          <SkeletonBlock className="h-8 w-48" />
          <SkeletonBlock className="h-24" />
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[0, 1, 2, 3].map((index) => (
              <SkeletonBlock key={index} className="h-20" />
            ))}
          </div>
          <SkeletonBlock className="h-28" />
          <SkeletonBlock className="h-28" />
        </div>
      </FleetStandalonePage>
    );
  }

  const vehicle = detail.vehicle;
  const statusChip = vehicleStatusChip({
    status: boardRow?.status ?? mapLegacyStatus(vehicle.status),
    place: boardRow?.place ?? null,
    arrivedAt: boardRow?.arrivedAt ?? vehicle.openTrip?.arrivedAt ?? null,
    requiresTripLogging: boardRow?.requiresTripLogging ?? vehicle.requiresTripLogging,
    lastUpdate: boardRow?.lastUpdate ?? vehicle.recordedAt,
  });
  const lastSeen = boardRow?.lastUpdate ?? vehicle.recordedAt ?? vehicle.lastSeenAt;
  const requiresTripLogging = loggingOverride ?? boardRow?.requiresTripLogging ?? vehicle.requiresTripLogging;
  const openTrip = vehicle.openTrip;
  const connected = connection?.connected !== false;
  const openAlerts = (timeline?.days ?? [])
    .flatMap((day) => day.alerts)
    .filter((alert) => alert.status === "open")
    .slice(0, 3);

  async function markReturned() {
    if (!openTrip || returning) return;
    setReturning(true);
    setLocalError(null);
    try {
      await returnTrip({ companyId, tripId: openTrip._id });
      setNotice("Trip marked returned.");
    } catch (err) {
      setLocalError(errorMessage(err));
    } finally {
      setReturning(false);
    }
  }

  async function toggleLogging() {
    if (loggingSaving) return;
    const next = !requiresTripLogging;
    setLoggingOverride(next);
    setLoggingSaving(true);
    setLoggingError(null);
    try {
      await setVehicleTripLogging({ companyId, vehicleId, requiresTripLogging: next });
      setLoggingOverride(null);
    } catch {
      setLoggingOverride(null);
      setLoggingError("Could not save. Try again.");
    } finally {
      setLoggingSaving(false);
    }
  }

  function openTripById(tripId: Id<"fleetTrips">) {
    const recent = detail!.recentTrips.find((trip) => trip._id === tripId);
    if (recent) {
      setSheetEditTrip(tripRowFromRecent(recent, vehicle));
      setSheetTrip({
        _id: recent._id,
        vehicleId,
        vehicleName: vehicle.name,
        driverName: recent.driverName,
        destination: recent.destination,
        notes: recent.notes,
        status: recent.status,
        departedAt: recent.departedAt,
        returnedAt: recent.returnedAt,
        arrivedAt: recent.arrivedAt,
        autoReturned: recent.autoReturned,
        basePlaceId: null,
        placeId: recent.placeId,
        distanceKm: recent.distanceKm,
        actualDistanceKm: recent.actualDistanceKm,
        offRoute: recent.offRoute,
        maxDeviationKm: recent.maxDeviationKm,
      });
      return;
    }
    for (const day of timeline?.days ?? []) {
      const trip = day.trackerTrips.find((candidate) => candidate.matchedTripId === tripId);
      if (trip?.matchedTrip) {
        setSheetEditTrip(null);
        setSheetTrip({
          _id: tripId,
          vehicleId,
          vehicleName: vehicle.name,
          driverName: null,
          destination: trip.matchedTrip.destination,
          notes: null,
          status: trip.matchedTrip.status,
          departedAt: trip.matchedTrip.departedAt,
          returnedAt: trip.matchedTrip.returnedAt,
          arrivedAt: null,
          autoReturned: false,
          basePlaceId: null,
          placeId: null,
          distanceKm: trip.distanceKm,
          actualDistanceKm: trip.distanceKm,
          offRoute: false,
          maxDeviationKm: null,
        });
        return;
      }
    }
  }

  const headerActions = (
    <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
      {canLog && !openTrip && (
        <Button type="button" variant="primary" className="h-11 w-full sm:h-10 sm:w-auto" onClick={() => setStartOpen(true)}>
          Start trip
        </Button>
      )}
      {canLog && (
        <Button type="button" variant="secondary" className="h-11 flex-1 sm:h-10 sm:flex-none" onClick={() => setFuelOpen(true)}>
          Log fuel
        </Button>
      )}
      {canLog && (
        <Button type="button" variant="secondary" className="h-11 flex-1 sm:h-10 sm:flex-none" onClick={() => setServiceOpen(true)}>
          Log service
        </Button>
      )}
      {canManage && (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button type="button" className="task-icon-btn h-11 w-11 sm:h-10 sm:w-10" aria-label="Vehicle actions">
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" className="task-menu">
              <DropdownMenu.Item className="task-menu-item" onSelect={() => setRenameOpen(true)}>
                Rename vehicle
              </DropdownMenu.Item>
              <DropdownMenu.Item className="task-menu-item" onSelect={() => setIntervalOpen(true)}>
                Edit service interval
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
    </div>
  );

  return (
    <FleetStandalonePage
      title={
        <span className="flex flex-wrap items-center gap-2">
          {vehicle.name}
          <Badge tone={statusChip.tone}>{statusChip.label}</Badge>
        </span>
      }
      description={
        <span>
          {vehicle.displayName ? `${vehicle.registrationNumber} · ` : ""}
          Last update {lastSeen ? relativeTime(lastSeen, now) : "never"}
        </span>
      }
      actions={headerActions}
    >
      {notice && <FleetNotice message={notice} onDismiss={() => setNotice(null)} />}
      {localError && <FleetNotice tone="error" message={localError} onDismiss={() => setLocalError(null)} />}
      {!connected && (
        <FleetNotice
          tone="warning"
          message="Tracker disconnected. Showing saved history; new positions and trips are paused."
        />
      )}
      {timelineResult.status === "error" && (
        <QueryError
          message="Could not load this vehicle. Check your connection and try again."
          onRetry={() => window.location.reload()}
        />
      )}

      {openTrip && (
        <FleetCard className="mt-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-[var(--ink)]">
                {openTrip.driverName} → {openTrip.destination}
              </p>
              <p className="mt-0.5 text-[12px] text-[var(--ink-muted)]">
                {openTrip.arrivedAt != null
                  ? `Arrived at ${openTrip.destination} ${formatTime(openTrip.arrivedAt, timeZone)} · waiting to return`
                  : `Left ${formatTime(openTrip.departedAt, timeZone)} · ${formatDuration(now - openTrip.departedAt)}`}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {vehicle.lat != null && vehicle.lng != null && (
                <Button asChild variant="ghost" className="h-10">
                  <a href={googleMapsUrl(vehicle.lat, vehicle.lng)} target="_blank" rel="noreferrer">
                    <ExternalLink className="h-4 w-4" aria-hidden="true" />
                    View vehicle on map
                  </a>
                </Button>
              )}
              {canLog && (
                <Button type="button" variant="primary" className="h-10" disabled={returning} onClick={() => void markReturned()}>
                  {returning ? "Marking…" : "Mark returned"}
                </Button>
              )}
            </div>
          </div>
        </FleetCard>
      )}

      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <FactTile label="Status" value={statusChip.label} />
        <FactTile label="Odometer" value={formatKm(vehicle.odometerKm)} />
        <FactTile
          label="Last seen"
          value={lastSeen ? relativeTime(lastSeen, now) : "Never"}
          hint={lastSeen ? formatTime(lastSeen, timeZone) : undefined}
        />
        <FactTile
          label="Service"
          value={
            <span className="flex flex-wrap items-center gap-1.5">
              <Badge tone={serviceStatusTone(vehicle.serviceStatus.status)}>
                {serviceStatusLabel(vehicle.serviceStatus.status)}
              </Badge>
            </span>
          }
          hint={
            vehicle.serviceStatus.status === "not_configured"
              ? "No interval set"
              : vehicle.serviceStatus.status === "unknown"
                ? "Log the last service to start tracking"
                : serviceRemainingLabel(vehicle.serviceStatus)
          }
        />
      </div>

      {!openTrip && vehicle.address && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-[var(--ink-muted)]">
          <MapPin className="h-3.5 w-3.5 shrink-0 text-[var(--ink-faint)]" aria-hidden="true" />
          <span>Last known address: {vehicle.address}</span>
          {vehicle.lat != null && vehicle.lng != null && (
            <a
              href={googleMapsUrl(vehicle.lat, vehicle.lng)}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-[var(--ink-secondary)] underline-offset-2 hover:text-[var(--ink)] hover:underline"
            >
              Open in Google Maps
            </a>
          )}
        </div>
      )}

      <FleetCard className="mt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-[var(--ink)]">Requires trip logging</div>
            <p className="mt-0.5 text-[12px] leading-4 text-[var(--ink-muted)]">
              When on, Cendro alerts you if this vehicle moves without a logged trip. Turn it off for
              a personal or owner car.
            </p>
          </div>
          {canManage ? (
            <Switch
              checked={requiresTripLogging}
              aria-label="Requires trip logging"
              onCheckedChange={() => void toggleLogging()}
              disabled={loggingSaving}
              className="min-h-11 sm:min-h-0"
            />
          ) : (
            <span className="text-[12px] text-[var(--ink-muted)]">
              {requiresTripLogging ? "On" : "Personal vehicle — no trip alerts"}
            </span>
          )}
        </div>
        {loggingError && <p className="alert-error mt-2 rounded-md px-3 py-2 text-[13px]" role="alert">{loggingError}</p>}
      </FleetCard>

      <section className="mt-5" aria-labelledby="fleet-vehicle-timeline">
        <SectionHeading
          title="This week"
          id="fleet-vehicle-timeline"
          action={<SectionLink href={`/fleet/trips?vehicle=${vehicleId}`}>View trips</SectionLink>}
        />
        {timelineResult.status === "error" ? null : !timeline ? (
          <div className="space-y-2" aria-busy="true" aria-label="Loading movements">
            <SkeletonBlock className="h-16" />
            <SkeletonBlock className="h-16" />
          </div>
        ) : timeline.days.every(
            (day) => day.trackerTrips.length === 0 && day.loggedTrips.length === 0,
          ) ? (
          <p className="rounded-md border border-dashed border-[var(--hairline-strong)] px-3 py-4 text-[13px] text-[var(--ink-muted)]">
            {connected
              ? "No movements recorded this week."
              : "No tracker trips yet. They appear here after the tracker reports movement."}
          </p>
        ) : (
          <div className="space-y-4">
            {timeline.days
              .filter((day) => day.trackerTrips.length > 0 || day.loggedTrips.length > 0)
              .map((day) => {
                const matchedLoggedIds = new Set(
                  timeline.days
                    .flatMap((candidate) => candidate.trackerTrips)
                    .map((trip) => trip.matchedTripId)
                    .filter((id): id is Id<"fleetTrips"> => id != null),
                );
                const unmatchedLogged = day.loggedTrips.filter(
                  (trip) => !matchedLoggedIds.has(trip._id),
                );
                const dayKm = day.trackerTrips.reduce((sum, trip) => sum + trip.distanceKm, 0);
                return (
                  <div key={day.dayStart}>
                    <h3 className="mb-1.5 flex items-baseline justify-between gap-2 text-[13px] font-semibold text-[var(--ink)]">
                      <span>{formatDayLabel(day.dayStart, now, timeZone)}</span>
                      {dayKm > 0 && (
                        <span className="text-[12px] font-normal tabular-nums text-[var(--ink-muted)]">
                          {formatKm(dayKm)}
                        </span>
                      )}
                    </h3>
                    <ul className="divide-y divide-[var(--hairline)] rounded-xl border border-[var(--hairline)] bg-[var(--surface)]">
                      {day.trackerTrips.map((trip) => (
                        <TimelineTripRow
                          key={trip._id}
                          trip={trip}
                          vehicleName={vehicle.name}
                          timeZone={timeZone}
                          alert={findCoveringAlert(day.alerts, trip)}
                          onOpenTrip={openTripById}
                        />
                      ))}
                      {unmatchedLogged.map((trip) => (
                        <TimelineLoggedTripRow
                          key={trip._id}
                          trip={trip}
                          now={now}
                          timeZone={timeZone}
                        />
                      ))}
                    </ul>
                  </div>
                );
              })}
          </div>
        )}
        {timeline?.isTruncated && (
          <p className="mt-2 text-[12px] text-[var(--ink-faint)]">Showing the most recent movements this week.</p>
        )}
      </section>

      {openAlerts.length > 0 && (
        <section className="mt-5" aria-labelledby="fleet-vehicle-alerts">
          <SectionHeading
            title="Alerts"
            id="fleet-vehicle-alerts"
            action={<SectionLink href={`/fleet/alerts?status=open&vehicle=${vehicleId}`}>View all alerts</SectionLink>}
          />
          <ul className="divide-y divide-[var(--hairline)] rounded-xl border border-[var(--hairline)] bg-[var(--surface)]">
            {openAlerts.map((alert) => (
              <li key={alert._id} className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 sm:px-4">
                <span className="flex min-w-0 items-center gap-2">
                  <AlertTriangle
                    className="h-4 w-4 shrink-0"
                    style={{
                      color:
                        alert.kind === "trip_overdue"
                          ? "var(--badge-red-fg)"
                          : "var(--badge-yellow-fg)",
                    }}
                    aria-hidden="true"
                  />
                  <span className="min-w-0">
                    <span className="block text-[12px] font-medium text-[var(--ink-muted)]">
                      {alertSeverityLabel(alert.kind === "trip_overdue" ? "critical" : "warning")}
                    </span>
                    <span className="block truncate text-[13px] text-[var(--ink)]">
                      {timelineAlertTitle(alert.kind, vehicle.name)}
                    </span>
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="text-[12px] text-[var(--ink-faint)]">
                    {formatTime(alert.occurredAt, timeZone)}
                  </span>
                  <Button asChild variant="secondary" className="h-11 sm:h-9">
                    <Link href={`/fleet/alerts?status=open&focus=${alert._id}`}>Review</Link>
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <section aria-labelledby="fleet-vehicle-fuel">
          <SectionHeading
            title="Fuel"
            id="fleet-vehicle-fuel"
            action={<SectionLink href={`/fleet/costs?tab=fuel&vehicle=${vehicleId}`}>View all fuel</SectionLink>}
          />
          {detail.recentFuel.length === 0 ? (
            <p className="text-[13px] text-[var(--ink-muted)]">No fuel entries yet.</p>
          ) : (
            <ul className="divide-y divide-[var(--hairline)] rounded-xl border border-[var(--hairline)] bg-[var(--surface)]">
              {detail.recentFuel.slice(0, 3).map((entry) => (
                <li key={entry._id} className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 sm:px-4">
                  <span className="min-w-0 text-[13px] text-[var(--ink)]">
                    {formatDateTime(entry.filledAt, timeZone)} · {formatLitres(entry.litres)} · {formatAmount(entry.amount)}
                  </span>
                  <span className="text-[12px] tabular-nums text-[var(--ink-muted)]">
                    {formatKmPerL(entry.kmPerL)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="fleet-vehicle-service">
          <SectionHeading
            title="Service"
            id="fleet-vehicle-service"
            action={<SectionLink href={`/fleet/costs?tab=service&vehicle=${vehicleId}`}>View all service</SectionLink>}
          />
          {detail.recentServices.length === 0 ? (
            <p className="text-[13px] text-[var(--ink-muted)]">No service entries yet.</p>
          ) : (
            <ul className="divide-y divide-[var(--hairline)] rounded-xl border border-[var(--hairline)] bg-[var(--surface)]">
              {detail.recentServices.slice(0, 3).map((entry) => {
                const photoUrl = entry.photo?.url ?? null;
                return (
                  <li key={entry._id} className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 sm:px-4">
                    <span className="min-w-0 text-[13px] text-[var(--ink)]">
                      {formatDateTime(entry.servicedAt, timeZone)} · {entry.description}
                      {entry.cost != null ? ` · ${formatAmount(entry.cost)}` : ""}
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="text-[12px] tabular-nums text-[var(--ink-muted)]">
                        {formatKm(entry.odometerKm)}
                      </span>
                      {photoUrl && (
                        <button
                          type="button"
                          className="h-9 w-9 rounded border border-[var(--hairline)] bg-[var(--surface-muted)] bg-cover bg-center"
                          style={{ backgroundImage: `url(${photoUrl})` }}
                          aria-label={`View service photo for ${vehicle.name}`}
                          onClick={() => setPhoto({ url: photoUrl, label: `Service photo · ${vehicle.name}` })}
                        />
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      {detailResult.status === "success" && detailResult.data.recentTrips.length === 0 && (
        <p className="mt-4 text-[12px] text-[var(--ink-faint)]">
          No logged trips for this vehicle yet.
        </p>
      )}

      {photo && <PhotoLightbox url={photo.url} label={photo.label} onClose={() => setPhoto(null)} />}
      {startOpen && (
        <StartTripDialog
          companyId={companyId}
          now={now}
          preselectedVehicleId={vehicleId}
          canManage={canManage}
          timeZone={timeZone}
          onClose={() => setStartOpen(false)}
          onSaved={(message) => { setNotice(message); setStartOpen(false); }}
        />
      )}
      {fuelOpen && (
        <FuelDialog
          mode="create"
          companyId={companyId}
          now={now}
          preselectedVehicleId={vehicleId}
          timeZone={timeZone}
          onClose={() => setFuelOpen(false)}
          onSaved={(message) => { setNotice(message); setFuelOpen(false); }}
        />
      )}
      {serviceOpen && (
        <ServiceDialog
          mode="create"
          companyId={companyId}
          now={now}
          preselectedVehicleId={vehicleId}
          timeZone={timeZone}
          onClose={() => setServiceOpen(false)}
          onSaved={(message) => { setNotice(message); setServiceOpen(false); }}
        />
      )}
      {renameOpen && (
        <RenameVehicleDialog
          companyId={companyId}
          vehicleId={vehicleId}
          name={vehicle.displayName ?? ""}
          onClose={() => setRenameOpen(false)}
          onSaved={(message) => { setNotice(message); setRenameOpen(false); }}
        />
      )}
      {intervalOpen && (
        <ServiceIntervalDialog
          companyId={companyId}
          vehicleId={vehicleId}
          serviceStatus={vehicle.serviceStatus}
          onClose={() => setIntervalOpen(false)}
          onSaved={(message) => { setNotice(message); setIntervalOpen(false); }}
        />
      )}
      {sheetTrip && (
        <TripDetailDialog
          companyId={companyId}
          trip={sheetTrip}
          canLog={canLog}
          canManage={canManage}
          timeZone={timeZone}
          onClose={() => { setSheetTrip(null); setSheetEditTrip(null); }}
          onEdit={
            sheetEditTrip
              ? () => {
                  setEditingTrip(sheetEditTrip);
                  setSheetTrip(null);
                  setSheetEditTrip(null);
                }
              : undefined
          }
          onSaved={(message) => { setNotice(message); setSheetTrip(null); setSheetEditTrip(null); }}
        />
      )}
      {editingTrip && (
        <StartTripDialog
          companyId={companyId}
          now={now}
          trip={editingTrip}
          canManage={canManage}
          timeZone={timeZone}
          onClose={() => setEditingTrip(null)}
          onSaved={(message) => { setNotice(message); setEditingTrip(null); }}
        />
      )}
    </FleetStandalonePage>
  );
}

function TimelineTripRow({
  trip,
  vehicleName,
  timeZone,
  alert,
  onOpenTrip,
}: {
  trip: FleetVehicleTimelineTrackerTrip;
  vehicleName: string;
  timeZone?: string;
  alert: { _id: Id<"fleetAlerts"> } | null;
  onOpenTrip: (tripId: Id<"fleetTrips">) => void;
}) {
  const matched = trip.matchedTripId != null;
  const short = trip.distanceMeters < 1000;
  return (
    <li className="px-3.5 py-2.5 sm:px-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="text-[12px] tabular-nums text-[var(--ink-muted)]">
          {formatTimeRange(trip.startedAt, trip.endedAt, timeZone)}
        </span>
        <span className="text-[12px] tabular-nums text-[var(--ink-muted)]">{formatKm(trip.distanceKm)}</span>
      </div>
      <div className="mt-0.5 truncate text-[13px] text-[var(--ink)]">
        {trip.startLandmark || "Unknown place"} → {trip.endLandmark || "Unknown place"}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {matched && trip.matchedTripId ? (
          <button
            type="button"
            onClick={() => onOpenTrip(trip.matchedTripId!)}
            className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
            aria-label={`Open the logged trip for ${vehicleName}`}
          >
            <Badge tone="blue">Logged</Badge>
          </button>
        ) : short ? (
          <Badge tone="neutral">Short movement</Badge>
        ) : (
          <Badge tone="yellow">No trip logged</Badge>
        )}
        {!matched && !short && alert && (
          <Button asChild variant="ghost" className="h-11 px-3 text-[12px] sm:h-8 sm:px-2">
            <Link href={`/fleet/alerts?status=open&focus=${alert._id}`}>Review</Link>
          </Button>
        )}
      </div>
    </li>
  );
}

function TimelineLoggedTripRow({
  trip,
  now,
  timeZone,
}: {
  trip: FleetVehicleTimelineLoggedTrip;
  now: number;
  timeZone?: string;
}) {
  const distanceKm =
    trip.startOdometerMeters != null &&
    trip.endOdometerMeters != null &&
    trip.endOdometerMeters >= trip.startOdometerMeters
      ? (trip.endOdometerMeters - trip.startOdometerMeters) / 1000
      : trip.actualDistanceKm;
  return (
    <li className="px-3.5 py-2.5 sm:px-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="text-[12px] tabular-nums text-[var(--ink-muted)]">
          {trip.status === "open"
            ? `Left ${formatTime(trip.departedAt, timeZone)} · out now`
            : formatTimeRange(trip.departedAt, trip.returnedAt, timeZone)}
        </span>
        <span className="text-[12px] tabular-nums text-[var(--ink-muted)]">
          {formatKm(distanceKm)}
        </span>
      </div>
      <div className="mt-0.5 truncate text-[13px] text-[var(--ink)]">{trip.destination}</div>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <Badge tone={trip.status === "open" ? "blue" : "neutral"}>
          {trip.status === "open" ? "Out now" : "Returned"}
        </Badge>
        {trip.autoReturned && <Badge tone="neutral">Auto</Badge>}
        {trip.status === "open" && (
          <span className="text-[12px] text-[var(--ink-faint)]">
            Logged {relativeTime(trip.departedAt, now)}
          </span>
        )}
      </div>
    </li>
  );
}

function tripRowFromRecent(
  recent: FleetVehicleDetail["recentTrips"][number],
  vehicle: FleetVehicleDetail["vehicle"],
): FleetTripRow {
  return {
    _id: recent._id,
    vehicleId: vehicle._id,
    driverId: recent.driverId,
    destination: recent.destination,
    notes: recent.notes,
    status: recent.status,
    departedAt: recent.departedAt,
    returnedAt: recent.returnedAt,
    placeId: recent.placeId,
    basePlaceId: null,
    arrivedAt: recent.arrivedAt,
    autoReturned: recent.autoReturned,
    startOdometerMeters: recent.startOdometerMeters,
    endOdometerMeters: recent.endOdometerMeters,
    distanceMeters: recent.distanceMeters,
    distanceKm: recent.distanceKm,
    actualDistanceMeters: recent.actualDistanceMeters,
    actualDistanceKm: recent.actualDistanceKm,
    maxDeviationMeters: recent.maxDeviationMeters,
    maxDeviationKm: recent.maxDeviationKm,
    offRoute: recent.offRoute,
    vehicle: {
      _id: vehicle._id,
      registrationNumber: vehicle.registrationNumber,
      displayName: vehicle.displayName,
      name: vehicle.name,
    },
    driver: recent.driverName ? { _id: recent.driverId, name: recent.driverName } : null,
    createdAt: recent.departedAt,
    updatedAt: recent.returnedAt ?? recent.departedAt,
  };
}

function FactTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-[var(--hairline)] bg-[var(--surface)] p-3.5">
      <div className="text-[11px] font-medium uppercase tracking-[0.04em] text-[var(--ink-faint)]">{label}</div>
      <div className="mt-1 truncate text-[15px] font-semibold text-[var(--ink)]">{value}</div>
      {hint && <div className="mt-0.5 truncate text-[12px] text-[var(--ink-muted)]">{hint}</div>}
    </div>
  );
}

function mapLegacyStatus(status: "on_trip" | "missing" | "unknown" | "moving" | "parked") {
  if (status === "on_trip" || status === "moving" || status === "parked") return status;
  return status === "missing" ? "offline" : "unknown";
}

function findCoveringAlert(
  alerts: { _id: Id<"fleetAlerts">; kind: string; status: string; occurredAt: number; endedAt: number | null }[],
  trip: FleetVehicleTimelineTrackerTrip,
) {
  return (
    alerts.find(
      (alert) =>
        alert.kind === "unlogged_movement" &&
        alert.status === "open" &&
        alert.occurredAt <= trip.startedAt &&
        (alert.endedAt ?? alert.occurredAt) >= trip.endedAt,
    ) ?? null
  );
}

function timelineAlertTitle(kind: string, vehicleName: string) {
  switch (kind) {
    case "unlogged_movement":
      return `${vehicleName} moved without a trip`;
    case "off_route":
      return `${vehicleName} went off route`;
    case "trip_overdue":
      return `${vehicleName} has been out too long`;
    default:
      return "Fleet alert";
  }
}

// ---------------------------------------------------------------------------
// Vehicle settings dialogs
// ---------------------------------------------------------------------------

function RenameVehicleDialog({
  companyId,
  vehicleId,
  name: initialName,
  onClose,
  onSaved,
}: {
  companyId: Id<"companies">;
  vehicleId: Id<"fleetVehicles">;
  name: string;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const renameVehicle = useMutation(api.fleet.renameVehicle);
  const [name, setName] = useState(initialName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await renameVehicle({ companyId, vehicleId, displayName: name.trim() });
      onSaved("Vehicle renamed.");
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <FleetDialogFrame title="Rename vehicle" description="Choose the name shown across Fleet." onClose={onClose}>
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
        <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto px-4 py-4 sm:px-6">
          <Field label="Vehicle name" htmlFor="fleet-vehicle-rename" hint="Leave blank to use the registration number.">
            <Input
              id="fleet-vehicle-rename"
              className="h-10 text-sm"
              value={name}
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Silver Corolla"
            />
          </Field>
        </div>
        <DialogError error={error} />
        <DialogFooter saving={saving} label="Save" disabled={false} onCancel={onClose} />
      </form>
    </FleetDialogFrame>
  );
}

function ServiceIntervalDialog({
  companyId,
  vehicleId,
  serviceStatus,
  onClose,
  onSaved,
}: {
  companyId: Id<"companies">;
  vehicleId: Id<"fleetVehicles">;
  serviceStatus: FleetVehicleDetail["vehicle"]["serviceStatus"];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const setServiceInterval = useMutation(api.fleet.setServiceInterval);
  const [km, setKm] = useState(serviceStatus.serviceIntervalKm?.toString() ?? "");
  const [days, setDays] = useState(serviceStatus.serviceIntervalDays?.toString() ?? "");
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
        vehicleId,
        serviceIntervalKm: kmValue,
        serviceIntervalDays: daysValue,
      });
      onSaved("Service interval saved.");
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <FleetDialogFrame
      title="Edit service interval"
      description="Set how often this vehicle should be serviced."
      onClose={onClose}
    >
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
        <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto px-4 py-4 sm:px-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Every (km)" htmlFor="fleet-vehicle-interval-km">
              <Input
                id="fleet-vehicle-interval-km"
                className="h-10 text-sm"
                inputMode="numeric"
                value={km}
                onChange={(event) => setKm(event.target.value)}
                placeholder="e.g. 5000"
              />
            </Field>
            <Field label="Every (days)" htmlFor="fleet-vehicle-interval-days">
              <Input
                id="fleet-vehicle-interval-days"
                className="h-10 text-sm"
                inputMode="numeric"
                value={days}
                onChange={(event) => setDays(event.target.value)}
                placeholder="e.g. 180"
              />
            </Field>
          </div>
          <p className="text-[12px] text-[var(--ink-faint)]">
            Either or both. Leave blank to stop tracking that dimension.
          </p>
        </div>
        <DialogError error={error} />
        <DialogFooter saving={saving} label="Save interval" disabled={false} onCancel={onClose} />
      </form>
    </FleetDialogFrame>
  );
}

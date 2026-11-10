"use client";

import { useAction, useQuery_experimental } from "convex/react";
import { AlertTriangle, CheckCircle2, ExternalLink } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useMinuteNow } from "@/lib/use-minute-now";
import { useCompany } from "./company-context";
import {
  LogAsTripDialog,
  ReviewAlertDialog,
  ServiceDialog,
  TripDetailDialog,
  errorMessage,
  type TripSheetTrip,
} from "./fleet-dialogs";
import {
  alertDisplayBody,
  alertDisplayTitle,
  alertSeverityLabel,
  dayGroupKey,
  formatDayLabel,
  formatKm,
  formatTime,
  formatTimeRange,
  googleMapsUrl,
  type FleetAlertFeed,
  type FleetAlertFeedRow,
  type FleetAlertKind,
  type FleetTripRow,
} from "./fleet-format";
import { FleetPage, useFleetAccess } from "./fleet-shell";
import {
  AllClear,
  FleetNotice,
  QueryError,
  SkeletonBlock,
} from "./fleet-ui";

const typeOptions = [
  { value: "all", label: "All types" },
  { value: "movement", label: "Movement" },
  { value: "off_route", label: "Off route" },
  { value: "still_out", label: "Still out" },
  { value: "service", label: "Service" },
  { value: "fuel", label: "Fuel" },
  { value: "tracker", label: "Tracker" },
] as const;

type TypeFilter = (typeof typeOptions)[number]["value"];

function matchesType(kind: FleetAlertKind, filter: TypeFilter) {
  switch (filter) {
    case "all":
      return true;
    case "movement":
      return kind === "unlogged_movement";
    case "off_route":
      return kind === "off_route";
    case "still_out":
      return kind === "trip_overdue";
    case "service":
      return kind === "service_overdue" || kind === "service_due_soon";
    case "fuel":
      return kind === "fuel_anomaly" || kind === "fuel_spend_spike";
    case "tracker":
      return kind === "tracker_sync_failing" || kind === "vehicle_missing";
  }
}

export function AlertsPage() {
  const { activeCompanyId } = useCompany();
  const { canLog, canManage, canView, timeZone } = useFleetAccess();
  const now = useMinuteNow();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const status = searchParams.get("status") === "reviewed" ? "reviewed" : "open";
  const typeFilter = (typeOptions.find((option) => option.value === searchParams.get("type"))?.value ??
    "all") as TypeFilter;
  const vehicleFilter = searchParams.get("vehicle") ?? "";
  const focusKey = searchParams.get("focus");

  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<FleetAlertFeedRow | null>(null);
  const [loggingTrip, setLoggingTrip] = useState<FleetAlertFeedRow | null>(null);
  const [serviceFor, setServiceFor] = useState<Id<"fleetVehicles"> | null>(null);
  const [sheetTrip, setSheetTrip] = useState<FleetTripRow | null>(null);
  const [returningKey, setReturningKey] = useState<string | null>(null);
  const returnTrip = useAction(api.fleet.returnTrip);

  const openResult = useQuery_experimental({
    query: api.fleetMonitoring.alertsFeed,
    args: activeCompanyId && canView ? { companyId: activeCompanyId, now, status: "open" } : "skip",
  });
  const reviewedResult = useQuery_experimental({
    query: api.fleetMonitoring.alertsFeed,
    args: activeCompanyId && canView ? { companyId: activeCompanyId, now, status: "resolved" } : "skip",
  });
  const openTripsResult = useQuery_experimental({
    query: api.fleet.listOpenTrips,
    args: activeCompanyId && canView ? { companyId: activeCompanyId } : "skip",
  });

  const openFeed = openResult.status === "success" ? (openResult.data as FleetAlertFeed) : undefined;
  const reviewedFeed =
    reviewedResult.status === "success" ? (reviewedResult.data as FleetAlertFeed) : undefined;
  const openTrips = (openTripsResult.status === "success"
    ? openTripsResult.data.trips
    : []) as FleetTripRow[];
  const feed = status === "open" ? openFeed : reviewedFeed;
  const pending = status === "open" ? openResult.status === "pending" : reviewedResult.status === "pending";
  const queryError = openResult.status === "error" || reviewedResult.status === "error";
  const alerts = (feed?.alerts ?? [])
    .filter((alert) => matchesType(alert.kind, typeFilter))
    .filter((alert) => !vehicleFilter || alert.vehicleId === vehicleFilter);
  const groups = useMemo(() => groupAlerts(alerts, now, timeZone), [alerts, now, timeZone]);

  useEffect(() => {
    if (!focusKey || pending) return;
    const element = document.getElementById(`fleet-alert-${focusKey}`);
    element?.scrollIntoView({ block: "center" });
  }, [focusKey, pending]);

  function navigate(next: {
    status?: "open" | "reviewed";
    type?: TypeFilter;
    vehicle?: string;
    clearFocus?: boolean;
  }) {
    const params = new URLSearchParams(searchParams.toString());
    if (next.status) params.set("status", next.status);
    if (next.type) {
      if (next.type === "all") params.delete("type");
      else params.set("type", next.type);
    }
    if (next.vehicle !== undefined) {
      if (next.vehicle) params.set("vehicle", next.vehicle);
      else params.delete("vehicle");
    }
    if (next.clearFocus) params.delete("focus");
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  function clearFilters() {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("type");
    params.delete("vehicle");
    params.delete("focus");
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  function viewTrip(alert: FleetAlertFeedRow) {
    const trip = alert.tripId ? openTrips.find((candidate) => candidate._id === alert.tripId) : undefined;
    if (trip) {
      setSheetTrip(trip);
      return;
    }
    if (alert.vehicleId) router.push(`/fleet/trips?vehicle=${alert.vehicleId}`);
  }

  async function markReturned(alert: FleetAlertFeedRow) {
    if (!activeCompanyId || !alert.tripId || returningKey) return;
    setReturningKey(alert._id ?? alert.key);
    setError(null);
    try {
      await returnTrip({ companyId: activeCompanyId, tripId: alert.tripId });
      setNotice("Trip marked returned.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setReturningKey(null);
    }
  }

  const openCount = openFeed?.openCount ?? 0;
  const reviewedCount = reviewedFeed?.count ?? 0;
  const filtered = typeFilter !== "all" || Boolean(vehicleFilter);

  return (
    <FleetPage title="Alerts" description="Movement and problems that need a look." activeTab="alerts">
      {notice && <FleetNotice message={notice} onDismiss={() => setNotice(null)} />}
      {error && <FleetNotice tone="error" message={error} onDismiss={() => setError(null)} />}
      {queryError && (
        <QueryError
          message="Could not load alerts. Check your connection and try again."
          onRetry={() => window.location.reload()}
        />
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--hairline)]">
        <div className="flex items-stretch gap-5">
          <button
            type="button"
            onClick={() => navigate({ status: "open", clearFocus: true })}
            aria-current={status === "open" ? "page" : undefined}
            className={cn(
              "relative pb-3 pt-1 text-[13.5px] font-medium outline-none transition-colors after:absolute after:inset-x-0 after:-bottom-px after:h-[2px] after:content-[''] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]",
              status === "open"
                ? "text-[var(--ink)] after:bg-[var(--ink)]"
                : "text-[var(--ink-muted)] hover:text-[var(--ink)]",
            )}
          >
            Open {openCount}
          </button>
          <button
            type="button"
            onClick={() => navigate({ status: "reviewed", clearFocus: true })}
            aria-current={status === "reviewed" ? "page" : undefined}
            className={cn(
              "relative pb-3 pt-1 text-[13.5px] font-medium outline-none transition-colors after:absolute after:inset-x-0 after:-bottom-px after:h-[2px] after:content-[''] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]",
              status === "reviewed"
                ? "text-[var(--ink)] after:bg-[var(--ink)]"
                : "text-[var(--ink-muted)] hover:text-[var(--ink)]",
            )}
          >
            Reviewed {reviewedCount}
          </button>
        </div>
        <div className="flex items-center gap-2 pb-2">
          <label className="flex items-center gap-2 text-[12px] text-[var(--ink-muted)]">
            <span className="sr-only">Filter by alert type</span>
            <select
              aria-label="Filter by alert type"
              value={typeFilter}
              onChange={(event) => navigate({ type: event.target.value as TypeFilter, clearFocus: true })}
              className="h-10 rounded-md border border-[var(--hairline)] bg-[var(--surface)] px-2.5 text-[13px] text-[var(--ink)] outline-none focus:border-[var(--focus-ring)]"
            >
              {typeOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          {vehicleFilter && (
            <button
              type="button"
              className="h-9 rounded-md px-2 text-[12px] font-medium text-[var(--ink-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink)]"
              onClick={() => navigate({ clearFocus: true, vehicle: "" })}
            >
              Clear vehicle filter
            </button>
          )}
        </div>
      </div>

      {queryError ? null : pending ? (
        <div className="space-y-3" aria-busy="true" aria-label="Loading alerts">
          {[0, 1, 2].map((index) => (
            <SkeletonBlock key={index} className="h-36" />
          ))}
        </div>
      ) : alerts.length === 0 ? (
        status === "open" ? (
          filtered ? (
            <div className="rounded-xl border border-dashed border-[var(--hairline-strong)] px-4 py-6 text-center">
              <p className="text-[13px] text-[var(--ink-muted)]">No open alerts match these filters.</p>
              <Button type="button" variant="secondary" className="mt-3 h-10" onClick={clearFilters}>
                Clear filters
              </Button>
            </div>
          ) : (
            <AllClear
              title="All clear"
              body="No open alerts. We'll show movement and route problems here."
            />
          )
        ) : (
          <AllClear title="No reviewed alerts yet" body="Reviewed alerts stay here as an audit trail." />
        )
      ) : (
        <div className="space-y-5">
          {groups.map((group) => (
            <section key={group.key} aria-labelledby={`alert-group-${group.key}`}>
              <h2 id={`alert-group-${group.key}`} className="mb-2 text-[13px] font-semibold text-[var(--ink)]">
                {formatDayLabel(group.dayStart, now, timeZone)}
              </h2>
              <div className="space-y-3">
                {group.alerts.map((alert) => (
                  <AlertCard
                    key={alert._id ?? alert.key}
                    alert={alert}
                    now={now}
                    timeZone={timeZone}
                    tripDestination={
                      alert.tripId
                        ? openTrips.find((trip) => trip._id === alert.tripId)?.destination ?? null
                        : null
                    }
                    canLog={canLog}
                    canManage={canManage}
                    highlighted={focusKey === (alert._id ?? alert.key)}
                    returning={returningKey === (alert._id ?? alert.key)}
                    onReview={() => setReviewing(alert)}
                    onLogTrip={() => setLoggingTrip(alert)}
                    onViewTrip={() => viewTrip(alert)}
                    onMarkReturned={() => void markReturned(alert)}
                    onLogService={() => alert.vehicleId && setServiceFor(alert.vehicleId)}
                  />
                ))}
              </div>
            </section>
          ))}
          {feed?.isTruncated && (
            <p className="text-[12px] text-[var(--ink-faint)]">
              Showing the first 100 alerts. Reviewed alerts stay available in the Reviewed tab.
            </p>
          )}
        </div>
      )}

      {activeCompanyId && reviewing && (
        <ReviewAlertDialog
          companyId={activeCompanyId}
          alert={reviewing}
          canManage={canManage}
          now={now}
          timeZone={timeZone}
          onClose={() => setReviewing(null)}
          onSaved={(message) => { setNotice(message); setReviewing(null); }}
        />
      )}
      {activeCompanyId && loggingTrip && (
        <LogAsTripDialog
          companyId={activeCompanyId}
          now={now}
          alert={loggingTrip}
          timeZone={timeZone}
          onClose={() => setLoggingTrip(null)}
          onSaved={(message) => { setNotice(message); setLoggingTrip(null); }}
        />
      )}
      {activeCompanyId && serviceFor && (
        <ServiceDialog
          mode="create"
          companyId={activeCompanyId}
          now={now}
          preselectedVehicleId={serviceFor}
          timeZone={timeZone}
          onClose={() => setServiceFor(null)}
          onSaved={(message) => { setNotice(message); setServiceFor(null); }}
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
          onSaved={(message) => { setNotice(message); setSheetTrip(null); }}
        />
      )}
    </FleetPage>
  );
}

function AlertCard({
  alert,
  now,
  timeZone,
  tripDestination,
  canLog,
  canManage,
  highlighted,
  returning,
  onReview,
  onLogTrip,
  onViewTrip,
  onMarkReturned,
  onLogService,
}: {
  alert: FleetAlertFeedRow;
  now: number;
  timeZone?: string;
  tripDestination: string | null;
  canLog: boolean;
  canManage: boolean;
  highlighted: boolean;
  returning: boolean;
  onReview: () => void;
  onLogTrip: () => void;
  onViewTrip: () => void;
  onMarkReturned: () => void;
  onLogService: () => void;
}) {
  const id = `fleet-alert-${alert._id ?? alert.key}`;
  if (alert.status === "resolved") {
    return (
      <article id={id} className="rounded-xl border border-[var(--hairline)] bg-[var(--surface)] p-3.5 sm:p-4">
        <div className="flex items-start gap-2.5">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--badge-green-fg)]" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h3 className="text-[13.5px] font-semibold text-[var(--ink)]">
              {alertDisplayTitle(alert, now)}
            </h3>
            <p className="mt-0.5 text-[12px] text-[var(--ink-muted)]">
              {alert.resolvedByName
                ? `Reviewed by ${alert.resolvedByName}`
                : "Reviewed"}
              {alert.resolvedAt ? ` · ${formatTime(alert.resolvedAt, timeZone)}` : ""}
              {alert.vehicleId && (
                <>
                  {" · "}
                  <Link
                    href={`/fleet/vehicles/${alert.vehicleId}`}
                    className="font-medium text-[var(--ink-secondary)] underline-offset-2 hover:text-[var(--ink)] hover:underline"
                  >
                    View vehicle
                  </Link>
                </>
              )}
            </p>
            {alert.resolutionNote && (
              <p className="mt-1 text-[13px] text-[var(--ink-secondary)]">
                Note: &ldquo;{alert.resolutionNote}&rdquo;
              </p>
            )}
          </div>
        </div>
      </article>
    );
  }

  const critical = alert.severity === "critical";
  const accent = critical ? "var(--badge-red-fg)" : "var(--badge-yellow-fg)";
  const title = alertDisplayTitle(alert, now);
  const body = alertDisplayBody(alert);
  const meta = alertMeta(alert, timeZone, tripDestination);
  const isMovement = alert.kind === "unlogged_movement" && alert.source === "event";
  const isOffRoute = alert.kind === "off_route" && alert.source === "event";
  const isOverdue = alert.kind === "trip_overdue" && alert.source === "event";
  const isService = alert.kind === "service_overdue" || alert.kind === "service_due_soon";

  return (
    <article
      id={id}
      className={cn(
        "rounded-xl border border-l-[3px] border-[var(--hairline)] bg-[var(--surface)] p-3.5 sm:p-4",
        highlighted && "ring-2 ring-[var(--focus-ring)]",
      )}
      style={{ borderLeftColor: accent }}
    >
      <div className="flex items-start gap-2.5">
        <AlertTriangle
          className="mt-0.5 h-4 w-4 shrink-0"
          style={{ color: accent }}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h3 className="min-w-0 text-[13.5px] font-semibold text-[var(--ink)]">{title}</h3>
            <span
              className="shrink-0 text-[12px] font-medium"
              style={{ color: accent }}
            >
              {alertSeverityLabel(alert.severity)}
            </span>
          </div>
          {meta && <p className="mt-0.5 text-[12px] text-[var(--ink-muted)]">{meta}</p>}
          <p className="mt-1 text-[13px] text-[var(--ink-secondary)]">{body}</p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {isMovement && canLog && (
              <Button type="button" variant="primary" className="h-11 sm:h-10" onClick={onLogTrip}>
                Log as trip
              </Button>
            )}
            {(isMovement || isOffRoute) && canLog && (
              <Button type="button" variant={isMovement ? "secondary" : "primary"} className="h-11 sm:h-10" onClick={onReview}>
                Mark reviewed
              </Button>
            )}
            {isOverdue && canLog && alert.tripId && (
              <Button type="button" variant="primary" className="h-11 sm:h-10" disabled={returning} onClick={onMarkReturned}>
                {returning ? "Marking…" : "Mark returned"}
              </Button>
            )}
            {isOverdue && canLog && (
              <Button type="button" variant="secondary" className="h-11 sm:h-10" onClick={onReview}>
                Mark reviewed
              </Button>
            )}
            {isService && canLog && alert.vehicleId && (
              <Button type="button" variant="primary" className="h-11 sm:h-10" onClick={onLogService}>
                Log service
              </Button>
            )}
            {(isOffRoute || isOverdue) && (
              <Button type="button" variant="secondary" className="h-11 sm:h-10" onClick={onViewTrip}>
                View trip
              </Button>
            )}
            {(isOffRoute || isMovement || isOverdue) && alert.vehicleId && (
              <Button asChild variant="ghost" className="h-11 sm:h-10">
                <Link href={`/fleet/vehicles/${alert.vehicleId}`}>View vehicle</Link>
              </Button>
            )}
            {isOffRoute && alert.lat != null && alert.lng != null && (
              <Button asChild variant="ghost" className="h-11 sm:h-10">
                <a href={googleMapsUrl(alert.lat, alert.lng)} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4" aria-hidden="true" />
                  Open in Google Maps
                </a>
              </Button>
            )}
            {alert.kind === "fuel_anomaly" && alert.vehicleId && (
              <Button asChild variant="primary" className="h-11 sm:h-10">
                <Link href={`/fleet/costs?tab=fuel&vehicle=${alert.vehicleId}`}>View fuel entry</Link>
              </Button>
            )}
            {alert.kind === "fuel_spend_spike" && (
              <Button asChild variant="primary" className="h-11 sm:h-10">
                <Link href={`/fleet/costs?tab=fuel${alert.vehicleId ? `&vehicle=${alert.vehicleId}` : ""}`}>
                  View fuel entries
                </Link>
              </Button>
            )}
            {alert.kind === "tracker_sync_failing" && (
              <Button asChild variant={canManage ? "primary" : "secondary"} className="h-11 sm:h-10">
                <Link href="/fleet/settings">{canManage ? "Fix tracker" : "Open settings"}</Link>
              </Button>
            )}
            {alert.kind === "vehicle_missing" && alert.vehicleId && (
              <Button asChild variant="primary" className="h-11 sm:h-10">
                <Link href={`/fleet/vehicles/${alert.vehicleId}`}>View vehicle</Link>
              </Button>
            )}
            {(alert.kind === "fuel_anomaly" ||
              alert.kind === "fuel_spend_spike" ||
              alert.kind === "tracker_sync_failing") &&
              alert.vehicleId && (
                <Button asChild variant="ghost" className="h-11 sm:h-10">
                  <Link href={`/fleet/vehicles/${alert.vehicleId}`}>View vehicle</Link>
                </Button>
              )}
            {isService && alert.vehicleId && (
              <Button asChild variant="ghost" className="h-11 sm:h-10">
                <Link href={`/fleet/vehicles/${alert.vehicleId}`}>View vehicle</Link>
              </Button>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

function alertMeta(
  alert: FleetAlertFeedRow,
  timeZone?: string,
  tripDestination?: string | null,
) {
  switch (alert.kind) {
    case "unlogged_movement": {
      const route =
        alert.fromAddress || alert.toAddress
          ? `${alert.fromAddress ?? "Unknown place"} → ${alert.toAddress ?? "Unknown place"}`
          : "";
      return [
        formatTimeRange(alert.occurredAt, alert.endedAt, timeZone),
        formatKm(alert.distanceKm),
        route,
      ]
        .filter(Boolean)
        .join(" · ");
    }
    case "off_route":
      return [
        tripDestination ? `Trip to ${tripDestination}` : "",
        alert.occurredAt ? formatTime(alert.occurredAt, timeZone) : "",
        `${formatKm(alert.maxDeviationKm)} off route`,
      ]
        .filter(Boolean)
        .join(" · ");
    default:
      return "";
  }
}

function groupAlerts(alerts: FleetAlertFeedRow[], now: number, timeZone?: string) {
  const groups = new Map<string, { key: string; dayStart: number; alerts: FleetAlertFeedRow[] }>();
  for (const alert of alerts) {
    const at = alert.occurredAt ?? now;
    const key = dayGroupKey(at, timeZone);
    const group = groups.get(key);
    if (group) group.alerts.push(alert);
    else groups.set(key, { key, dayStart: at, alerts: [alert] });
  }
  return [...groups.values()].sort((a, b) => b.key.localeCompare(a.key));
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

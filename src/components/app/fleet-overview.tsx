"use client";

import { useAction, useQuery_experimental } from "convex/react";
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Fuel,
  Gauge,
  RefreshCw,
  Route,
  Truck,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "../../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useMinuteNow } from "@/lib/use-minute-now";
import { useCompany } from "./company-context";
import { DestinationBars, FleetKmChart, type DestinationBarRow } from "./fleet-charts";
import {
  PlaceDialog,
  StartTripDialog,
  errorMessage,
} from "./fleet-dialogs";
import {
  alertDisplayTitle,
  formatAmount,
  formatDayLabel,
  formatInteger,
  formatKm,
  formatKmPerL,
  formatTime,
  formatTimeRange,
  monthOverMonthLabel,
  relativeTime,
  tripOverdueHours,
  type FleetAlertFeedRow,
  type FleetBoardVehicle,
  type FleetConnection,
  type FleetDashboardKpis,
  type FleetDestinationCount,
  type FleetDriverRow,
  type FleetFuelInsights,
  type FleetKmDay,
  type FleetPlace,
  type FleetPlaceSuggestion,
  type FleetRecentActivity,
  type FleetUpcomingServiceRow,
} from "./fleet-format";
import { FleetPage, useFleetAccess } from "./fleet-shell";
import {
  AttentionRow,
  DashedPanel,
  EmptyPanel,
  FleetCard,
  FleetNotice,
  KpiTile,
  OverviewSkeleton,
  QueryError,
  SectionLink,
  VehicleBoardCard,
} from "./fleet-ui";

type Overview = {
  kpis: FleetDashboardKpis;
  attention: FleetAlertFeedRow[];
  vehicleBoard: FleetBoardVehicle[];
  upcomingService: FleetUpcomingServiceRow[];
  isTruncated: boolean;
};

type Activity = {
  kmLast7Days: FleetKmDay[];
  tripsByDestination: FleetDestinationCount[];
  recentActivity: FleetRecentActivity[];
  isTruncated: boolean;
};

const boardFilters = [
  { key: "all", label: "All" },
  { key: "on_trip", label: "On trip" },
  { key: "moving", label: "Moving" },
  { key: "parked", label: "Parked" },
  { key: "offline", label: "Offline" },
] as const;

type BoardFilter = (typeof boardFilters)[number]["key"];

const SETUP_DISMISSED_KEY = "cendro.fleet.setupDismissed";

export function OverviewPage() {
  const { activeCompanyId } = useCompany();
  return <OverviewContent key={activeCompanyId ?? "no-company"} />;
}

function OverviewContent() {
  const { activeCompanyId } = useCompany();
  const { canLog, canManage, canView, timeZone } = useFleetAccess();
  const now = useMinuteNow();
  const [notice, setNotice] = useState<string | null>(null);
  const [startOpen, setStartOpen] = useState(false);
  const [warehouseOpen, setWarehouseOpen] = useState(false);
  const [boardFilter, setBoardFilter] = useState<BoardFilter>("all");
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const syncNow = useAction(api.fleet.syncNow);

  const overviewResult = useQuery_experimental({
    query: api.fleetDashboard.overview,
    args: activeCompanyId && canView ? { companyId: activeCompanyId, now } : "skip",
  });
  const activityResult = useQuery_experimental({
    query: api.fleetDashboard.activity,
    args: activeCompanyId && canView ? { companyId: activeCompanyId, now } : "skip",
  });
  const connectionResult = useQuery_experimental({
    query: api.fleet.getConnection,
    args: activeCompanyId && canView ? { companyId: activeCompanyId } : "skip",
  });
  const placesResult = useQuery_experimental({
    query: api.fleetPlaces.listPlaces,
    args: activeCompanyId && canView ? { companyId: activeCompanyId } : "skip",
  });
  const suggestionsResult = useQuery_experimental({
    query: api.fleetPlaces.suggestPlaces,
    args: activeCompanyId && canView ? { companyId: activeCompanyId, now } : "skip",
  });
  const driversResult = useQuery_experimental({
    query: api.fleet.listDrivers,
    args: activeCompanyId && canView ? { companyId: activeCompanyId, includeInactive: true } : "skip",
  });
  const fuelResult = useQuery_experimental({
    query: api.fleet.fuelInsights,
    args: activeCompanyId && canView ? { companyId: activeCompanyId, now } : "skip",
  });

  // Cache the last successful payload per company so a workspace switch can
  // never show another tenant's fleet.
  const [lastOverview, setLastOverview] = useState<{
    companyId: string;
    data: Overview;
  } | null>(null);
  const [lastActivity, setLastActivity] = useState<{
    companyId: string;
    data: Activity;
  } | null>(null);
  const overviewData =
    overviewResult.status === "success" ? (overviewResult.data as Overview) : undefined;
  const activityData =
    activityResult.status === "success" ? (activityResult.data as Activity) : undefined;
  useEffect(() => {
    if (overviewData && activeCompanyId) {
      setLastOverview({ companyId: activeCompanyId, data: overviewData });
    }
  }, [overviewData, activeCompanyId]);
  useEffect(() => {
    if (activityData && activeCompanyId) {
      setLastActivity({ companyId: activeCompanyId, data: activityData });
    }
  }, [activityData, activeCompanyId]);

  const overview =
    overviewData ??
    (lastOverview?.companyId === activeCompanyId ? lastOverview.data : undefined);
  const activity =
    activityData ??
    (lastActivity?.companyId === activeCompanyId ? lastActivity.data : undefined);
  const connection =
    connectionResult.status === "success"
      ? (connectionResult.data as FleetConnection)
      : undefined;
  const places =
    placesResult.status === "success"
      ? (placesResult.data.places as FleetPlace[])
      : [];
  const suggestions =
    suggestionsResult.status === "success"
      ? (suggestionsResult.data.suggestions as FleetPlaceSuggestion[])
      : [];
  const drivers =
    driversResult.status === "success"
      ? (driversResult.data.drivers as FleetDriverRow[])
      : [];
  const fuel =
    fuelResult.status === "success" ? (fuelResult.data as FleetFuelInsights) : undefined;

  const queryError =
    overviewResult.status === "error" ||
    activityResult.status === "error" ||
    connectionResult.status === "error" ||
    placesResult.status === "error" ||
    suggestionsResult.status === "error" ||
    driversResult.status === "error";
  const loading =
    connectionResult.status === "pending" ||
    placesResult.status === "pending" ||
    suggestionsResult.status === "pending" ||
    driversResult.status === "pending" ||
    (!overview && overviewResult.status === "pending") ||
    (!activity && activityResult.status === "pending");

  // A pending or failed connection query says nothing about the tracker; only a
  // successful response may show the disconnected UI or hide Sync now.
  const connectionKnown = connectionResult.status === "success";
  const connected = connectionKnown && connection?.connected === true;
  const disconnected = connectionKnown && connection?.connected === false;
  const board = overview?.vehicleBoard ?? [];
  // Prefer the loaded board: a failed connection query must not replace a
  // loaded dashboard with the "Connect your tracker" empty state.
  const hasVehicles = overview ? board.length > 0 : (connection?.vehicleCount ?? 0) > 0;
  const allOnTrip = board.length > 0 && board.every((vehicle) => vehicle.status === "on_trip");
  const canStartTrip = canLog && board.length > 0 && !allOnTrip;
  const activeDrivers = drivers.filter((driver) => driver.active);
  const bases = places.filter((place) => place.kind === "base" && !place.archived);
  const destinations = places.filter((place) => place.kind === "destination" && !place.archived);

  const filteredBoard =
    boardFilter === "all" ? board : board.filter((vehicle) => vehicle.status === boardFilter);

  const attention = overview?.attention.slice(0, 3) ?? [];

  async function handleSync() {
    if (!activeCompanyId || syncing) return;
    setSyncing(true);
    setSyncError(null);
    setSyncNote(null);
    try {
      const result = await syncNow({ companyId: activeCompanyId });
      setSyncNote(
        result.skipped
          ? result.syncedAt
            ? `Updated ${relativeTime(result.syncedAt, now)}`
            : "Updated just now"
          : "Updated just now",
      );
    } catch (err) {
      setSyncError(errorMessage(err));
    } finally {
      setSyncing(false);
    }
  }

  const headerActions = (
    <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
      {canStartTrip ? (
        <Button
          type="button"
          variant="primary"
          className="h-11 w-full sm:h-10 sm:w-auto"
          onClick={() => setStartOpen(true)}
        >
          <Route className="h-4 w-4" aria-hidden="true" />
          Start trip
        </Button>
      ) : canLog && allOnTrip ? (
        <span className="text-[13px] text-[var(--ink-muted)]">All vehicles are out</span>
      ) : null}
      {!disconnected && (
        <Button
          type="button"
          variant="secondary"
          className="h-11 sm:h-10"
          onClick={() => void handleSync()}
          disabled={syncing}
        >
          <RefreshCw className={cn("h-4 w-4", syncing && "animate-spin")} aria-hidden="true" />
          {syncing ? "Syncing…" : "Sync now"}
        </Button>
      )}
      <span className="basis-full text-[12px] text-[var(--ink-muted)] sm:text-right">
        {connection?.lastSyncAt
          ? `Updated ${relativeTime(connection.lastSyncAt, now)}`
          : "Not updated yet"}
      </span>
    </div>
  );

  return (
    <FleetPage
      title="Overview"
      description="Your vehicles, trips and alerts at a glance."
      actions={headerActions}
      activeTab="overview"
    >
      {syncError && (
        <FleetNotice
          tone="error"
          message="Could not sync. Check the tracker key in Settings."
          action={
            <Button type="button" variant="secondary" className="h-9 shrink-0" onClick={() => void handleSync()} disabled={syncing}>
              Retry
            </Button>
          }
        />
      )}
      {syncNote && <FleetNotice message={syncNote} onDismiss={() => setSyncNote(null)} />}
      {notice && <FleetNotice message={notice} onDismiss={() => setNotice(null)} />}

      {queryError && (
        <QueryError
          message="Could not load Fleet. Check your connection and try again."
          onRetry={() => window.location.reload()}
        />
      )}
      {queryError && overview && (
        <p className="text-[12px] text-[var(--ink-faint)]">Showing the last update</p>
      )}

      {queryError && !overview ? null : loading ? (
        <OverviewSkeleton />
      ) : (
        <>
          {disconnected && hasVehicles && (
            <FleetNotice
              tone="warning"
              message="Tracker disconnected. Positions and automatic trips are paused; logged history still works."
              action={
                canManage ? (
                  <Button asChild variant="secondary" className="h-9 shrink-0">
                    <Link href="/fleet/settings">Reconnect</Link>
                  </Button>
                ) : undefined
              }
            />
          )}

          {connectionKnown && (
            <SetupCard
              connection={connection}
              bases={bases}
              destinations={destinations}
              suggestionCount={suggestions.length}
              driverCount={activeDrivers.length}
              canManage={canManage}
              canLog={canLog}
              onConnectHref="/fleet/settings"
              onAddWarehouse={() => setWarehouseOpen(true)}
              onStartTrip={() => setStartOpen(true)}
            />
          )}

          {!hasVehicles ? (
            <EmptyPanel
              icon={Truck}
              title={
                !connectionKnown
                  ? "Tracker status unavailable"
                  : connected
                    ? "No vehicles yet"
                    : "Connect your tracker"
              }
              body={
                !connectionKnown
                  ? "Check your connection and try again."
                  : connected
                    ? "Sync to bring them in."
                    : "Add your TrackWorld / portalxs secret key to bring in vehicles, positions and trips."
              }
              action={
                !connectionKnown ? undefined : connected ? (
                  <Button
                    type="button"
                    variant="primary"
                    className="h-10"
                    disabled={syncing}
                    onClick={() => void handleSync()}
                  >
                    {syncing ? "Syncing…" : "Sync now"}
                  </Button>
                ) : canManage ? (
                  <Button asChild variant="primary" className="h-10">
                    <Link href="/fleet/settings">Connect tracker</Link>
                  </Button>
                ) : (
                  <span className="text-[13px] text-[var(--ink-muted)]">Ask an admin to connect the tracker.</span>
                )
              }
            />
          ) : (
            <>
              {overview && (
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  <KpiTile
                    label="On the road"
                    value={overview.kpis.onTrip}
                    subline={
                      overview.kpis.moving > 0
                        ? `${overview.kpis.moving} moving without a trip`
                        : "All trips logged"
                    }
                    icon={Route}
                  />
                  <KpiTile
                    label="Parked"
                    value={overview.kpis.parked}
                    subline={
                      overview.kpis.offline > 0
                        ? `${overview.kpis.offline} tracker offline`
                        : "All trackers reporting"
                    }
                    icon={Truck}
                  />
                  <KpiTile
                    label="Km today"
                    value={formatKm(overview.kpis.kmToday)}
                    subline={`${overview.kpis.tripsToday} ${overview.kpis.tripsToday === 1 ? "trip" : "trips"} logged`}
                    icon={Gauge}
                  />
                  <KpiTile
                    label="Open alerts"
                    value={overview.kpis.openAlerts}
                    subline={overview.kpis.openAlerts > 0 ? `${overview.kpis.openAlerts} need review` : "All clear"}
                    icon={AlertTriangle}
                    danger={overview.kpis.openAlerts > 0}
                  />
                </div>
              )}

              {fuel && (
                <FleetCard className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <span className="flex items-center gap-2 text-[13px] font-medium text-[var(--ink)]">
                    <Fuel className="h-4 w-4 text-[var(--ink-faint)]" aria-hidden="true" />
                    Fuel this month
                  </span>
                  <span className="text-[15px] font-semibold tabular-nums text-[var(--ink)]">
                    {fuel.fleet.currentMonthSpend > 0
                      ? formatAmount(fuel.fleet.currentMonthSpend)
                      : "—"}
                  </span>
                  <span className="text-[12px] text-[var(--ink-muted)]">
                    {fuel.fleet.currentMonthSpend > 0
                      ? `${monthOverMonthLabel(fuel.fleet.monthOverMonthChange)} · ${formatKmPerL(fuel.fleetKmPerL)}`
                      : "No fill-ups this month"}
                  </span>
                  <span className="ml-auto">
                    <SectionLink href="/fleet/costs">View costs</SectionLink>
                  </span>
                </FleetCard>
              )}

              <section aria-labelledby="fleet-needs-attention">
                <FleetCard className="overflow-hidden p-0 sm:p-0">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--hairline)] px-3.5 py-2.5 sm:px-4">
                    <h2 id="fleet-needs-attention" className="text-sm font-semibold text-[var(--ink)]">
                      Needs attention
                    </h2>
                    <div className="flex items-center gap-3 text-[12px] text-[var(--ink-muted)]">
                      <span>{overview?.kpis.openAlerts ?? 0} open</span>
                      <SectionLink href="/fleet/alerts">View all</SectionLink>
                    </div>
                  </div>
                  {attention.length === 0 ? (
                    <div className="flex items-center gap-2 px-3.5 py-4 text-[13px] text-[var(--ink-secondary)] sm:px-4">
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--badge-green-fg)]" aria-hidden="true" />
                      Nothing needs attention. All vehicles are accounted for.
                    </div>
                  ) : (
                    <div className="divide-y divide-[var(--hairline)]">
                      {attention.map((alert) => (
                        <AttentionRow
                          key={alert._id ?? alert.key}
                          alert={alert}
                          title={alertDisplayTitle(alert, now)}
                          meta={alertMeta(alert, now, timeZone)}
                        />
                      ))}
                    </div>
                  )}
                </FleetCard>
              </section>

              <section aria-labelledby="fleet-vehicles">
                <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
                  <h2 id="fleet-vehicles" className="text-sm font-semibold text-[var(--ink)]">
                    Vehicles
                  </h2>
                  <div className="scrollbar-hidden flex max-w-full items-center gap-1 overflow-x-auto" role="group" aria-label="Filter vehicles">
                    {boardFilters.map((filter) => (
                      <button
                        key={filter.key}
                        type="button"
                        aria-pressed={boardFilter === filter.key}
                        onClick={() => setBoardFilter(filter.key)}
                        className={cn(
                          "min-h-11 shrink-0 rounded-md border px-2.5 sm:min-h-9 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]",
                          boardFilter === filter.key
                            ? "border-[var(--ink)] bg-[var(--surface-pressed)] text-[var(--ink)]"
                            : "border-[var(--hairline)] text-[var(--ink-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink)]",
                        )}
                      >
                        {filter.label}
                      </button>
                    ))}
                  </div>
                </div>
                {filteredBoard.length === 0 ? (
                  <DashedPanel>No vehicles match this filter.</DashedPanel>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {filteredBoard.map((vehicle) => (
                      <VehicleBoardCard
                        key={vehicle._id}
                        vehicle={vehicle}
                        now={now}
                        timeZone={timeZone}
                        lastUpdateLabel={
                          vehicle.lastUpdate
                            ? `Last update ${relativeTime(vehicle.lastUpdate, now)}`
                            : "Not updated yet"
                        }
                      />
                    ))}
                  </div>
                )}
                {overview?.isTruncated && (
                  <p className="mt-2 text-[12px] text-[var(--ink-faint)]">Some results are truncated.</p>
                )}
              </section>

              {activity && (
                <div className="grid gap-3 lg:grid-cols-2">
                  <FleetCard>
                    <div className="flex items-baseline justify-between gap-3">
                      <h2 className="text-[13.5px] font-semibold text-[var(--ink)]">Km this week</h2>
                      <span className="text-[12px] text-[var(--ink-muted)]">Tracker distance, last 7 days</span>
                    </div>
                    <div className="mt-4">
                      <FleetKmChart days={activity.kmLast7Days} timeZone={timeZone} />
                    </div>
                  </FleetCard>
                  <FleetCard>
                    <div className="flex items-baseline justify-between gap-3">
                      <h2 className="text-[13.5px] font-semibold text-[var(--ink)]">Trips by destination</h2>
                      <span className="text-[12px] text-[var(--ink-muted)]">Logged trips, last 30 days</span>
                    </div>
                    <div className="mt-4">
                      <DestinationBars rows={destinationRows(activity.tripsByDestination)} />
                    </div>
                  </FleetCard>
                </div>
              )}

              <div className="grid gap-3 lg:grid-cols-2">
                <FleetCard>
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="text-[13.5px] font-semibold text-[var(--ink)]">Upcoming service</h2>
                    <SectionLink href="/fleet/costs">View costs</SectionLink>
                  </div>
                  {overview && overview.upcomingService.length > 0 ? (
                    <ul className="mt-3 divide-y divide-[var(--hairline)]">
                      {overview.upcomingService.slice(0, 3).map((row) => (
                        <li key={row.vehicleId}>
                          <Link
                            href={`/fleet/vehicles/${row.vehicleId}`}
                            className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-[13px] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
                          >
                            <span className="min-w-0 truncate font-medium text-[var(--ink)]">{row.name}</span>
                            <span className={cn("text-[12px]", row.status === "overdue" ? "text-[var(--badge-red-fg)]" : "text-[var(--ink-muted)]")}>
                              {upcomingServiceLabel(row)}
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-3 text-[13px] text-[var(--ink-muted)]">
                      No service is due from the intervals set. Set an interval on a vehicle in{" "}
                      <Link href="/fleet/costs" className="font-medium text-[var(--ink)] underline underline-offset-2">
                        Costs
                      </Link>{" "}
                      to get reminders.
                    </p>
                  )}
                </FleetCard>
                <FleetCard>
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="text-[13.5px] font-semibold text-[var(--ink)]">Recent activity</h2>
                    <SectionLink href="/fleet/trips">View trips</SectionLink>
                  </div>
                  {activity && activity.recentActivity.length > 0 ? (
                    <ul className="mt-3 divide-y divide-[var(--hairline)]">
                      {activity.recentActivity.slice(0, 5).map((row, index) => {
                        const Icon = activityIcon(row.type);
                        return (
                          <li key={`${row.type}-${row.at}-${index}`} className="flex items-center gap-2.5 py-2.5">
                            <Icon className="h-4 w-4 shrink-0 text-[var(--ink-faint)]" aria-hidden="true" />
                            <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--ink)]">
                              {activityTitle(row)}
                            </span>
                            <span className="shrink-0 text-[12px] text-[var(--ink-faint)]">
                              {relativeTime(row.at, now)}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="mt-3 text-[13px] text-[var(--ink-muted)]">No activity yet.</p>
                  )}
                </FleetCard>
              </div>

              {activity?.isTruncated && (
                <p className="text-[12px] text-[var(--ink-faint)]">
                  Some trend data may be incomplete.
                </p>
              )}
            </>
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
      {activeCompanyId && warehouseOpen && (
        <PlaceDialog
          companyId={activeCompanyId}
          now={now}
          defaultKind="base"
          onClose={() => setWarehouseOpen(false)}
          onSaved={(message) => { setNotice(message); setWarehouseOpen(false); }}
        />
      )}
    </FleetPage>
  );
}

function SetupCard({
  connection,
  bases,
  destinations,
  suggestionCount,
  driverCount,
  canManage,
  canLog,
  onConnectHref,
  onAddWarehouse,
  onStartTrip,
}: {
  connection: FleetConnection | undefined;
  bases: FleetPlace[];
  destinations: FleetPlace[];
  suggestionCount: number;
  driverCount: number;
  canManage: boolean;
  canLog: boolean;
  onConnectHref: string;
  onAddWarehouse: () => void;
  onStartTrip: () => void;
}) {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    try {
      setDismissed(window.sessionStorage.getItem(SETUP_DISMISSED_KEY) === "1");
    } catch {
      setDismissed(false);
    }
  }, []);
  const connected = connection?.connected === true;
  const doneCount = [connected, bases.length > 0, destinations.length > 0, driverCount > 0].filter(Boolean).length;
  const allDone = doneCount === 4;
  if (allDone && dismissed) return null;

  function dismiss() {
    setDismissed(true);
    try {
      window.sessionStorage.setItem(SETUP_DISMISSED_KEY, "1");
    } catch {
      // The card can still be hidden for this render.
    }
  }

  const rows = [
    {
      key: "tracker",
      title: "Connect your tracker",
      hint: "Vehicles and positions arrive automatically.",
      done: connected,
      doneLabel: connected
        ? `Connected · ${connection?.vehicleCount ?? 0} ${connection?.vehicleCount === 1 ? "vehicle" : "vehicles"}`
        : null,
      action: canManage ? (
        <Button asChild variant="secondary" className="h-10">
          <Link href={onConnectHref}>Connect tracker</Link>
        </Button>
      ) : null,
    },
    {
      key: "warehouse",
      title: "Add your warehouse",
      hint: "Trips start and end here.",
      done: bases.length > 0,
      doneLabel: bases.length > 0
        ? `${bases[0].name}${bases.length > 1 ? ` +${bases.length - 1} more` : ""}`
        : null,
      action: canManage ? (
        <Button type="button" variant="secondary" className="h-10" onClick={onAddWarehouse}>
          Add warehouse
        </Button>
      ) : null,
    },
    {
      key: "destinations",
      title: "Add your regular destinations",
      hint:
        suggestionCount > 0
          ? `${suggestionCount} suggestions found from the last 30 days.`
          : "Saved places make starting a trip one tap.",
      done: destinations.length > 0,
      doneLabel: destinations.length > 0 ? `${destinations.length} ${destinations.length === 1 ? "place" : "places"}` : null,
      action: canManage ? (
        <Button asChild variant="secondary" className="h-10">
          <Link href="/fleet/places">{suggestionCount > 0 ? "Review" : "Add place"}</Link>
        </Button>
      ) : null,
    },
    {
      key: "drivers",
      title: "Add drivers",
      hint: "The people who drive your vehicles.",
      done: driverCount > 0,
      doneLabel: driverCount > 0 ? `${driverCount} ${driverCount === 1 ? "driver" : "drivers"}` : null,
      action: canManage ? (
        <Button asChild variant="secondary" className="h-10">
          <Link href="/fleet/settings#drivers">Add</Link>
        </Button>
      ) : null,
    },
  ];

  return (
    <FleetCard className="p-0 sm:p-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--hairline)] px-3.5 py-2.5 sm:px-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-[var(--ink)]">
            {allDone ? "Fleet is ready" : "Finish setting up Fleet"}
          </h2>
          {!allDone && (
            <p className="mt-0.5 text-[12px] text-[var(--ink-muted)]">{doneCount} of 4 done</p>
          )}
        </div>
        {allDone && (
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            {canLog && (
              <Button type="button" variant="secondary" className="h-10" onClick={onStartTrip}>
                Start a trip
              </Button>
            )}
            <Button type="button" variant="ghost" className="h-10" onClick={dismiss}>
              Got it
            </Button>
          </div>
        )}
      </div>
      {!allDone && (
        <ul className="divide-y divide-[var(--hairline)]">
          {rows.map((row) => (
            <li key={row.key} className="flex flex-wrap items-center gap-3 px-3.5 py-2.5 sm:px-4">
              {row.done ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--badge-green-fg)]" aria-hidden="true" />
              ) : (
                <Circle className="h-4 w-4 shrink-0 text-[var(--ink-faint)]" aria-hidden="true" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium text-[var(--ink)]">{row.title}</span>
                <span className="block text-[12px] text-[var(--ink-muted)]">
                  {row.done && row.doneLabel ? row.doneLabel : row.hint}
                </span>
              </span>
              {!row.done && row.action ? <span className="shrink-0">{row.action}</span> : null}
            </li>
          ))}
        </ul>
      )}
      {!allDone && !canManage && (
        <div className="border-t border-[var(--hairline)] px-3.5 py-2.5 text-[12px] text-[var(--ink-muted)] sm:px-4">
          Ask an admin to finish setting up Fleet.{" "}
          <Link href="/fleet/places" className="font-medium text-[var(--ink)] underline underline-offset-2">
            View places
          </Link>
        </div>
      )}
    </FleetCard>
  );
}

function upcomingServiceLabel(row: FleetUpcomingServiceRow) {
  const parts: string[] = [];
  if (row.kmRemaining !== null && Number.isFinite(row.kmRemaining)) {
    const km = Math.round(Math.abs(row.kmRemaining));
    parts.push(
      row.kmRemaining <= 0
        ? `${formatInteger(km)} km overdue`
        : `Due in ${formatInteger(km)} km`,
    );
  }
  if (row.daysRemaining !== null && Number.isFinite(row.daysRemaining)) {
    const days = Math.ceil(Math.abs(row.daysRemaining));
    const suffix = days === 1 ? "day" : "days";
    parts.push(row.daysRemaining <= 0 ? `${days} ${suffix} overdue` : `${days} ${suffix}`);
  }
  return parts.join(" · ") || "—";
}

function alertMeta(alert: FleetAlertFeedRow, now: number, timeZone?: string) {
  switch (alert.kind) {
    case "unlogged_movement":
      return [
        formatKm(alert.distanceKm),
        formatTimeRange(alert.occurredAt, alert.endedAt, timeZone),
        formatDayLabel(alert.occurredAt ?? now, now, timeZone),
      ].join(" · ");
    case "off_route":
      return [
        `${formatKm(alert.maxDeviationKm)} off route`,
        formatTime(alert.occurredAt, timeZone),
        formatDayLabel(alert.occurredAt ?? now, now, timeZone),
      ].join(" · ");
    case "trip_overdue": {
      const hours = tripOverdueHours(alert, now);
      return `Out for ${hours} ${hours === 1 ? "hour" : "hours"}`;
    }
    case "vehicle_missing":
      return "It has not sent a position recently.";
    default:
      return alert.message;
  }
}

function destinationRows(rows: FleetDestinationCount[]): DestinationBarRow[] {
  if (rows.length <= 5) {
    return rows.map((row, index) => ({
      ...row,
      key: row.placeId ?? `row-${index}-${row.destination}`,
    }));
  }
  const top = rows.slice(0, 5).map((row, index) => ({
    ...row,
    key: row.placeId ?? `row-${index}-${row.destination}`,
  }));
  const rest = rows.slice(5);
  return [
    ...top,
    {
      key: "other",
      destination: "Other",
      placeId: null,
      count: rest.reduce((sum, row) => sum + row.count, 0),
      km: rest.reduce((sum, row) => sum + row.km, 0),
      other: true,
    },
  ];
}

function activityIcon(type: FleetRecentActivity["type"]) {
  switch (type) {
    case "trip_started":
    case "trip_returned":
      return Route;
    case "fuel":
      return Fuel;
    case "service":
      return Wrench;
    case "alert":
      return AlertTriangle;
  }
}

function activityTitle(row: FleetRecentActivity) {
  switch (row.type) {
    case "trip_started":
      return `Trip started: ${row.title}`;
    case "trip_returned":
      return `Trip returned: ${row.title}`;
    case "fuel":
      return row.detail ? `Fuel logged: ${row.vehicleName} · ${row.detail}` : row.title;
    case "service":
      return row.detail ? `Service logged: ${row.vehicleName} · ${row.detail}` : row.title;
    case "alert":
      return row.title;
  }
}

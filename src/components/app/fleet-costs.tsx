"use client";

import { useMutation, usePaginatedQuery, useQuery_experimental } from "convex/react";
import { AlertTriangle, Fuel, Gauge, Wrench } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { inputClassName } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { useMinuteNow } from "@/lib/use-minute-now";
import { useCompany } from "./company-context";
import {
  ConfirmDialog,
  FuelDialog,
  PhotoLightbox,
  RecordMenu,
  ServiceDialog,
} from "./fleet-dialogs";
import {
  formatAmount,
  formatDateTime,
  formatKm,
  formatKmPerL,
  formatLitres,
  monthOverMonthLabel,
  monthOverMonthValue,
  serviceRemainingLabel,
  serviceStatusLabel,
  serviceStatusTone,
  type FleetFuelInsights,
  type FleetFuelRow,
  type FleetMaintenanceRow,
  type FleetServiceRow,
  type FleetVehicleRow,
} from "./fleet-format";
import { FleetPage, useFleetAccess } from "./fleet-shell";
import {
  EmptyPanel,
  FleetCard,
  FleetNotice,
  KpiTile,
  LoadMore,
  QueryError,
  SectionHeading,
  SkeletonBlock,
} from "./fleet-ui";

type CostsTab = "fuel" | "service";

export function CostsPage() {
  const { activeCompanyId } = useCompany();
  const { canLog, canManage, canView, timeZone } = useFleetAccess();
  const now = useMinuteNow();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab: CostsTab = searchParams.get("tab") === "service" ? "service" : "fuel";
  const vehicleParam = searchParams.get("vehicle") ?? "";

  const [notice, setNotice] = useState<string | null>(null);
  const [logging, setLogging] = useState<"fuel" | "service" | null>(null);
  const [logVehicleId, setLogVehicleId] = useState<Id<"fleetVehicles"> | null>(null);
  const [photo, setPhoto] = useState<{ url: string; label: string } | null>(null);
  const [editingFuel, setEditingFuel] = useState<FleetFuelRow | null>(null);
  const [deletingFuel, setDeletingFuel] = useState<FleetFuelRow | null>(null);
  const [editingService, setEditingService] = useState<FleetServiceRow | null>(null);
  const [deletingService, setDeletingService] = useState<FleetServiceRow | null>(null);
  const deleteFuelEntry = useMutation(api.fleet.deleteFuelEntry);
  const deleteServiceEntry = useMutation(api.fleet.deleteServiceEntry);

  const vehiclesResult = useQuery_experimental({
    query: api.fleet.listVehicles,
    args: activeCompanyId && canView ? { companyId: activeCompanyId, now } : "skip",
  });
  const insightsResult = useQuery_experimental({
    query: api.fleet.fuelInsights,
    args: activeCompanyId && canView ? { companyId: activeCompanyId, now } : "skip",
  });
  const dueResult = useQuery_experimental({
    query: api.fleet.maintenanceStatus,
    args: activeCompanyId && canView ? { companyId: activeCompanyId, now } : "skip",
  });
  const vehicles = (vehiclesResult.status === "success"
    ? vehiclesResult.data.vehicles
    : []) as FleetVehicleRow[];
  const vehicleFilter = vehicles.some((vehicle) => vehicle._id === vehicleParam) ? vehicleParam : "";
  const insights =
    insightsResult.status === "success" ? (insightsResult.data as FleetFuelInsights) : undefined;
  const due =
    dueResult.status === "success"
      ? (dueResult.data as { rows: FleetMaintenanceRow[]; isTruncated: boolean })
      : undefined;

  const fuelQuery = usePaginatedQuery(
    api.fleet.listFuelEntries,
    activeCompanyId
      ? {
          companyId: activeCompanyId,
          ...(vehicleFilter ? { vehicleId: vehicleFilter as Id<"fleetVehicles"> } : {}),
        }
      : "skip",
    { initialNumItems: 20 },
  );
  const serviceQuery = usePaginatedQuery(
    api.fleet.listServiceEntries,
    activeCompanyId
      ? {
          companyId: activeCompanyId,
          ...(vehicleFilter ? { vehicleId: vehicleFilter as Id<"fleetVehicles"> } : {}),
        }
      : "skip",
    { initialNumItems: 20 },
  );
  const fuelRows = fuelQuery.results as FleetFuelRow[];
  const serviceRows = serviceQuery.results as FleetServiceRow[];
  const loading =
    vehiclesResult.status === "pending" || insightsResult.status === "pending" || dueResult.status === "pending";
  const queryError =
    vehiclesResult.status === "error" || insightsResult.status === "error" || dueResult.status === "error";
  const allNotConfigured = Boolean(
    due && due.rows.length > 0 && due.rows.every((row) => row.serviceStatus.status === "not_configured"),
  );

  function navigate(next: { tab?: CostsTab; vehicle?: string }) {
    const params = new URLSearchParams(searchParams.toString());
    if (next.tab) {
      if (next.tab === "fuel") params.delete("tab");
      else params.set("tab", next.tab);
    }
    if (next.vehicle !== undefined) {
      if (next.vehicle) params.set("vehicle", next.vehicle);
      else params.delete("vehicle");
    }
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  return (
    <FleetPage
      title="Costs"
      description="Fuel and service for the whole fleet."
      activeTab="costs"
      actions={
        canLog ? (
          <div className="flex w-full flex-wrap gap-2 sm:w-auto">
            <Button
              type="button"
              variant="secondary"
              className="h-11 flex-1 sm:h-10 sm:flex-none"
              onClick={() => { setLogVehicleId(null); setLogging("service"); }}
            >
              <Wrench className="h-4 w-4" aria-hidden="true" />
              Log service
            </Button>
            <Button
              type="button"
              variant="primary"
              className="h-11 flex-1 sm:h-10 sm:flex-none"
              onClick={() => { setLogVehicleId(null); setLogging("fuel"); }}
            >
              <Fuel className="h-4 w-4" aria-hidden="true" />
              Log fuel
            </Button>
          </div>
        ) : undefined
      }
    >
      {notice && <FleetNotice message={notice} onDismiss={() => setNotice(null)} />}
      {queryError && (
        <QueryError
          message="Could not load costs. Check your connection and try again."
          onRetry={() => window.location.reload()}
        />
      )}

      <Tabs value={tab} onValueChange={(value) => navigate({ tab: value as CostsTab })}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <TabsList aria-label="Fuel and service">
            <TabsTrigger value="fuel" className="min-h-9 px-3">Fuel</TabsTrigger>
            <TabsTrigger value="service" className="min-h-9 px-3">Service</TabsTrigger>
          </TabsList>
          {vehicles.length > 0 && (
          <label className="flex items-center gap-2 text-[12px] text-[var(--ink-muted)]">
            <span className="sr-only">Filter by vehicle</span>
            <select
              aria-label="Filter by vehicle"
              value={vehicleFilter}
              onChange={(event) => navigate({ vehicle: event.target.value })}
              className={cn(inputClassName, "h-10 w-auto max-w-[200px] text-[13px]")}
            >
              <option value="">All vehicles</option>
              {vehicles.map((vehicle) => (
                <option key={vehicle._id} value={vehicle._id}>{vehicle.name}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      {queryError ? null : loading ? (
        <CostsSkeleton />
      ) : (
        <>
          <TabsContent value="fuel" className="mt-0 space-y-5">
            {insights && (
              <>
                {vehicleFilter && (
                  <p className="text-[11px] font-medium uppercase tracking-[0.04em] text-[var(--ink-faint)]">
                    Fleet totals
                  </p>
                )}
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  <KpiTile
                    label="This month"
                    value={insights.fleet.currentMonthSpend > 0 ? formatAmount(insights.fleet.currentMonthSpend) : "—"}
                    subline={insights.fleet.currentMonthSpend > 0 ? "Fuel spend" : "No fill-ups yet"}
                    icon={Fuel}
                  />
                  <KpiTile
                    label="Last month"
                    value={insights.fleet.previousMonthSpend > 0 ? formatAmount(insights.fleet.previousMonthSpend) : "—"}
                    subline={insights.fleet.previousMonthSpend > 0 ? "Fuel spend" : "No fill-ups yet"}
                    icon={Fuel}
                  />
                  <KpiTile
                    label="Change"
                    value={monthOverMonthValue(insights.fleet.monthOverMonthChange)}
                    subline="vs last month"
                    icon={Gauge}
                  />
                  <KpiTile
                    label="Fleet fuel use"
                    value={formatKmPerL(insights.fleetKmPerL)}
                    subline={
                      insights.currentMonthKm > 0
                        ? `${formatKm(insights.currentMonthKm)} this month`
                        : "No fill-ups yet"
                    }
                    icon={Gauge}
                  />
                </div>
                {insights.fleet.spendSpike && (
                  <p className="flex items-start gap-1.5 text-[12px] text-[var(--badge-yellow-fg)]">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    Spend is above 130% of the previous three-month average.
                  </p>
                )}
                {insights.isTruncated && (
                  <p className="text-[12px] text-[var(--ink-faint)]">Based on the most recent 2,000 fill-ups.</p>
                )}
                {insights.byVehicle.length === 0 && (
                  <p className="text-[13px] text-[var(--ink-muted)]">No fuel spend this month.</p>
                )}
                {insights.byVehicle.length > 0 && (
                  <FleetCard className="p-0 sm:p-0">
                    <h2 className="border-b border-[var(--hairline)] px-3.5 py-2.5 text-sm font-semibold text-[var(--ink)] sm:px-4">
                      By vehicle
                    </h2>
                    <ul className="divide-y divide-[var(--hairline)]">
                      {insights.byVehicle.map((row) => (
                        <li
                          key={row.vehicleId}
                          className="flex flex-col gap-1 px-3.5 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:px-4"
                        >
                          <Link
                            href={`/fleet/vehicles/${row.vehicleId}`}
                            className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-[var(--ink)] hover:underline"
                          >
                            <span className="truncate">{row.name}</span>
                            {row.spendSpike && <Badge tone="yellow">Spike</Badge>}
                          </Link>
                          <div className="flex items-center justify-between gap-3 text-[12px] sm:justify-end">
                            <span className="tabular-nums text-[var(--ink)]">{formatAmount(row.currentMonthSpend)}</span>
                            <span className="text-[var(--ink-muted)]">{monthOverMonthLabel(row.monthOverMonthChange)}</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </FleetCard>
                )}
              </>
            )}

            <section aria-labelledby="fleet-fuel-entries">
              <div className="mb-2 flex items-center justify-between gap-2">
                <SectionHeading id="fleet-fuel-entries" title="Fuel entries" />
                {canLog && (
                  <Button type="button" variant="secondary" className="hidden h-9 sm:inline-flex" onClick={() => setLogging("fuel")}>
                    Log fuel
                  </Button>
                )}
              </div>
              {fuelQuery.status === "LoadingFirstPage" ? (
                <RowsSkeleton />
              ) : fuelRows.length === 0 ? (
                <EmptyPanel
                  icon={Fuel}
                  title="No fuel entries yet"
                  body="Log a fill-up with a photo of the gauge or receipt."
                  action={
                    canLog ? (
                      <Button type="button" variant="primary" className="h-10" onClick={() => setLogging("fuel")}>
                        Log fuel
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <>
                  <div className="hidden overflow-x-auto rounded-md border border-[var(--hairline)] md:block">
                    <table className="task-table min-w-[760px]" aria-label="Fuel entries">
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
                        {fuelRows.map((entry) => {
                          const name = entry.vehicle?.name ?? "Unknown vehicle";
                          return (
                            <tr key={entry._id}>
                              <td className="font-medium text-[var(--ink)]">{name}</td>
                              <td className="whitespace-nowrap">{formatDateTime(entry.filledAt, timeZone)}</td>
                              <td className="text-right tabular-nums">{formatLitres(entry.litres)}</td>
                              <td className="text-right tabular-nums">{formatAmount(entry.amount)}</td>
                              <td className="text-right tabular-nums">
                                <div>{formatKmPerL(entry.kmPerL)}</div>
                                {entry.anomaly && (
                                  <div className="text-[11px] text-[var(--badge-red-fg)]">
                                    Low · usual {formatKmPerL(entry.medianKmPerL)}
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
                                    onEdit={() => setEditingFuel(entry)}
                                    onDelete={() => setDeletingFuel(entry)}
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
                    {fuelRows.map((entry) => {
                      const name = entry.vehicle?.name ?? "Unknown vehicle";
                      return (
                        <div key={entry._id} className="rounded-xl border border-[var(--hairline)] bg-[var(--surface)] p-3.5">
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
                                <div className="text-[12px] text-[var(--ink-faint)]">{formatDateTime(entry.filledAt, timeZone)}</div>
                              </div>
                            </div>
                            {canManage && (
                              <RecordMenu
                                label={`fuel entry for ${name}`}
                                onEdit={() => setEditingFuel(entry)}
                                onDelete={() => setDeletingFuel(entry)}
                              />
                            )}
                          </div>
                          <div className="mt-2 text-[13px] text-[var(--ink-secondary)]">
                            {formatLitres(entry.litres)} · {formatAmount(entry.amount)} · {formatKmPerL(entry.kmPerL)}
                          </div>
                          {entry.anomaly && (
                            <div className="mt-0.5 text-[12px] text-[var(--badge-red-fg)]">
                              Low · usual {formatKmPerL(entry.medianKmPerL)}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <LoadMore status={fuelQuery.status} onLoadMore={fuelQuery.loadMore} label="Load more fuel entries" />
                </>
              )}
            </section>
          </TabsContent>

          <TabsContent value="service" className="mt-0 space-y-5">
            <section aria-labelledby="fleet-service-schedule">
              <div className="mb-2 flex items-center justify-between gap-2">
                <SectionHeading
                  id="fleet-service-schedule"
                  title="Service schedule"
                  description="Sorted by urgency. Set intervals from a vehicle page."
                />
                {canLog && (
                  <Button type="button" variant="secondary" className="hidden h-9 sm:inline-flex" onClick={() => setLogging("service")}>
                    Log service
                  </Button>
                )}
              </div>
              {due === undefined ? (
                <RowsSkeleton />
              ) : due.rows.length === 0 ? (
                <p className="rounded-md border border-dashed border-[var(--hairline-strong)] px-3 py-4 text-[13px] text-[var(--ink-muted)]">
                  No vehicles yet. Connect the tracker and sync to see the service schedule.
                </p>
              ) : (
                <div className="grid gap-2">
                  {allNotConfigured && (
                    <FleetNotice
                      tone="warning"
                      message="Set a service interval on a vehicle to see when service is due."
                      action={
                        <Button asChild variant="secondary" className="h-9 shrink-0">
                          <Link href={`/fleet/vehicles/${due.rows[0].vehicleId}`}>Open a vehicle</Link>
                        </Button>
                      }
                    />
                  )}
                  {due.rows.map((row) => (
                    <div
                      key={row.vehicleId}
                      className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--hairline)] bg-[var(--surface)] p-3.5"
                    >
                      <Link href={`/fleet/vehicles/${row.vehicleId}`} className="min-w-0 flex-1 text-left hover:underline">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-semibold text-[var(--ink)]">{row.name}</span>
                          <Badge tone={serviceStatusTone(row.serviceStatus.status)}>
                            {serviceStatusLabel(row.serviceStatus.status)}
                          </Badge>
                        </span>
                        {row.displayName && (
                          <span className="block text-[11px] text-[var(--ink-faint)]">{row.registrationNumber}</span>
                        )}
                        <span className="mt-0.5 block text-[12px] text-[var(--ink-muted)]">
                          {row.serviceStatus.status === "not_configured"
                            ? "Set a service interval on the vehicle page."
                            : row.serviceStatus.status === "unknown"
                              ? "Log the last service to start tracking."
                              : serviceRemainingLabel(row.serviceStatus)}
                        </span>
                      </Link>
                      {canLog && (
                        <Button
                          type="button"
                          variant="secondary"
                          className="h-10"
                          onClick={() => {
                            setLogVehicleId(row.vehicleId);
                            setLogging("service");
                          }}
                        >
                          Log service
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {due?.isTruncated && (
                <p className="mt-2 text-[12px] text-[var(--ink-faint)]">Showing the first 500 vehicles.</p>
              )}
            </section>

            <section aria-labelledby="fleet-service-history">
              <SectionHeading id="fleet-service-history" title="Service history" />
              {serviceQuery.status === "LoadingFirstPage" ? (
                <RowsSkeleton />
              ) : serviceRows.length === 0 ? (
                <EmptyPanel
                  icon={Wrench}
                  title="No service entries yet"
                  body="Log the last service so Cendro can track the next one."
                  action={
                    canLog ? (
                      <Button type="button" variant="primary" className="h-10" onClick={() => setLogging("service")}>
                        Log service
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <>
                  <div className="hidden overflow-x-auto rounded-md border border-[var(--hairline)] md:block">
                    <table className="task-table min-w-[800px]" aria-label="Service history">
                      <thead>
                        <tr>
                          <th scope="col">Vehicle</th>
                          <th scope="col">Date</th>
                          <th scope="col">Description</th>
                          <th scope="col" className="text-right">Odometer</th>
                          <th scope="col" className="text-right">Cost</th>
                          <th scope="col">Photo</th>
                          {canManage && <th scope="col"><span className="sr-only">Actions</span></th>}
                        </tr>
                      </thead>
                      <tbody>
                        {serviceRows.map((entry) => {
                          const name = entry.vehicle?.name ?? "Unknown vehicle";
                          const photoUrl = entry.photo?.url ?? null;
                          return (
                            <tr key={entry._id}>
                              <td className="font-medium text-[var(--ink)]">{name}</td>
                              <td className="whitespace-nowrap">{formatDateTime(entry.servicedAt, timeZone)}</td>
                              <td className="max-w-[260px] truncate">{entry.description}</td>
                              <td className="text-right tabular-nums">{formatKm(entry.odometerKm)}</td>
                              <td className="text-right tabular-nums">{entry.cost == null ? "—" : formatAmount(entry.cost)}</td>
                              <td>
                                {photoUrl ? (
                                  <button
                                    type="button"
                                    className="h-9 w-9 rounded border border-[var(--hairline)] bg-[var(--surface-muted)] bg-cover bg-center"
                                    style={{ backgroundImage: `url(${photoUrl})` }}
                                    aria-label={`View service photo for ${name}`}
                                    onClick={() => setPhoto({ url: photoUrl, label: `Service photo · ${name}` })}
                                  />
                                ) : (
                                  <span className="text-[var(--ink-faint)]">—</span>
                                )}
                              </td>
                              {canManage && (
                                <td className="w-10">
                                  <RecordMenu
                                    label={`service for ${name}`}
                                    onEdit={() => setEditingService(entry)}
                                    onDelete={() => setDeletingService(entry)}
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
                    {serviceRows.map((entry) => {
                      const name = entry.vehicle?.name ?? "Unknown vehicle";
                      const photoUrl = entry.photo?.url ?? null;
                      return (
                        <div key={entry._id} className="rounded-xl border border-[var(--hairline)] bg-[var(--surface)] p-3.5">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-semibold text-[var(--ink)]">{name}</div>
                              <div className="text-[12px] text-[var(--ink-faint)]">{formatDateTime(entry.servicedAt, timeZone)}</div>
                            </div>
                            <div className="flex items-center gap-1">
                              {photoUrl && (
                                <button
                                  type="button"
                                  className="h-10 w-10 shrink-0 rounded border border-[var(--hairline)] bg-[var(--surface-muted)] bg-cover bg-center"
                                  style={{ backgroundImage: `url(${photoUrl})` }}
                                  aria-label={`View service photo for ${name}`}
                                  onClick={() => setPhoto({ url: photoUrl, label: `Service photo · ${name}` })}
                                />
                              )}
                              {canManage && (
                                <RecordMenu
                                  label={`service for ${name}`}
                                  onEdit={() => setEditingService(entry)}
                                  onDelete={() => setDeletingService(entry)}
                                />
                              )}
                            </div>
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
            </section>
          </TabsContent>
        </>
      )}
      </Tabs>

      {photo && <PhotoLightbox url={photo.url} label={photo.label} onClose={() => setPhoto(null)} />}
      {activeCompanyId && logging === "fuel" && (
        <FuelDialog
          mode="create"
          companyId={activeCompanyId}
          now={now}
          preselectedVehicleId={logVehicleId ?? (vehicleFilter ? (vehicleFilter as Id<"fleetVehicles">) : undefined)}
          timeZone={timeZone}
          onClose={() => { setLogging(null); setLogVehicleId(null); }}
          onSaved={(message) => { setNotice(message); setLogging(null); setLogVehicleId(null); }}
        />
      )}
      {activeCompanyId && logging === "service" && (
        <ServiceDialog
          mode="create"
          companyId={activeCompanyId}
          now={now}
          preselectedVehicleId={logVehicleId ?? (vehicleFilter ? (vehicleFilter as Id<"fleetVehicles">) : undefined)}
          timeZone={timeZone}
          onClose={() => { setLogging(null); setLogVehicleId(null); }}
          onSaved={(message) => { setNotice(message); setLogging(null); setLogVehicleId(null); }}
        />
      )}
      {activeCompanyId && editingFuel && (
        <FuelDialog
          mode="edit"
          companyId={activeCompanyId}
          now={now}
          entry={editingFuel}
          timeZone={timeZone}
          onClose={() => setEditingFuel(null)}
          onSaved={(message) => { setNotice(message); setEditingFuel(null); }}
        />
      )}
      {activeCompanyId && editingService && (
        <ServiceDialog
          mode="edit"
          companyId={activeCompanyId}
          now={now}
          entry={editingService}
          timeZone={timeZone}
          onClose={() => setEditingService(null)}
          onSaved={(message) => { setNotice(message); setEditingService(null); }}
        />
      )}
      {activeCompanyId && deletingFuel && (
        <ConfirmDialog
          open
          title="Delete fuel entry?"
          description={`This removes the fuel entry for ${deletingFuel.vehicle?.name ?? "this vehicle"} and its photo.`}
          onConfirm={async () => {
            await deleteFuelEntry({ companyId: activeCompanyId, entryId: deletingFuel._id });
            setNotice("Fuel entry deleted.");
          }}
          onClose={() => setDeletingFuel(null)}
        />
      )}
      {activeCompanyId && deletingService && (
        <ConfirmDialog
          open
          title="Delete service entry?"
          description={`This removes "${deletingService.description}" from history.`}
          onConfirm={async () => {
            await deleteServiceEntry({ companyId: activeCompanyId, entryId: deletingService._id });
            setNotice("Service entry deleted.");
          }}
          onClose={() => setDeletingService(null)}
        />
      )}
    </FleetPage>
  );
}

function RowsSkeleton() {
  return (
    <div className="grid gap-2" aria-busy="true" aria-label="Loading rows">
      {[0, 1, 2].map((index) => (
        <SkeletonBlock key={index} className="h-14" />
      ))}
    </div>
  );
}

function CostsSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading costs">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <SkeletonBlock key={index} className="h-[92px]" />
        ))}
      </div>
      <RowsSkeleton />
    </div>
  );
}

"use client";

import { useAction, useMutation, useQuery_experimental } from "convex/react";
import {
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  UserPlus,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useMinuteNow } from "@/lib/use-minute-now";
import { useCompany } from "./company-context";
import { ConfirmDialog, errorMessage } from "./fleet-dialogs";
import {
  relativeTime,
  type FleetConnection,
  type FleetDriverRow,
  type FleetVehicleRow,
} from "./fleet-format";
import { FleetStandalonePage, useFleetAccess } from "./fleet-shell";
import {
  EmptyPanel,
  FleetCard,
  FleetNotice,
  QueryError,
  SectionHeading,
  SkeletonBlock,
} from "./fleet-ui";

const fieldLabelClass = "text-[13px] font-medium text-[var(--ink-secondary)]";
const controlClass = "h-10 text-sm";

export function FleetSettingsPage() {
  const { activeCompanyId } = useCompany();
  const { canManage, canView } = useFleetAccess();
  const now = useMinuteNow();

  if (!canManage) {
    return (
      <FleetStandalonePage title="Fleet settings">
        <EmptyPanel
          title="Managed by an admin"
          body="Fleet settings are managed by an admin."
          icon={KeyRound}
          action={
            <Button asChild variant="secondary" className="h-10">
              <Link href="/fleet">Back to Fleet</Link>
            </Button>
          }
        />
      </FleetStandalonePage>
    );
  }

  if (!activeCompanyId || !canView) {
    return (
      <FleetStandalonePage title="Fleet settings" description="Tracker, drivers and trip logging.">
        <EmptyPanel
          icon={KeyRound}
          title="Fleet settings are not available"
          body="You do not have access to Fleet settings in this workspace."
          action={
            <Button asChild variant="secondary" className="h-10">
              <Link href="/fleet">Back to Fleet</Link>
            </Button>
          }
        />
      </FleetStandalonePage>
    );
  }

  return <FleetSettingsContent key={activeCompanyId} companyId={activeCompanyId} now={now} />;
}

function FleetSettingsContent({ companyId, now }: { companyId: Id<"companies">; now: number }) {
  const connect = useAction(api.fleet.connect);
  const syncNow = useAction(api.fleet.syncNow);
  const disconnect = useMutation(api.fleet.disconnect);
  const createDriver = useMutation(api.fleet.createDriver);
  const updateDriver = useMutation(api.fleet.updateDriver);
  const deleteDriver = useMutation(api.fleet.deleteDriver);
  const setVehicleTripLogging = useMutation(api.fleetMonitoring.setVehicleTripLogging);

  const connectionResult = useQuery_experimental({
    query: api.fleet.getConnection,
    args: { companyId },
  });
  const driversResult = useQuery_experimental({
    query: api.fleet.listDrivers,
    args: { companyId, includeInactive: true },
  });
  const vehiclesResult = useQuery_experimental({
    query: api.fleet.listVehicles,
    args: { companyId, now },
  });

  const connection =
    connectionResult.status === "success" ? (connectionResult.data as FleetConnection) : undefined;
  const drivers = (driversResult.status === "success"
    ? driversResult.data.drivers
    : []) as FleetDriverRow[];
  const vehicles = (vehiclesResult.status === "success"
    ? vehiclesResult.data.vehicles
    : []) as FleetVehicleRow[];
  const connected = connection?.connected === true;
  const loading =
    connectionResult.status === "pending" ||
    driversResult.status === "pending" ||
    vehiclesResult.status === "pending";
  const queryError =
    connectionResult.status === "error" ||
    driversResult.status === "error" ||
    vehiclesResult.status === "error";

  const [notice, setNotice] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [disconnectConfirm, setDisconnectConfirm] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [adding, setAdding] = useState(false);
  const [driverError, setDriverError] = useState<string | null>(null);
  const [editingDriverId, setEditingDriverId] = useState<string | null>(null);
  const [pendingDriverId, setPendingDriverId] = useState<string | null>(null);
  const [deletingDriver, setDeletingDriver] = useState<FleetDriverRow | null>(null);
  const [loggingOverrides, setLoggingOverrides] = useState<Record<string, boolean>>({});
  const [loggingError, setLoggingError] = useState<string | null>(null);
  const [savingVehicleId, setSavingVehicleId] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (loading) return;
    if (typeof window !== "undefined" && window.location.hash === "#drivers") {
      nameInputRef.current?.focus();
    }
  }, [loading]);

  async function handleConnect() {
    const secretKey = keyInput.trim();
    if (!secretKey || connecting) return;
    setConnecting(true);
    setConnectError(null);
    setNotice(null);
    try {
      const result = await connect({ companyId, secretKey });
      setNotice(`Connected. ${result.vehicleCount} ${result.vehicleCount === 1 ? "vehicle" : "vehicles"} found.`);
      setKeyInput("");
      setReplacing(false);
    } catch (err) {
      const message = errorMessage(err);
      setConnectError(
        /secret key|not authenticated|no data found/i.test(message)
          ? "That key did not work. Check the key and try again."
          : message,
      );
    } finally {
      setConnecting(false);
    }
  }

  async function handleSync() {
    if (syncing) return;
    setSyncing(true);
    setSyncError(null);
    try {
      const result = await syncNow({ companyId });
      setNotice(
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

  async function handleDisconnect() {
    if (disconnecting) return;
    setDisconnecting(true);
    setConnectError(null);
    try {
      await disconnect({ companyId });
      setDisconnectConfirm(false);
      setNotice("Tracker disconnected. Vehicles and history stay.");
    } catch (err) {
      setConnectError(errorMessage(err));
    } finally {
      setDisconnecting(false);
    }
  }

  async function handleAddDriver(event: React.FormEvent) {
    event.preventDefault();
    if (adding || !newName.trim()) return;
    setAdding(true);
    setDriverError(null);
    try {
      await createDriver({ companyId, name: newName.trim(), phone: newPhone.trim() || undefined });
      setNewName("");
      setNewPhone("");
      setNotice("Driver added.");
    } catch (err) {
      setDriverError(errorMessage(err));
    } finally {
      setAdding(false);
    }
  }

  async function handleSaveDriver(driverId: Id<"fleetDrivers">, name: string, phone: string) {
    setPendingDriverId(driverId);
    setDriverError(null);
    try {
      await updateDriver({ companyId, driverId, name: name.trim(), phone: phone.trim() || null });
      setEditingDriverId(null);
      setNotice("Driver updated.");
    } catch (err) {
      setDriverError(errorMessage(err));
    } finally {
      setPendingDriverId(null);
    }
  }

  async function handleToggleDriver(driver: FleetDriverRow) {
    setPendingDriverId(driver._id);
    setDriverError(null);
    try {
      await updateDriver({ companyId, driverId: driver._id, active: !driver.active });
    } catch (err) {
      setDriverError(errorMessage(err));
    } finally {
      setPendingDriverId(null);
    }
  }

  async function handleToggleTripLogging(vehicle: FleetVehicleRow) {
    if (savingVehicleId === vehicle._id) return;
    const current = loggingOverrides[vehicle._id] ?? vehicle.requiresTripLogging;
    const next = !current;
    setSavingVehicleId(vehicle._id);
    setLoggingOverrides((previous) => ({ ...previous, [vehicle._id]: next }));
    setLoggingError(null);
    try {
      await setVehicleTripLogging({ companyId, vehicleId: vehicle._id, requiresTripLogging: next });
      setLoggingOverrides((previous) => {
        const copy = { ...previous };
        delete copy[vehicle._id];
        return copy;
      });
    } catch {
      setLoggingOverrides((previous) => {
        const copy = { ...previous };
        delete copy[vehicle._id];
        return copy;
      });
      setLoggingError("Could not save. Try again.");
    } finally {
      setSavingVehicleId(null);
    }
  }

  return (
    <FleetStandalonePage title="Fleet settings" description="Tracker, drivers and trip logging.">
      {notice && <FleetNotice message={notice} onDismiss={() => setNotice(null)} />}
      {queryError && (
        <QueryError
          message="Could not load fleet settings. Check your connection and try again."
          onRetry={() => window.location.reload()}
        />
      )}

      {queryError ? null : loading ? (
        <div className="mt-5 space-y-4" aria-busy="true" aria-label="Loading fleet settings">
          <SkeletonBlock className="h-40" />
          <SkeletonBlock className="h-48" />
          <SkeletonBlock className="h-40" />
        </div>
      ) : (
        <div className="mt-5 space-y-5">
          <FleetCard>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-[var(--ink)]">Tracker</h2>
                <p className="mt-0.5 text-[12px] text-[var(--ink-muted)]">
                  Vehicles and positions are read from your TrackWorld / portalxs account.
                </p>
              </div>
              <Badge tone={connected ? "green" : "neutral"}>{connected ? "Connected" : "Not connected"}</Badge>
            </div>

            {connected ? (
              <div className="mt-3 grid gap-3">
                <div className="rounded-md bg-[var(--surface-muted)] px-3 py-2.5 text-[13px]">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <KeyRound className="h-3.5 w-3.5 text-[var(--ink-faint)]" aria-hidden="true" />
                    <span>Key ending ••••{connection?.keyHint ?? "----"}</span>
                    <span className="text-[var(--ink-faint)]">·</span>
                    <span className="text-[var(--ink-muted)]">
                      Last update {connection?.lastSyncAt ? relativeTime(connection.lastSyncAt, now) : "never"}
                    </span>
                    <span className="text-[var(--ink-faint)]">·</span>
                    <span className="text-[var(--ink-muted)]">
                      {connection?.vehicleCount ?? 0}{" "}
                      {connection?.vehicleCount === 1 ? "vehicle" : "vehicles"}
                    </span>
                  </div>
                  {connection?.lastSyncError && (
                    <p className="alert-error mt-2 rounded-md px-2 py-1.5 text-[12px]" role="alert">
                      {connection.lastSyncError}
                    </p>
                  )}
                </div>

                {replacing && (
                  <div className="grid gap-2 rounded-md border border-[var(--hairline)] p-3">
                    <label htmlFor="fleet-tracker-key" className={fieldLabelClass}>
                      New tracker key
                    </label>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <Input
                        id="fleet-tracker-key"
                        type="password"
                        autoComplete="off"
                        className={cn(controlClass, "min-w-0 flex-1")}
                        value={keyInput}
                        onChange={(event) => setKeyInput(event.target.value)}
                        placeholder="Paste the secret key"
                      />
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          variant="primary"
                          className="h-10 flex-1 sm:flex-none"
                          onClick={() => void handleConnect()}
                          disabled={!keyInput.trim() || connecting}
                        >
                          {connecting ? "Connecting…" : "Save key"}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          className="h-10"
                          onClick={() => { setReplacing(false); setKeyInput(""); setConnectError(null); }}
                          disabled={connecting}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                    {connectError && <p className="alert-error rounded-md px-2 py-1.5 text-[12px]" role="alert">{connectError}</p>}
                  </div>
                )}

                {!replacing && (
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="secondary" className="h-10" onClick={() => void handleSync()} disabled={syncing}>
                      <RefreshCw className={cn("h-4 w-4", syncing && "animate-spin")} aria-hidden="true" />
                      {syncing ? "Syncing…" : "Sync now"}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      className="h-10"
                      onClick={() => { setReplacing(true); setConnectError(null); }}
                    >
                      Replace key
                    </Button>
                    {!disconnectConfirm ? (
                      <Button type="button" variant="ghost" className="h-10" onClick={() => setDisconnectConfirm(true)}>
                        Disconnect
                      </Button>
                    ) : (
                      <div className="flex w-full flex-wrap items-center gap-2 rounded-md border border-[var(--danger-border)] bg-[var(--danger-surface)] px-3 py-2">
                        <p className="min-w-0 flex-1 text-[13px] text-[var(--danger)]">
                          Disconnect this tracker? Vehicles and history stay.
                        </p>
                        <Button type="button" variant="secondary" className="h-9" onClick={() => setDisconnectConfirm(false)} disabled={disconnecting}>
                          Cancel
                        </Button>
                        <Button type="button" variant="danger" className="h-9" onClick={() => void handleDisconnect()} disabled={disconnecting}>
                          {disconnecting ? "Disconnecting…" : "Disconnect"}
                        </Button>
                      </div>
                    )}
                  </div>
                )}
                {syncError && <p className="alert-error rounded-md px-3 py-2 text-[13px]" role="alert">{syncError}</p>}
                {connectError && !replacing && (
                  <p className="alert-error rounded-md px-3 py-2 text-[13px]" role="alert">{connectError}</p>
                )}
              </div>
            ) : (
              <div className="mt-3 grid gap-3">
                <div className="grid gap-2 rounded-md border border-[var(--hairline)] p-3">
                  <label htmlFor="fleet-tracker-key" className={fieldLabelClass}>
                    Tracker secret key
                  </label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      id="fleet-tracker-key"
                      type="password"
                      autoComplete="off"
                      className={cn(controlClass, "min-w-0 flex-1")}
                      value={keyInput}
                      onChange={(event) => setKeyInput(event.target.value)}
                      placeholder="Paste the secret key"
                    />
                    <Button
                      type="button"
                      variant="primary"
                      className="h-10"
                      onClick={() => void handleConnect()}
                      disabled={!keyInput.trim() || connecting}
                    >
                      {connecting ? "Connecting…" : "Connect tracker"}
                    </Button>
                  </div>
                  <p className="text-[12px] leading-4 text-[var(--ink-faint)]">
                    Find the secret key in your TrackWorld / portalxs account. Cendro uses it only to read
                    positions and trips.
                  </p>
                  {connectError && <p className="alert-error rounded-md px-2 py-1.5 text-[12px]" role="alert">{connectError}</p>}
                </div>
              </div>
            )}
          </FleetCard>

          <FleetCard>
            <div id="drivers" className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-[var(--ink)]">Drivers</h2>
                <p className="mt-0.5 text-[12px] text-[var(--ink-muted)]">
                  People who drive your vehicles. They do not need a Cendro account.
                </p>
              </div>
              <Badge tone="neutral">{drivers.length}</Badge>
            </div>

            <form className="mt-3 grid gap-2 rounded-md border border-[var(--hairline)] p-3 sm:grid-cols-[1fr_1fr_auto]" onSubmit={handleAddDriver}>
              <div className="grid gap-1.5">
                <label htmlFor="fleet-new-driver-name" className={fieldLabelClass}>Name</label>
                <Input
                  ref={nameInputRef}
                  id="fleet-new-driver-name"
                  className={controlClass}
                  value={newName}
                  maxLength={100}
                  onChange={(event) => setNewName(event.target.value)}
                  placeholder="Driver name"
                />
              </div>
              <div className="grid gap-1.5">
                <label htmlFor="fleet-new-driver-phone" className={fieldLabelClass}>Phone</label>
                <Input
                  id="fleet-new-driver-phone"
                  className={controlClass}
                  value={newPhone}
                  onChange={(event) => setNewPhone(event.target.value)}
                  placeholder="Optional"
                />
              </div>
              <div className="flex items-end">
                <Button type="submit" variant="primary" className="h-10 w-full sm:w-auto" disabled={!newName.trim() || adding}>
                  {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  Add driver
                </Button>
              </div>
            </form>

            {driverError && <p className="alert-error mt-3 rounded-md px-3 py-2 text-[13px]" role="alert">{driverError}</p>}

            <div className="mt-3 grid gap-2">
              {drivers.length === 0 ? (
                <div className="rounded-md border border-dashed border-[var(--hairline-strong)] px-4 py-6 text-center">
                  <UserPlus className="mx-auto h-5 w-5 text-[var(--ink-faint)]" aria-hidden="true" />
                  <p className="mt-2 text-[13px] font-medium text-[var(--ink)]">No drivers yet</p>
                  <p className="mt-0.5 text-[12px] text-[var(--ink-muted)]">Add the people who drive your vehicles.</p>
                </div>
              ) : (
                drivers.map((driver) => (
                  <DriverRow
                    key={driver._id}
                    driver={driver}
                    pending={pendingDriverId === driver._id}
                    editing={editingDriverId === driver._id}
                    onEdit={() => setEditingDriverId(driver._id)}
                    onCancelEdit={() => setEditingDriverId(null)}
                    onSave={(name, phone) => handleSaveDriver(driver._id, name, phone)}
                    onToggleActive={() => void handleToggleDriver(driver)}
                    onDelete={() => setDeletingDriver(driver)}
                  />
                ))
              )}
            </div>
          </FleetCard>

          <FleetCard>
            <SectionHeading
              title="Trip logging"
              description="When on, Cendro alerts you if a vehicle moves without a logged trip. Turn it off for personal or owner cars."
            />
            {loggingError && <p className="alert-error mb-2 rounded-md px-3 py-2 text-[13px]" role="alert">{loggingError}</p>}
            {vehicles.length === 0 ? (
              <p className="text-[13px] text-[var(--ink-muted)]">
                No vehicles yet. Connect the tracker to choose which vehicles need logged trips.
              </p>
            ) : (
              <ul className="divide-y divide-[var(--hairline)] rounded-md border border-[var(--hairline)]">
                {vehicles.map((vehicle) => {
                  const enabled = loggingOverrides[vehicle._id] ?? vehicle.requiresTripLogging;
                  return (
                    <li key={vehicle._id} className="flex flex-wrap items-center gap-3 px-3 py-3">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-medium text-[var(--ink)]">{vehicle.name}</div>
                        <div className="text-[12px] text-[var(--ink-faint)]">{vehicle.registrationNumber}</div>
                      </div>
                      <Switch
                        checked={enabled}
                        aria-label={`Requires trip logging for ${vehicle.name}`}
                        onCheckedChange={() => void handleToggleTripLogging(vehicle)}
                        disabled={savingVehicleId === vehicle._id}
                        className="min-h-11 sm:min-h-0"
                      >
                        <span className="text-[12px] text-[var(--ink-muted)]">
                          {enabled ? "Requires trip logging" : "Personal vehicle — no trip alerts"}
                        </span>
                      </Switch>
                    </li>
                  );
                })}
              </ul>
            )}
          </FleetCard>

          <FleetCard>
            <h2 className="text-sm font-semibold text-[var(--ink)]">How alerts work</h2>
            <p className="mt-1 text-[13px] leading-5 text-[var(--ink-secondary)]">
              Cendro checks every 10 minutes. A trip left open for 12 hours alerts you. A vehicle more
              than 3 km off the direct route alerts you once.
            </p>
          </FleetCard>
        </div>
      )}

      {deletingDriver && (
        <ConfirmDialog
          open
          title="Delete driver?"
          description={`Delete ${deletingDriver.name}? Drivers with history cannot be deleted; deactivate them instead.`}
          onConfirm={async () => {
            await deleteDriver({ companyId, driverId: deletingDriver._id });
            setNotice("Driver deleted.");
          }}
          onClose={() => setDeletingDriver(null)}
        />
      )}
    </FleetStandalonePage>
  );
}

function DriverRow({
  driver,
  pending,
  editing,
  onEdit,
  onCancelEdit,
  onSave,
  onToggleActive,
  onDelete,
}: {
  driver: FleetDriverRow;
  pending: boolean;
  editing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: (name: string, phone: string) => Promise<void>;
  onToggleActive: () => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(driver.name);
  const [phone, setPhone] = useState(driver.phone ?? "");
  const [saving, setSaving] = useState(false);

  if (editing) {
    return (
      <form
        className="rounded-md border border-[var(--hairline)] p-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (saving || !name.trim()) return;
          setSaving(true);
          void onSave(name, phone).finally(() => setSaving(false));
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <label htmlFor={`fleet-driver-name-${driver._id}`} className={fieldLabelClass}>Name</label>
            <Input
              id={`fleet-driver-name-${driver._id}`}
              className={controlClass}
              value={name}
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
          </div>
          <div className="grid gap-1.5">
            <label htmlFor={`fleet-driver-phone-${driver._id}`} className={fieldLabelClass}>Phone</label>
            <Input
              id={`fleet-driver-phone-${driver._id}`}
              className={controlClass}
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="Optional"
            />
          </div>
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <Button type="button" variant="ghost" className="h-9" onClick={onCancelEdit} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" className="h-9" disabled={!name.trim() || saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--hairline)] px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium text-[var(--ink)]">{driver.name}</span>
          {!driver.active && <Badge tone="neutral">Inactive</Badge>}
        </div>
        <div className="truncate text-[12px] text-[var(--ink-faint)]">{driver.phone || "No phone"}</div>
      </div>
      <div className="flex items-center gap-0.5">
        <Button type="button" variant="ghost" size="sm" className="h-10" onClick={onEdit} disabled={pending}>
          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          Edit
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-10" onClick={onToggleActive} disabled={pending}>
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
          {driver.active ? "Deactivate" : "Reactivate"}
        </Button>
        <button
          type="button"
          className="task-icon-btn h-10 w-10"
          aria-label={`Delete ${driver.name}`}
          onClick={onDelete}
          disabled={pending}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

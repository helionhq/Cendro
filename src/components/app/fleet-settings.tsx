"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
import { useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { errorMessage, ConfirmDialog } from "./fleet-dialogs";
import { relativeTime, type FleetConnection, type FleetDriverRow } from "./fleet-format";

const fieldLabelClass = "text-[13px] font-medium text-[var(--ink-secondary)]";
const controlClass = "h-10 text-sm";

function SectionTitle({ id, title, description, children }: { id?: string; title: string; description: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <h3 id={id} className="text-sm font-semibold text-[var(--ink)]">{title}</h3>
        <p className="mt-0.5 text-[12px] text-[var(--ink-muted)]">{description}</p>
      </div>
      {children}
    </div>
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
        <Button type="button" variant="ghost" size="sm" className="h-9" onClick={onEdit} disabled={pending}>
          <Pencil className="h-3.5 w-3.5" />
          Edit
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-9" onClick={onToggleActive} disabled={pending}>
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {driver.active ? "Deactivate" : "Reactivate"}
        </Button>
        <button
          type="button"
          className="task-icon-btn"
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

export function FleetSettingsDialog({
  open,
  onOpenChange,
  companyId,
  now,
  connection,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: Id<"companies">;
  now: number;
  connection: FleetConnection | undefined;
}) {
  const connect = useAction(api.fleet.connect);
  const disconnect = useMutation(api.fleet.disconnect);
  const createDriver = useMutation(api.fleet.createDriver);
  const updateDriver = useMutation(api.fleet.updateDriver);
  const deleteDriver = useMutation(api.fleet.deleteDriver);
  const driversResult = useQuery(
    api.fleet.listDrivers,
    open ? { companyId, includeInactive: true } : "skip",
  );
  const drivers = driversResult?.drivers;

  const [keyInput, setKeyInput] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [trackerError, setTrackerError] = useState<string | null>(null);
  const [trackerNote, setTrackerNote] = useState<string | null>(null);
  const [disconnectConfirm, setDisconnectConfirm] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [adding, setAdding] = useState(false);
  const [driverError, setDriverError] = useState<string | null>(null);
  const [editingDriverId, setEditingDriverId] = useState<string | null>(null);
  const [pendingDriverId, setPendingDriverId] = useState<string | null>(null);
  const [deletingDriver, setDeletingDriver] = useState<FleetDriverRow | null>(null);

  async function handleConnect() {
    const secretKey = keyInput.trim();
    if (!secretKey || connecting) return;
    setConnecting(true);
    setTrackerError(null);
    setTrackerNote(null);
    try {
      const result = await connect({ companyId, secretKey });
      setTrackerNote(`Connected. ${result.vehicleCount} vehicle${result.vehicleCount === 1 ? "" : "s"} synced.`);
      setKeyInput("");
      setReplacing(false);
    } catch (err) {
      setTrackerError(errorMessage(err));
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    if (disconnecting) return;
    setDisconnecting(true);
    setTrackerError(null);
    setTrackerNote(null);
    try {
      await disconnect({ companyId });
      setDisconnectConfirm(false);
      setTrackerNote("Tracker disconnected. Vehicles and history were kept.");
    } catch (err) {
      setTrackerError(errorMessage(err));
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
      await createDriver({
        companyId,
        name: newName.trim(),
        phone: newPhone.trim() || undefined,
      });
      setNewName("");
      setNewPhone("");
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
      await updateDriver({
        companyId,
        driverId,
        name: name.trim(),
        phone: phone.trim() || null,
      });
      setEditingDriverId(null);
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

  async function handleDeleteDriver(driver: FleetDriverRow) {
    setPendingDriverId(driver._id);
    setDriverError(null);
    try {
      await deleteDriver({ companyId, driverId: driver._id });
    } catch (err) {
      setDriverError(errorMessage(err));
    } finally {
      setPendingDriverId(null);
    }
  }

  const connected = connection?.connected === true;
  const showKeyForm = !connected || replacing;

  return (
    <>
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]" />
        <Dialog.Content
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[92dvh] w-[min(720px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-[var(--hairline)] bg-[var(--surface)] text-[var(--ink)] shadow-[var(--shadow-elevated)]"
        >
          <div className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--hairline)] px-4 py-3 sm:px-6 sm:py-4">
            <div>
              <Dialog.Title className="text-[15px] font-semibold tracking-[-0.01em]">Fleet settings</Dialog.Title>
              <Dialog.Description className="mt-0.5 text-[12px] text-[var(--ink-muted)]">
                Connect the tracker and manage the driver roster.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="task-icon-btn" aria-label="Close fleet settings">
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
            <section aria-labelledby="fleet-tracker-heading">
              <SectionTitle
                id="fleet-tracker-heading"
                title="Tracker"
                description="Vehicles and odometers are read from your TrackWorld / portalxs account."
              >
                <Badge tone={connected ? "green" : "neutral"}>{connected ? "Connected" : "Not connected"}</Badge>
              </SectionTitle>

              {connection === undefined ? (
                <p className="mt-3 text-[13px] text-[var(--ink-muted)]">Loading connection…</p>
              ) : connected ? (
                <div className="mt-3 grid gap-3">
                  <div className="rounded-md border border-[var(--hairline)] bg-[var(--surface-muted)] px-3 py-2.5 text-[13px]">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <KeyRound className="h-3.5 w-3.5 text-[var(--ink-faint)]" />
                      <span>Key ending ••••{connection.keyHint ?? "----"}</span>
                      <span className="text-[var(--ink-faint)]">·</span>
                      <span className="text-[var(--ink-muted)]">
                        {connection.lastSyncAt
                          ? `Last synced ${relativeTime(connection.lastSyncAt, now)}`
                          : "Never synced"}
                      </span>
                      <span className="text-[var(--ink-faint)]">·</span>
                      <span className="text-[var(--ink-muted)]">
                        {connection.vehicleCount} vehicle{connection.vehicleCount === 1 ? "" : "s"}
                      </span>
                    </div>
                    {connection.lastSyncError && (
                      <p className="alert-error mt-2 rounded-md px-2 py-1.5 text-[12px]">{connection.lastSyncError}</p>
                    )}
                  </div>

                  {showKeyForm && (
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
                            onClick={() => { setReplacing(false); setKeyInput(""); setTrackerError(null); }}
                            disabled={connecting}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}

                  {!showKeyForm && (
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" variant="secondary" className="h-10" onClick={() => { setReplacing(true); setTrackerError(null); }}>
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
                </div>
              ) : (
                <div className="mt-3 grid gap-3">
                  <div className="grid gap-2 rounded-md border border-[var(--hairline)] p-3">
                    <label htmlFor="fleet-tracker-key" className={fieldLabelClass}>Tracker secret key</label>
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
                        {connecting ? "Connecting…" : "Connect"}
                      </Button>
                    </div>
                    <p className="text-[12px] leading-4 text-[var(--ink-faint)]">
                      Find the secret key in your TrackWorld / portalxs account. Cendro uses it only to read
                      vehicle positions and odometers, and never shows it again.
                    </p>
                  </div>
                </div>
              )}

              {trackerNote && <p className="mt-3 rounded-md bg-[var(--surface-muted)] px-3 py-2 text-[13px] text-[var(--ink-secondary)]" role="status">{trackerNote}</p>}
              {trackerError && <p className="alert-error mt-3 rounded-md px-3 py-2 text-[13px]" role="alert">{trackerError}</p>}
            </section>

            <section className="mt-6 border-t border-[var(--hairline)] pt-5" aria-labelledby="fleet-drivers-heading">
              <SectionTitle
                id="fleet-drivers-heading"
                title="Drivers"
                description="People who drive your vehicles. They do not need a Cendro account."
              >
                <Badge tone="neutral">{drivers?.length ?? 0}</Badge>
              </SectionTitle>

              <form className="mt-3 grid gap-2 rounded-md border border-[var(--hairline)] p-3 sm:grid-cols-[1fr_1fr_auto]" onSubmit={handleAddDriver}>
                <div className="grid gap-1.5">
                  <label htmlFor="fleet-new-driver-name" className={fieldLabelClass}>Name</label>
                  <Input
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
                {drivers === undefined ? (
                  <p className="text-[13px] text-[var(--ink-muted)]">Loading drivers…</p>
                ) : drivers.length === 0 ? (
                  <div className="rounded-md border border-dashed border-[var(--hairline-strong)] px-4 py-6 text-center">
                    <UserPlus className="mx-auto h-5 w-5 text-[var(--ink-faint)]" />
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
            </section>
          </div>

          <div className="flex shrink-0 justify-end border-t border-[var(--hairline)] px-4 py-3 sm:px-6">
            <Button type="button" variant="secondary" className="h-10" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
      {deletingDriver && (
        <ConfirmDialog
          open
          title="Delete driver?"
          description={`Delete ${deletingDriver.name}? Drivers with history cannot be deleted; deactivate them instead.`}
          onConfirm={async () => { await handleDeleteDriver(deletingDriver); }}
          onClose={() => setDeletingDriver(null)}
        />
      )}
    </>
  );
}

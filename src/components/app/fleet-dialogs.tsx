"use client";

import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  Camera,
  ExternalLink,
  Loader2,
  MoreHorizontal,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { Input, inputClassName } from "@/components/ui/input";
import { RequiredIndicator } from "@/components/ui/required-indicator";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  dateFieldFromTimestamp,
  formatFileSize,
  formatKm,
  kmInputFromMeters,
  metersFromKmInput,
  timestampForDateField,
  timestampForEditedDateField,
  type FleetFuelRow,
  type FleetServiceRow,
  type FleetTripRow,
} from "./fleet-format";

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const ALLOWED_PHOTO_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);
const PHOTO_ACCEPT = "image/jpeg,image/png,image/webp,image/heic,image/heif";
const fieldLabelClass = "text-[13px] font-medium text-[var(--ink-secondary)]";
const dialogControlClass = "h-10 text-sm";

export function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong. Try again.";
}

function FleetDialogFrame({
  title,
  description,
  children,
  onClose,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]" />
        <Dialog.Content
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[min(760px,92dvh)] w-[min(540px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-[var(--hairline)] bg-[var(--surface)] shadow-[var(--shadow-elevated)]"
        >
          <div className="flex shrink-0 items-center justify-between border-b border-[var(--hairline)] px-4 py-3 sm:px-6 sm:py-4">
            <Dialog.Title className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--ink)]">{title}</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="task-icon-btn" aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">{description}</Dialog.Description>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Field({
  label,
  required = false,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      {htmlFor ? (
        <label htmlFor={htmlFor} className={fieldLabelClass}>
          {label}
          {required && <RequiredIndicator />}
        </label>
      ) : (
        <span className={fieldLabelClass}>
          {label}
          {required && <RequiredIndicator />}
        </span>
      )}
      {children}
      {hint && <p className="text-[12px] leading-4 text-[var(--ink-faint)]">{hint}</p>}
    </div>
  );
}

function SelectField({
  id,
  ariaLabel,
  value,
  onChange,
  disabled = false,
  children,
}: {
  id?: string;
  ariaLabel: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <select
      id={id}
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      className={cn(inputClassName, dialogControlClass, "disabled:cursor-not-allowed disabled:opacity-60")}
    >
      {children}
    </select>
  );
}

type UploadedPhoto = {
  storageId: Id<"_storage">;
  claimId: Id<"fleetUploadClaims">;
  fileName: string;
  size: number;
};

/** Wire shape accepted by create/update validators; keeps local display fields out. */
function photoInput(photo: UploadedPhoto | null) {
  if (!photo) return undefined;
  return { storageId: photo.storageId, claimId: photo.claimId, fileName: photo.fileName };
}

function useFleetPhotoUpload(companyId: Id<"companies">) {
  const generateUploadUrl = useMutation(api.fleet.generateUploadUrl);
  const bindUploadClaim = useMutation(api.fleet.bindUploadClaim);
  const discardUpload = useMutation(api.fleet.discardUpload);
  const discardRef = useRef(discardUpload);
  const [photo, setPhoto] = useState<UploadedPhoto | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const photoRef = useRef<UploadedPhoto | null>(null);
  const previewRef = useRef<string | null>(null);
  useEffect(() => {
    discardRef.current = discardUpload;
  }, [discardUpload]);
  useEffect(() => {
    photoRef.current = photo;
  }, [photo]);

  function clearPreview() {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = null;
    setPreviewUrl(null);
  }

  async function discardCurrent() {
    const current = photoRef.current;
    photoRef.current = null;
    setPhoto(null);
    clearPreview();
    if (!current) return;
    try {
      await discardRef.current({ companyId, claimId: current.claimId });
    } catch {
      // The claim was already consumed by a successful save.
    }
  }

  function markSaved() {
    photoRef.current = null;
    setPhoto(null);
    clearPreview();
  }

  async function pick(file: File) {
    if (uploading) return;
    if (!ALLOWED_PHOTO_TYPES.has(file.type)) {
      setError("Choose a JPEG, PNG, WebP, HEIC, or HEIF image.");
      return;
    }
    if (file.size > MAX_PHOTO_BYTES) {
      setError("Photo must be 10 MB or smaller.");
      return;
    }
    setError(null);
    setUploading(true);
    await discardCurrent();
    let claimId: Id<"fleetUploadClaims"> | null = null;
    try {
      const upload = await generateUploadUrl({ companyId });
      claimId = upload.claimId;
      let response: Response;
      try {
        response = await fetch(upload.url, {
          method: "POST",
          headers: { "Content-Type": file.type || "image/jpeg" },
          body: file,
        });
      } catch {
        throw new Error("Could not upload the photo. Check your connection and try again.");
      }
      if (!response.ok) throw new Error("Could not upload the photo.");
      const json = (await response.json()) as { storageId?: Id<"_storage"> };
      if (!json.storageId) throw new Error("Could not upload the photo.");
      const bound = await bindUploadClaim({
        companyId,
        claimId: upload.claimId,
        storageId: json.storageId,
      });
      if (!bound.ok) {
        await discardRef.current({ companyId, claimId: upload.claimId }).catch(() => {});
        claimId = null;
        throw new Error(bound.error ?? "This photo cannot be used.");
      }
      const next: UploadedPhoto = {
        storageId: json.storageId,
        claimId: upload.claimId,
        fileName: file.name,
        size: file.size,
      };
      const objectUrl = URL.createObjectURL(file);
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
      previewRef.current = objectUrl;
      photoRef.current = next;
      setPhoto(next);
      setPreviewUrl(objectUrl);
      claimId = null;
    } catch (err) {
      if (claimId) await discardRef.current({ companyId, claimId }).catch(() => {});
      setError(errorMessage(err));
    } finally {
      setUploading(false);
    }
  }

  // Closing the dialog without saving releases the uploaded blob immediately.
  useEffect(() => () => {
    const current = photoRef.current;
    if (current) void discardRef.current({ companyId, claimId: current.claimId }).catch(() => {});
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
  }, [companyId]);

  return { photo, previewUrl, uploading, error, pick, discardCurrent, markSaved };
}

function PhotoField({
  required = false,
  hint,
  existingUrl = null,
  photo,
  previewUrl,
  uploading,
  error,
  onPick,
  onClear,
}: {
  required?: boolean;
  hint?: string;
  existingUrl?: string | null;
  photo: UploadedPhoto | null;
  previewUrl: string | null;
  uploading: boolean;
  error: string | null;
  onPick: (file: File) => void;
  onClear: () => void;
}) {
  const displayUrl = previewUrl ?? existingUrl;
  const blocked = uploading;
  return (
    <div className="grid gap-2">
      <span className={fieldLabelClass}>
        Photo
        {required && <RequiredIndicator />}
      </span>
      {hint && <p className="text-[12px] leading-4 text-[var(--ink-faint)]">{hint}</p>}
      <div className="flex items-center gap-3">
        {displayUrl && (
          <span
            role="img"
            aria-label="Selected photo"
            className="h-20 w-20 shrink-0 rounded-md border border-[var(--hairline)] bg-[var(--surface-muted)] bg-cover bg-center"
            style={{ backgroundImage: `url(${displayUrl})` }}
          />
        )}
        <div className="flex min-w-0 flex-col items-start gap-1.5">
          <label
            className={cn(
              "inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-md border border-[var(--hairline)] bg-[var(--surface)] px-3 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--surface-hover)] focus-within:ring-2 focus-within:ring-[var(--focus-ring)]",
              blocked && "cursor-not-allowed opacity-60",
            )}
          >
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
            {uploading ? "Uploading…" : displayUrl ? "Replace photo" : "Add photo"}
            <input
              className="sr-only"
              type="file"
              accept={PHOTO_ACCEPT}
              capture="environment"
              disabled={blocked}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.currentTarget.value = "";
                if (file) onPick(file);
              }}
            />
          </label>
          {photo && (
            <div className="flex items-center gap-2 text-[12px] text-[var(--ink-faint)]">
              <span className="max-w-[180px] truncate">{photo.fileName}</span>
              <span>{formatFileSize(photo.size)}</span>
              <button type="button" className="text-[var(--ink-secondary)] underline-offset-2 hover:underline" onClick={onClear}>
                Remove
              </button>
            </div>
          )}
        </div>
      </div>
      {error && <p className="alert-error rounded-md px-2 py-1.5 text-[12px]" role="alert">{error}</p>}
    </div>
  );
}

function DialogError({ error }: { error: string | null }) {
  if (!error) return null;
  return <p className="alert-error mx-4 mt-3 rounded-md px-3 py-2 text-[13px] sm:mx-6" role="alert">{error}</p>;
}

function DialogFooter({ saving, label, disabled, onCancel }: { saving: boolean; label: string; disabled: boolean; onCancel: () => void }) {
  return (
    <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--hairline)] px-4 py-3 sm:px-6">
      <Button type="button" variant="secondary" className="h-10" onClick={onCancel} disabled={saving}>
        Cancel
      </Button>
      <Button type="submit" variant="primary" className="h-10" disabled={disabled || saving}>
        {saving ? "Saving…" : label}
      </Button>
    </div>
  );
}

export function TripDialog({
  mode,
  companyId,
  now,
  preselectedVehicleId,
  trip,
  onClose,
}: {
  mode: "create" | "edit";
  companyId: Id<"companies">;
  now: number;
  preselectedVehicleId?: Id<"fleetVehicles">;
  trip?: FleetTripRow;
  onClose: () => void;
}) {
  const startTrip = useAction(api.fleet.startTrip);
  const updateTrip = useMutation(api.fleet.updateTrip);
  const vehiclesResult = useQuery(api.fleet.listVehicles, { companyId, now });
  const driversResult = useQuery(api.fleet.listDrivers, { companyId, includeInactive: true });
  const openTripsResult = useQuery(api.fleet.listOpenTrips, { companyId });
  const vehicles = vehiclesResult?.vehicles;
  const drivers = driversResult?.drivers;
  const openTrips = openTripsResult?.trips;
  const editing = mode === "edit" && Boolean(trip);

  const eligibleVehicles = useMemo(() => {
    if (!vehicles) return [];
    if (editing && trip) return vehicles.filter((vehicle) => vehicle._id === trip.vehicleId);
    return vehicles.filter((vehicle) => vehicle.status !== "on_trip");
  }, [editing, trip, vehicles]);

  const eligibleDrivers = useMemo(() => {
    if (!drivers) return [];
    const openDriverIds = new Set(
      (openTrips ?? []).filter((openTrip) => openTrip._id !== trip?._id).map((openTrip) => String(openTrip.driverId)),
    );
    const available = drivers.filter((driver) => driver.active && !openDriverIds.has(String(driver._id)));
    if (editing && trip && !available.some((driver) => driver._id === trip.driverId)) {
      const current = drivers.find((driver) => driver._id === trip.driverId);
      if (current) return [current, ...available];
    }
    return available;
  }, [drivers, editing, openTrips, trip]);

  const [vehicleId, setVehicleId] = useState<string>(trip?.vehicleId ?? preselectedVehicleId ?? "");
  const [driverId, setDriverId] = useState<string>(trip?.driverId ?? "");
  const [destination, setDestination] = useState(trip?.destination ?? "");
  const [notes, setNotes] = useState(trip?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!vehicles) return;
    if (vehicleId && eligibleVehicles.some((vehicle) => vehicle._id === vehicleId)) return;
    setVehicleId(eligibleVehicles[0]?._id ?? "");
  }, [eligibleVehicles, vehicleId, vehicles]);

  useEffect(() => {
    if (!drivers) return;
    // A saved driver is never silently replaced; only a create form adopts a default.
    if (editing && driverId) return;
    if (driverId && eligibleDrivers.some((driver) => driver._id === driverId)) return;
    setDriverId(eligibleDrivers[0]?._id ?? "");
  }, [driverId, drivers, editing, eligibleDrivers]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    if (!vehicleId) { setError("Choose a vehicle."); return; }
    if (!driverId) { setError("Choose a driver."); return; }
    if (!destination.trim()) { setError("Destination is required."); return; }
    setSaving(true);
    setError(null);
    try {
      if (editing && trip) {
        await updateTrip({
          companyId,
          tripId: trip._id,
          driverId: driverId as Id<"fleetDrivers">,
          destination: destination.trim(),
          notes: notes.trim() || null,
        });
      } else {
        await startTrip({
          companyId,
          vehicleId: vehicleId as Id<"fleetVehicles">,
          driverId: driverId as Id<"fleetDrivers">,
          destination: destination.trim(),
          notes: notes.trim() || undefined,
        });
      }
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const noVehicles = vehicles !== undefined && eligibleVehicles.length === 0;
  const noDrivers = drivers !== undefined && eligibleDrivers.length === 0;

  return (
    <FleetDialogFrame
      title={editing ? "Edit trip" : "Log trip"}
      description="Record a vehicle leaving the warehouse."
      onClose={onClose}
    >
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
        <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto px-4 py-4 sm:px-6">
          <Field label="Vehicle" required htmlFor="fleet-trip-vehicle">
            <SelectField
              id="fleet-trip-vehicle"
              ariaLabel="Vehicle"
              value={vehicleId}
              onChange={setVehicleId}
              disabled={editing || !vehicles}
            >
              <option value="">{vehicles ? "Select vehicle" : "Loading vehicles…"}</option>
              {eligibleVehicles.map((vehicle) => (
                <option key={vehicle._id} value={vehicle._id}>
                  {vehicle.name}{vehicle.displayName ? ` (${vehicle.registrationNumber})` : ""}
                </option>
              ))}
            </SelectField>
          </Field>
          {noVehicles && (
            <p className="text-[12px] text-[var(--ink-muted)]">
              Every vehicle is already on a trip. Mark a trip returned first.
            </p>
          )}
          <Field label="Driver" required htmlFor="fleet-trip-driver">
            <SelectField
              id="fleet-trip-driver"
              ariaLabel="Driver"
              value={driverId}
              onChange={setDriverId}
              disabled={!drivers}
            >
              <option value="">{drivers ? "Select driver" : "Loading drivers…"}</option>
              {eligibleDrivers.map((driver) => (
                <option key={driver._id} value={driver._id}>
                  {driver.name}{driver.active ? "" : " (inactive)"}
                </option>
              ))}
            </SelectField>
          </Field>
          {noDrivers && (
            <p className="text-[12px] text-[var(--ink-muted)]">
              No active driver is available. Add a driver in Fleet settings, or mark their trip returned.
            </p>
          )}
          <Field label="Destination" required htmlFor="fleet-trip-destination">
            <Input
              id="fleet-trip-destination"
              className={dialogControlClass}
              value={destination}
              maxLength={200}
              onChange={(event) => setDestination(event.target.value)}
              placeholder="Where is the vehicle going?"
            />
          </Field>
          <Field label="Notes" htmlFor="fleet-trip-notes">
            <Textarea
              id="fleet-trip-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Optional context"
              rows={3}
            />
          </Field>
        </div>
        <DialogError error={error} />
        <DialogFooter
          saving={saving}
          label={editing ? "Save changes" : "Start trip"}
          disabled={!vehicleId || !driverId || !destination.trim()}
          onCancel={onClose}
        />
      </form>
    </FleetDialogFrame>
  );
}

export function FuelDialog({
  mode,
  companyId,
  now,
  preselectedVehicleId,
  entry,
  onClose,
}: {
  mode: "create" | "edit";
  companyId: Id<"companies">;
  now: number;
  preselectedVehicleId?: Id<"fleetVehicles">;
  entry?: FleetFuelRow;
  onClose: () => void;
}) {
  const createFuelEntry = useMutation(api.fleet.createFuelEntry);
  const updateFuelEntry = useMutation(api.fleet.updateFuelEntry);
  const vehiclesResult = useQuery(api.fleet.listVehicles, { companyId, now });
  const driversResult = useQuery(api.fleet.listDrivers, { companyId, includeInactive: true });
  const vehicles = vehiclesResult?.vehicles;
  const drivers = driversResult?.drivers;
  const editing = mode === "edit" && Boolean(entry);
  const upload = useFleetPhotoUpload(companyId);

  const [vehicleId, setVehicleId] = useState<string>(entry?.vehicleId ?? preselectedVehicleId ?? "");
  const [driverId, setDriverId] = useState<string>(entry?.driverId ?? "");
  const [dateValue, setDateValue] = useState(
    entry ? dateFieldFromTimestamp(entry.filledAt) : dateFieldFromTimestamp(now),
  );
  const [odometer, setOdometer] = useState(entry ? kmInputFromMeters(entry.odometerMeters) : "");
  const [litres, setLitres] = useState(entry ? String(entry.litres) : "");
  const [amount, setAmount] = useState(entry ? String(entry.amount) : "");
  const [notes, setNotes] = useState(entry?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedVehicle = vehicles?.find((vehicle) => vehicle._id === vehicleId);
  // Leaving the date at today means "now": the server may default the reading.
  const isNow = !editing && dateValue === dateFieldFromTimestamp(now);
  const odometerRequired = !editing && !isNow;

  useEffect(() => {
    if (!vehicles) return;
    if (vehicleId && vehicles.some((vehicle) => vehicle._id === vehicleId)) return;
    setVehicleId(vehicles[0]?._id ?? "");
  }, [vehicleId, vehicles]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving || upload.uploading) return;
    if (!vehicleId) { setError("Choose a vehicle."); return; }
    const litresValue = Number(litres);
    if (!Number.isFinite(litresValue) || litresValue <= 0) { setError("Litres must be greater than zero."); return; }
    const amountValue = Number(amount);
    if (!Number.isFinite(amountValue) || amountValue < 0) { setError("Enter a valid amount."); return; }
    const odometerMeters = metersFromKmInput(odometer);
    if (odometer.trim() && odometerMeters === null) { setError("Odometer is invalid."); return; }
    if (odometerRequired && odometerMeters === null) { setError("Odometer is required for a past date."); return; }
    if (!editing && !upload.photo) { setError("Add a photo of the fuel gauge or receipt."); return; }
    setSaving(true);
    setError(null);
    try {
      const filledAt = entry
        ? timestampForEditedDateField(dateValue, entry.filledAt)
        : isNow
          ? null
          : timestampForDateField(dateValue, now);
      const timeArgs = filledAt === null ? {} : { filledAt };
      const odometerArgs = odometerMeters === null ? {} : { odometerMeters };
      if (editing && entry) {
        await updateFuelEntry({
          companyId,
          entryId: entry._id,
          driverId: driverId ? (driverId as Id<"fleetDrivers">) : null,
          ...timeArgs,
          litres: litresValue,
          amount: amountValue,
          notes: notes.trim() || null,
          ...odometerArgs,
          ...(photoInput(upload.photo) ? { photo: photoInput(upload.photo)! } : {}),
        });
      } else {
        const photo = photoInput(upload.photo);
        if (!photo) return;
        await createFuelEntry({
          companyId,
          vehicleId: vehicleId as Id<"fleetVehicles">,
          driverId: driverId ? (driverId as Id<"fleetDrivers">) : undefined,
          ...timeArgs,
          litres: litresValue,
          amount: amountValue,
          notes: notes.trim() || undefined,
          ...odometerArgs,
          photo,
        });
      }
      upload.markSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <FleetDialogFrame
      title={editing ? "Edit fuel entry" : "Log fuel"}
      description="Record a fuel fill-up with a photo."
      onClose={onClose}
    >
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
        <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto px-4 py-4 sm:px-6">
          <Field label="Vehicle" required htmlFor="fleet-fuel-vehicle">
            <SelectField
              id="fleet-fuel-vehicle"
              ariaLabel="Vehicle"
              value={vehicleId}
              onChange={setVehicleId}
              disabled={editing || !vehicles}
            >
              <option value="">{vehicles ? "Select vehicle" : "Loading vehicles…"}</option>
              {(vehicles ?? []).map((vehicle) => (
                <option key={vehicle._id} value={vehicle._id}>
                  {vehicle.name}{vehicle.displayName ? ` (${vehicle.registrationNumber})` : ""}
                </option>
              ))}
            </SelectField>
          </Field>
          <Field label="Driver" htmlFor="fleet-fuel-driver" hint="Optional">
            <SelectField
              id="fleet-fuel-driver"
              ariaLabel="Driver"
              value={driverId}
              onChange={setDriverId}
              disabled={!drivers}
            >
              <option value="">No driver</option>
              {(drivers ?? [])
                .filter((driver) => driver.active || driver._id === entry?.driverId)
                .map((driver) => (
                  <option key={driver._id} value={driver._id}>
                    {driver.name}{driver.active ? "" : " (inactive)"}
                  </option>
                ))}
            </SelectField>
          </Field>
          <Field label="Date">
            <DateField value={dateValue} onChange={setDateValue} aria-label="Fill-up date" className={dialogControlClass} />
          </Field>
          <Field
            label="Odometer (km)"
            required={odometerRequired}
            htmlFor="fleet-fuel-odometer"
            hint={
              editing
                ? "Odometer recorded for this fill-up."
                : isNow
                  ? selectedVehicle?.odometerKm != null
                    ? `Latest reading: ${formatKm(selectedVehicle.odometerKm)}. Leave blank to use it.`
                    : "Leave blank to use the latest reading."
                  : "Required for a past date."
            }
          >
            <Input
              id="fleet-fuel-odometer"
              className={dialogControlClass}
              inputMode="decimal"
              value={odometer}
              onChange={(event) => setOdometer(event.target.value)}
              placeholder={isNow ? "Latest reading" : "Odometer at fill-up"}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Litres" required htmlFor="fleet-fuel-litres">
              <Input
                id="fleet-fuel-litres"
                className={dialogControlClass}
                inputMode="decimal"
                value={litres}
                onChange={(event) => setLitres(event.target.value)}
                placeholder="0"
              />
            </Field>
            <Field label="Amount (PKR)" required htmlFor="fleet-fuel-amount">
              <Input
                id="fleet-fuel-amount"
                className={dialogControlClass}
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="0"
              />
            </Field>
          </div>
          <PhotoField
            required={!editing}
            hint="Take a photo of the fuel gauge or receipt."
            existingUrl={entry?.photo.url ?? null}
            photo={upload.photo}
            previewUrl={upload.previewUrl}
            uploading={upload.uploading}
            error={upload.error}
            onPick={(file) => void upload.pick(file)}
            onClear={() => void upload.discardCurrent()}
          />
          <Field label="Notes" htmlFor="fleet-fuel-notes">
            <Textarea
              id="fleet-fuel-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Optional context"
              rows={2}
            />
          </Field>
        </div>
        <DialogError error={error} />
        <DialogFooter
          saving={saving}
          label={editing ? "Save changes" : "Save fuel entry"}
          disabled={!vehicleId || !litres.trim() || !amount.trim() || upload.uploading || (!editing && !upload.photo) || (odometerRequired && !odometer.trim())}
          onCancel={onClose}
        />
      </form>
    </FleetDialogFrame>
  );
}

export function ServiceDialog({
  mode,
  companyId,
  now,
  preselectedVehicleId,
  entry,
  onClose,
}: {
  mode: "create" | "edit";
  companyId: Id<"companies">;
  now: number;
  preselectedVehicleId?: Id<"fleetVehicles">;
  entry?: FleetServiceRow;
  onClose: () => void;
}) {
  const createServiceEntry = useMutation(api.fleet.createServiceEntry);
  const updateServiceEntry = useMutation(api.fleet.updateServiceEntry);
  const vehiclesResult = useQuery(api.fleet.listVehicles, { companyId, now });
  const vehicles = vehiclesResult?.vehicles;
  const editing = mode === "edit" && Boolean(entry);
  const upload = useFleetPhotoUpload(companyId);

  const [vehicleId, setVehicleId] = useState<string>(entry?.vehicleId ?? preselectedVehicleId ?? "");
  const [dateValue, setDateValue] = useState(
    entry ? dateFieldFromTimestamp(entry.servicedAt) : dateFieldFromTimestamp(now),
  );
  const [odometer, setOdometer] = useState(entry ? kmInputFromMeters(entry.odometerMeters) : "");
  const [description, setDescription] = useState(entry?.description ?? "");
  const [cost, setCost] = useState(entry?.cost != null ? String(entry.cost) : "");
  const [notes, setNotes] = useState(entry?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedVehicle = vehicles?.find((vehicle) => vehicle._id === vehicleId);
  // Leaving the date at today means "now": the server may default the reading.
  const isNow = !editing && dateValue === dateFieldFromTimestamp(now);

  useEffect(() => {
    if (!vehicles) return;
    if (vehicleId && vehicles.some((vehicle) => vehicle._id === vehicleId)) return;
    setVehicleId(vehicles[0]?._id ?? "");
  }, [vehicleId, vehicles]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving || upload.uploading) return;
    if (!vehicleId) { setError("Choose a vehicle."); return; }
    if (!description.trim()) { setError("Description is required."); return; }
    const odometerMeters = metersFromKmInput(odometer);
    if (odometer.trim() && odometerMeters === null) { setError("Odometer is invalid."); return; }
    const costValue = cost.trim() === "" ? null : Number(cost);
    if (costValue !== null && (!Number.isFinite(costValue) || costValue < 0)) {
      setError("Enter a valid cost.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const servicedAt = entry
        ? timestampForEditedDateField(dateValue, entry.servicedAt)
        : isNow
          ? null
          : timestampForDateField(dateValue, now);
      const timeArgs = servicedAt === null ? {} : { servicedAt };
      if (editing && entry) {
        await updateServiceEntry({
          companyId,
          entryId: entry._id,
          ...timeArgs,
          odometerMeters,
          description: description.trim(),
          cost: costValue,
          notes: notes.trim() || null,
          ...(photoInput(upload.photo) ? { photo: photoInput(upload.photo)! } : {}),
        });
      } else {
        await createServiceEntry({
          companyId,
          vehicleId: vehicleId as Id<"fleetVehicles">,
          ...timeArgs,
          ...(odometerMeters !== null ? { odometerMeters } : {}),
          description: description.trim(),
          ...(costValue !== null ? { cost: costValue } : {}),
          notes: notes.trim() || undefined,
          ...(photoInput(upload.photo) ? { photo: photoInput(upload.photo)! } : {}),
        });
      }
      upload.markSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <FleetDialogFrame
      title={editing ? "Edit service entry" : "Log service"}
      description="Record maintenance work and its cost."
      onClose={onClose}
    >
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
        <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto px-4 py-4 sm:px-6">
          <Field label="Vehicle" required htmlFor="fleet-service-vehicle">
            <SelectField
              id="fleet-service-vehicle"
              ariaLabel="Vehicle"
              value={vehicleId}
              onChange={setVehicleId}
              disabled={editing || !vehicles}
            >
              <option value="">{vehicles ? "Select vehicle" : "Loading vehicles…"}</option>
              {(vehicles ?? []).map((vehicle) => (
                <option key={vehicle._id} value={vehicle._id}>
                  {vehicle.name}{vehicle.displayName ? ` (${vehicle.registrationNumber})` : ""}
                </option>
              ))}
            </SelectField>
          </Field>
          <Field label="Service date" required>
            <DateField value={dateValue} onChange={setDateValue} aria-label="Service date" className={dialogControlClass} />
          </Field>
          <Field
            label="Odometer (km)"
            htmlFor="fleet-service-odometer"
            hint={
              editing
                ? "Odometer recorded for this service."
                : !isNow
                  ? "Optional for a past date."
                  : selectedVehicle?.odometerKm != null
                    ? `Latest reading: ${formatKm(selectedVehicle.odometerKm)}. Leave blank to use it.`
                    : "Leave blank to use the latest reading."
            }
          >
            <Input
              id="fleet-service-odometer"
              className={dialogControlClass}
              inputMode="decimal"
              value={odometer}
              onChange={(event) => setOdometer(event.target.value)}
              placeholder={editing ? "Odometer at service" : !isNow ? "Odometer at service (optional)" : "Leave blank to use the latest reading"}
            />
          </Field>
          <Field label="Description" required htmlFor="fleet-service-description">
            <Input
              id="fleet-service-description"
              className={dialogControlClass}
              value={description}
              maxLength={300}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="e.g. Oil and filter change"
            />
          </Field>
          <Field label="Cost (PKR)" htmlFor="fleet-service-cost" hint="Optional">
            <Input
              id="fleet-service-cost"
              className={dialogControlClass}
              inputMode="decimal"
              value={cost}
              onChange={(event) => setCost(event.target.value)}
              placeholder="0"
            />
          </Field>
          <PhotoField
            hint="Optional receipt or photo."
            existingUrl={entry?.photo?.url ?? null}
            photo={upload.photo}
            previewUrl={upload.previewUrl}
            uploading={upload.uploading}
            error={upload.error}
            onPick={(file) => void upload.pick(file)}
            onClear={() => void upload.discardCurrent()}
          />
          <Field label="Notes" htmlFor="fleet-service-notes">
            <Textarea
              id="fleet-service-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Optional context"
              rows={2}
            />
          </Field>
        </div>
        <DialogError error={error} />
        <DialogFooter
          saving={saving}
          label={editing ? "Save changes" : "Save service entry"}
          disabled={!vehicleId || !description.trim() || upload.uploading}
          onCancel={onClose}
        />
      </form>
    </FleetDialogFrame>
  );
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Delete",
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next && !pending) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(400px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-[var(--hairline)] bg-[var(--surface)] p-5 text-[var(--ink)] shadow-[var(--shadow-popover)]">
          <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-[var(--ink-muted)]">{description}</Dialog.Description>
          {error && <p className="alert-error mt-3 rounded-md p-2 text-sm" role="alert">{error}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" className="h-10" onClick={onClose} disabled={pending}>Cancel</Button>
            <Button variant="danger" className="h-10" onClick={() => void confirm()} disabled={pending}>
              {pending ? "Deleting…" : confirmLabel}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function RecordMenu({
  label,
  onEdit,
  onDelete,
}: {
  label: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="task-icon-btn" aria-label={`Actions for ${label}`}>
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" className="task-menu">
          <DropdownMenu.Item className="task-menu-item" onSelect={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </DropdownMenu.Item>
          <DropdownMenu.Item className="task-menu-item text-[var(--danger)]" onSelect={onDelete}>
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function PhotoLightbox({
  url,
  label,
  onClose,
}: {
  url: string;
  label: string;
  onClose: () => void;
}) {
  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[92dvh] w-[min(720px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-[var(--hairline)] bg-[var(--surface)] shadow-[var(--shadow-elevated)]">
          <div className="flex items-center justify-between gap-3 border-b border-[var(--hairline)] px-4 py-2.5">
            <Dialog.Title className="min-w-0 truncate text-sm font-medium text-[var(--ink)]">{label}</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="task-icon-btn" aria-label="Close photo">
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">Enlarged photo</Dialog.Description>
          <div
            role="img"
            aria-label={label}
            className="h-[min(70dvh,560px)] w-full bg-[var(--surface-muted)] bg-contain bg-center bg-no-repeat"
            style={{ backgroundImage: `url(${url})` }}
          />
          <div className="flex justify-end border-t border-[var(--hairline)] px-4 py-2.5">
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 items-center gap-2 rounded-md px-2 text-sm text-[var(--ink-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink)]"
            >
              <ExternalLink className="h-4 w-4" />
              Open full size
            </a>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}


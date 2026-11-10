"use client";

import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useAction, useMutation, usePaginatedQuery, useQuery } from "convex/react";
import {
  Camera,
  ExternalLink,
  Loader2,
  MapPin,
  MoreHorizontal,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DateField } from "@/components/ui/date-field";
import { Input, inputClassName } from "@/components/ui/input";
import { RequiredIndicator } from "@/components/ui/required-indicator";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  alertDisplayTitle,
  dateFieldFromTimestamp,
  dayGroupKey,
  formatDayLabel,
  formatFileSize,
  formatKm,
  formatTime,
  formatTimeRange,
  googleMapsUrl,
  isShortGoogleMapsLink,
  kmInputFromMeters,
  metersFromKmInput,
  parseCoordinates,
  relativeTime,
  timestampForDateField,
  timestampForEditedDateField,
  type FleetAlertFeedRow,
  type FleetFuelRow,
  type FleetPlace,
  type FleetPlaceSuggestion,
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

export function FleetDialogFrame({
  title,
  description,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]" />
        <Dialog.Content
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          className={cn(
            "fixed inset-x-0 bottom-0 top-auto z-50 flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-[var(--hairline)] bg-[var(--surface)] shadow-[var(--shadow-elevated)]",
            "sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl",
            wide ? "sm:w-[min(620px,calc(100vw-24px))]" : "sm:w-[min(540px,calc(100vw-24px))]",
          )}
        >
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--hairline)] px-4 py-3 sm:px-6 sm:py-4">
            <Dialog.Title className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--ink)]">{title}</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="task-icon-btn h-10 w-10 sm:h-8 sm:w-8" aria-label="Close">
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

export function Field({
  label,
  required = false,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: React.ReactNode;
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

export function SelectField({
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

export function useFleetPhotoUpload(companyId: Id<"companies">) {
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

export function PhotoField({
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

export function DialogError({ error }: { error: string | null }) {
  if (!error) return null;
  return <p className="alert-error mx-4 mt-3 rounded-md px-3 py-2 text-[13px] sm:mx-6" role="alert">{error}</p>;
}

export function DialogFooter({
  saving,
  savingLabel = "Saving…",
  label,
  disabled,
  onCancel,
  extra,
}: {
  saving: boolean;
  savingLabel?: string;
  label: string;
  disabled: boolean;
  onCancel: () => void;
  extra?: React.ReactNode;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-[var(--hairline)] px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 sm:px-6 sm:pb-3">
      {extra}
      <Button type="button" variant="secondary" className="h-11 sm:h-10" onClick={onCancel} disabled={saving}>
        Cancel
      </Button>
      <Button type="submit" variant="primary" className="h-11 sm:h-10" disabled={disabled || saving}>
        {saving ? savingLabel : label}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Start / edit trip
// ---------------------------------------------------------------------------

export function StartTripDialog({
  companyId,
  now,
  preselectedVehicleId,
  trip,
  canManage,
  timeZone,
  onClose,
  onSaved,
}: {
  companyId: Id<"companies">;
  now: number;
  preselectedVehicleId?: Id<"fleetVehicles">;
  trip?: FleetTripRow;
  canManage: boolean;
  timeZone?: string;
  onClose: () => void;
  onSaved?: (message: string) => void;
}) {
  const startTrip = useAction(api.fleet.startTrip);
  const updateTrip = useMutation(api.fleet.updateTrip);
  const vehiclesResult = useQuery(api.fleet.listVehicles, { companyId, now });
  const driversResult = useQuery(api.fleet.listDrivers, { companyId, includeInactive: true });
  const placesResult = useQuery(api.fleetPlaces.listPlaces, { companyId });
  const openTripsResult = useQuery(api.fleet.listOpenTrips, { companyId });
  const recentQuery = usePaginatedQuery(
    api.fleet.listTrips,
    { companyId, ...(trip ? { vehicleId: trip.vehicleId } : {}) },
    { initialNumItems: 50 },
  );
  const recentTrips = recentQuery.results as FleetTripRow[];
  const vehicles = vehiclesResult?.vehicles;
  const drivers = driversResult?.drivers;
  const places = useMemo(() => placesResult?.places ?? [], [placesResult?.places]);
  const openTrips = useMemo(() => openTripsResult?.trips ?? [], [openTripsResult?.trips]);
  const editing = Boolean(trip);

  const eligibleVehicles = useMemo(() => {
    if (!vehicles) return [];
    if (trip) return vehicles.filter((vehicle) => vehicle._id === trip.vehicleId);
    const busy = new Set(openTrips.map((openTrip) => String(openTrip.vehicleId)));
    return vehicles.filter((vehicle) => !busy.has(String(vehicle._id)));
  }, [openTrips, trip, vehicles]);

  const eligibleDrivers = useMemo(() => {
    if (!drivers) return [];
    const busy = new Set(
      openTrips.filter((openTrip) => openTrip._id !== trip?._id).map((openTrip) => String(openTrip.driverId)),
    );
    const available = drivers.filter((driver) => driver.active && !busy.has(String(driver._id)));
    if (trip && !available.some((driver) => driver._id === trip.driverId)) {
      const current = drivers.find((driver) => driver._id === trip.driverId);
      if (current) return [current, ...available];
    }
    return available;
  }, [drivers, openTrips, trip]);

  const [vehicleId, setVehicleId] = useState<string>(trip?.vehicleId ?? preselectedVehicleId ?? "");
  const [driverId, setDriverId] = useState<string>(trip?.driverId ?? "");
  const [driverTouched, setDriverTouched] = useState(editing);
  const [destinationKind, setDestinationKind] = useState<"place" | "other" | null>(
    trip ? (trip.placeId ? "place" : "other") : null,
  );
  const [placeId, setPlaceId] = useState<string>(trip?.placeId ?? "");
  const [otherDestination, setOtherDestination] = useState(trip && !trip.placeId ? trip.destination : "");
  const [notes, setNotes] = useState(trip?.notes ?? "");
  const [noteOpen, setNoteOpen] = useState(Boolean(trip?.notes));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!vehicles) return;
    if (vehicleId && eligibleVehicles.some((vehicle) => vehicle._id === vehicleId)) return;
    const fallback =
      !editing && eligibleVehicles.length === 1 ? eligibleVehicles[0]._id : "";
    if (fallback !== vehicleId) setVehicleId(fallback);
  }, [editing, eligibleVehicles, vehicleId, vehicles]);

  useEffect(() => {
    if (!drivers) return;
    if (driverId && eligibleDrivers.some((driver) => driver._id === driverId)) return;
    if (driverId) setDriverId("");
  }, [driverId, drivers, eligibleDrivers]);

  useEffect(() => {
    if (editing || driverTouched || !vehicleId || !drivers) return;
    const last = recentTrips.find((recent) => recent.vehicleId === vehicleId);
    if (last && eligibleDrivers.some((driver) => driver._id === last.driverId)) {
      setDriverId(last.driverId);
    }
  }, [driverTouched, drivers, editing, eligibleDrivers, recentTrips, vehicleId]);

  useEffect(() => {
    if (!trip?.placeId || placesResult === undefined) return;
    if (destinationKind !== "place") return;
    if (places.some((place) => place._id === trip.placeId)) return;
    // The saved place was archived: keep the trip's label as an "Other" trip.
    setDestinationKind("other");
    setOtherDestination(trip.destination);
    setPlaceId("");
  }, [destinationKind, places, placesResult, trip]);

  const lastUsedByPlace = useMemo(() => {
    const map = new Map<string, number>();
    for (const recent of recentTrips) {
      if (!recent.placeId) continue;
      map.set(recent.placeId, Math.max(map.get(recent.placeId) ?? 0, recent.departedAt));
    }
    return map;
  }, [recentTrips]);

  const destinations = useMemo(
    () =>
      places
        .filter((place) => place.kind === "destination")
        .sort(
          (a, b) =>
            (lastUsedByPlace.get(b._id) ?? 0) - (lastUsedByPlace.get(a._id) ?? 0) ||
            a.name.localeCompare(b.name),
        ),
    [lastUsedByPlace, places],
  );
  const warehouses = useMemo(
    () =>
      places
        .filter((place) => place.kind === "base")
        .sort(
          (a, b) =>
            (lastUsedByPlace.get(b._id) ?? 0) - (lastUsedByPlace.get(a._id) ?? 0) ||
            a.name.localeCompare(b.name),
        ),
    [lastUsedByPlace, places],
  );
  const topDestinationId = destinations[0]?._id;
  const selectedPlace = places.find((place) => place._id === placeId) ?? null;
  const destinationLabel =
    destinationKind === "place" ? selectedPlace?.name ?? "" : otherDestination.trim();
  const canSubmit =
    Boolean(vehicleId) &&
    Boolean(driverId) &&
    Boolean(destinationKind) &&
    Boolean(destinationLabel);

  function chooseVehicle(value: string) {
    setVehicleId(value);
    if (driverTouched) return;
    const last = recentTrips.find((recent) => recent.vehicleId === value);
    setDriverId(
      last && eligibleDrivers.some((driver) => driver._id === last.driverId)
        ? last.driverId
        : "",
    );
  }

  function choosePlace(place: FleetPlace) {
    setDestinationKind("place");
    setPlaceId(place._id);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    if (!vehicleId) { setError("Choose a vehicle."); return; }
    if (!driverId) { setError("Choose a driver."); return; }
    if (!destinationKind || !destinationLabel) { setError("Choose a destination."); return; }
    setSaving(true);
    setError(null);
    try {
      if (trip) {
        await updateTrip({
          companyId,
          tripId: trip._id,
          driverId: driverId as Id<"fleetDrivers">,
          notes: notes.trim() || null,
          ...(destinationKind === "place"
            ? { placeId: placeId as Id<"fleetPlaces"> }
            : { placeId: null, destination: otherDestination.trim() }),
        });
      } else {
        await startTrip({
          companyId,
          vehicleId: vehicleId as Id<"fleetVehicles">,
          driverId: driverId as Id<"fleetDrivers">,
          ...(destinationKind === "place"
            ? { placeId: placeId as Id<"fleetPlaces"> }
            : { destination: otherDestination.trim() }),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        });
      }
      onSaved?.(trip ? "Trip updated." : "Trip started. We'll mark arrival automatically.");
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const noVehicles = vehicles !== undefined && eligibleVehicles.length === 0;
  const noDrivers = drivers !== undefined && eligibleDrivers.length === 0;
  const hasActiveDrivers = Boolean(drivers?.some((driver) => driver.active));
  const lastUsedToday = (id: Id<"fleetPlaces">) => {
    const last = lastUsedByPlace.get(id);
    return last != null && dayGroupKey(last, timeZone) === dayGroupKey(now, timeZone);
  };

  return (
    <FleetDialogFrame
      title={editing ? "Edit trip" : "Start a trip"}
      description={editing ? "Update where this vehicle went." : "Tell us where this vehicle is going."}
      onClose={onClose}
    >
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
        <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto px-4 py-4 sm:px-6">
          <p className="text-[13px] text-[var(--ink-muted)]">
            {editing ? "Update where this vehicle went." : "Tell us where this vehicle is going."}
          </p>
          <Field label="Vehicle" required htmlFor="fleet-trip-vehicle">
            <SelectField
              id="fleet-trip-vehicle"
              ariaLabel="Vehicle"
              value={vehicleId}
              onChange={chooseVehicle}
              disabled={editing || !vehicles}
            >
              <option value="">{vehicles ? "Choose a vehicle" : "Loading vehicles…"}</option>
              {eligibleVehicles.map((vehicle) => (
                <option key={vehicle._id} value={vehicle._id}>
                  {vehicle.name}{vehicle.displayName ? ` · ${vehicle.registrationNumber}` : ""}
                </option>
              ))}
            </SelectField>
          </Field>
          {noVehicles && (
            <p className="text-[12px] text-[var(--ink-muted)]">
              {vehicles?.length === 0 ? (
                <>
                  Connect your tracker first.{" "}
                  <Link className="font-medium text-[var(--ink)] underline underline-offset-2" href="/fleet/settings">
                    Open settings
                  </Link>
                </>
              ) : (
                "Every vehicle is already on a trip. Mark a trip returned first."
              )}
            </p>
          )}

          <Field label="Driver" required htmlFor="fleet-trip-driver">
            <SelectField
              id="fleet-trip-driver"
              ariaLabel="Driver"
              value={driverId}
              onChange={(value) => { setDriverTouched(true); setDriverId(value); }}
              disabled={!drivers}
            >
              <option value="">{drivers ? "Choose a driver" : "Loading drivers…"}</option>
              {eligibleDrivers.map((driver) => (
                <option key={driver._id} value={driver._id}>
                  {driver.name}{driver.active ? "" : " (inactive)"}
                </option>
              ))}
            </SelectField>
          </Field>
          {noDrivers && (
            <p className="text-[12px] text-[var(--ink-muted)]">
              {hasActiveDrivers ? (
                "Every driver is already on a trip. Mark a trip returned first."
              ) : canManage ? (
                <>
                  Add a driver before starting a trip.{" "}
                  <Link className="font-medium text-[var(--ink)] underline underline-offset-2" href="/fleet/settings#drivers">
                    Add driver
                  </Link>
                </>
              ) : (
                "Add a driver before starting a trip. Ask an admin to add one in Fleet settings."
              )}
            </p>
          )}

          <div className="grid gap-1.5">
            <span className={fieldLabelClass}>
              Where to?
              <RequiredIndicator />
            </span>
            <div className="max-h-[268px] overflow-y-auto rounded-md border border-[var(--hairline)]">
              {destinations.length > 0 && (
                <ul aria-label="Destinations">
                  {destinations.map((place) => (
                    <li key={place._id} className="border-b border-[var(--hairline)] last:border-0">
                      <button
                        type="button"
                        aria-pressed={destinationKind === "place" && placeId === place._id}
                        onClick={() => choosePlace(place)}
                        className={cn(
                          "flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-[13px] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]",
                          destinationKind === "place" && placeId === place._id
                            ? "border border-[var(--primary)] bg-[var(--surface-muted)]"
                            : "border border-transparent",
                        )}
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-[var(--ink)]">{place.name}</span>
                          {place.address && <span className="block truncate text-[12px] text-[var(--ink-muted)]">{place.address}</span>}
                        </span>
                        {place._id === topDestinationId && lastUsedToday(place._id) && (
                          <span className="shrink-0 text-[12px] text-[var(--ink-faint)]">last used today</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {warehouses.length > 0 && (
                <>
                  <div className="border-y border-[var(--hairline)] bg-[var(--surface-muted)] px-3 py-1 text-[11px] font-medium uppercase tracking-[0.04em] text-[var(--ink-faint)]">
                    Warehouses
                  </div>
                  <ul aria-label="Warehouses">
                    {warehouses.map((place) => (
                      <li key={place._id} className="border-b border-[var(--hairline)] last:border-0">
                        <button
                          type="button"
                          aria-pressed={destinationKind === "place" && placeId === place._id}
                          onClick={() => choosePlace(place)}
                          className={cn(
                            "flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-[13px] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]",
                            destinationKind === "place" && placeId === place._id
                              ? "border border-[var(--primary)] bg-[var(--surface-muted)]"
                              : "border border-transparent",
                          )}
                        >
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-[var(--ink)]">{place.name}</span>
                            {place.address && <span className="block truncate text-[12px] text-[var(--ink-muted)]">{place.address}</span>}
                          </span>
                          <span className="shrink-0 text-[12px] text-[var(--ink-faint)]">warehouse</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <button
                type="button"
                aria-pressed={destinationKind === "other"}
                onClick={() => setDestinationKind("other")}
                className={cn(
                  "flex w-full px-3 py-3 text-left text-[13px] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]",
                  destinationKind === "other"
                    ? "border border-[var(--primary)] bg-[var(--surface-muted)] font-medium text-[var(--ink)]"
                    : "border border-transparent text-[var(--ink-secondary)]",
                )}
              >
                Other — type a destination
              </button>
            </div>
            {destinationKind === "other" && (
              <div className="mt-1 grid gap-1.5">
                <Input
                  aria-label="Destination"
                  className={dialogControlClass}
                  value={otherDestination}
                  maxLength={200}
                  onChange={(event) => setOtherDestination(event.target.value)}
                  placeholder="e.g. Bank on Peco Road"
                />
                <p className="text-[12px] text-[var(--ink-faint)]">
                  Other trips are not checked for route problems.
                </p>
              </div>
            )}
            {places.length === 0 && resolutionCanAddPlaces(canManage)}
          </div>

          {noteOpen ? (
            <Field label="Note" htmlFor="fleet-trip-notes">
              <Textarea
                id="fleet-trip-notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Optional context"
                rows={2}
              />
            </Field>
          ) : (
            <button
              type="button"
              className="justify-self-start text-[13px] font-medium text-[var(--ink-secondary)] hover:text-[var(--ink)]"
              onClick={() => setNoteOpen(true)}
            >
              Add a note
            </button>
          )}
        </div>
        <DialogError error={error} />
        <DialogFooter
          saving={saving}
          savingLabel={editing ? "Saving…" : "Starting…"}
          label={editing ? "Save changes" : "Start trip"}
          disabled={!canSubmit}
          onCancel={onClose}
        />
      </form>
    </FleetDialogFrame>
  );

  function resolutionCanAddPlaces(manage: boolean) {
    if (places.length > 0) return null;
    return (
      <p className="mt-1 text-[12px] text-[var(--ink-faint)]">
        Add places to make this faster next time.{" "}
        {manage && (
          <Link className="font-medium text-[var(--ink)] underline underline-offset-2" href="/fleet/places">
            Add place
          </Link>
        )}
      </p>
    );
  }
}

// ---------------------------------------------------------------------------
// Trip detail
// ---------------------------------------------------------------------------

export type TripSheetTrip = {
  _id: Id<"fleetTrips">;
  vehicleId: Id<"fleetVehicles">;
  vehicleName: string;
  driverName: string | null;
  destination: string;
  notes: string | null;
  status: "open" | "returned";
  departedAt: number;
  returnedAt: number | null;
  arrivedAt: number | null;
  autoReturned: boolean;
  basePlaceId: Id<"fleetPlaces"> | null;
  placeId: Id<"fleetPlaces"> | null;
  distanceKm: number | null;
  actualDistanceKm: number | null;
  offRoute: boolean;
  maxDeviationKm: number | null;
};

export function TripDetailDialog({
  companyId,
  trip,
  canLog,
  canManage,
  timeZone,
  onClose,
  onEdit,
  onSaved,
}: {
  companyId: Id<"companies">;
  trip: TripSheetTrip;
  canLog: boolean;
  canManage: boolean;
  timeZone?: string;
  onClose: () => void;
  onEdit?: () => void;
  onSaved?: (message: string) => void;
}) {
  const returnTrip = useAction(api.fleet.returnTrip);
  const deleteTrip = useMutation(api.fleet.deleteTrip);
  const placesResult = useQuery(api.fleetPlaces.listPlaces, { companyId, includeArchived: true });
  const [returning, setReturning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const places = placesResult?.places ?? [];
  const destinationPlace = places.find((place) => place._id === trip.placeId) ?? null;
  const basePlace = places.find((place) => place._id === trip.basePlaceId) ?? null;
  const chip =
    trip.status === "open"
      ? { label: "On trip", tone: "blue" as const }
      : trip.autoReturned
        ? { label: "Closed automatically", tone: "neutral" as const }
        : { label: "Returned", tone: "neutral" as const };
  const distanceKm = trip.actualDistanceKm ?? trip.distanceKm;
  const baseLabel = basePlace?.name;

  async function markReturned() {
    if (returning) return;
    setReturning(true);
    setError(null);
    try {
      await returnTrip({ companyId, tripId: trip._id });
      onSaved?.("Trip marked returned.");
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setReturning(false);
    }
  }

  async function removeTrip() {
    if (deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteTrip({ companyId, tripId: trip._id });
      onSaved?.("Trip deleted.");
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <FleetDialogFrame
        title={`Trip to ${trip.destination}`}
        description={`Trip details for ${trip.vehicleName}.`}
        onClose={onClose}
      >
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[13px] text-[var(--ink-secondary)]">
              {trip.vehicleName}
              {trip.driverName ? ` · ${trip.driverName}` : ""}
            </p>
            <span className={cn("inline-flex items-center rounded-sm px-1.5 py-0.5 text-xs font-medium", chip.tone === "blue" ? "bg-[var(--badge-blue-bg)] text-[var(--badge-blue-fg)]" : "bg-[var(--surface-pressed)] text-[var(--ink-muted)]")}>
              {chip.label}
            </span>
          </div>

          <ol className="mt-4 grid gap-0">
            <TripEvent
              tone="done"
              label={baseLabel ? `Left ${baseLabel}` : "Left"}
              value={formatTime(trip.departedAt, timeZone)}
            />
            <TripEvent
              tone={trip.arrivedAt != null ? "done" : "waiting"}
              label={
                trip.arrivedAt != null
                  ? `Arrived ${trip.destination}`
                  : trip.status === "returned"
                    ? "Arrival not recorded"
                    : "Not arrived yet"
              }
              value={trip.arrivedAt != null ? formatTime(trip.arrivedAt, timeZone) : ""}
            />
            <TripEvent
              tone={trip.returnedAt != null ? "done" : "waiting"}
              label={
                trip.returnedAt != null
                  ? trip.autoReturned
                    ? "Closed automatically"
                    : baseLabel
                      ? `Return to ${baseLabel}`
                      : "Returned"
                  : "Waiting to return"
              }
              value={trip.returnedAt != null ? formatTime(trip.returnedAt, timeZone) : ""}
            />
          </ol>

          <dl className="mt-5 grid gap-2.5 rounded-md border border-[var(--hairline)] bg-[var(--surface-muted)] p-3 text-[13px]">
            <FactRow label="Distance" value={formatKm(distanceKm)} />
            <FactRow
              label="Route"
              value={
                trip.placeId == null ? (
                  <span className="text-[var(--ink-muted)]">Not checked</span>
                ) : trip.offRoute ? (
                  <span className="text-[var(--badge-yellow-fg)]">
                    {formatKm(trip.maxDeviationKm)} off route
                  </span>
                ) : (
                  <span className="text-[var(--badge-green-fg)]">On route</span>
                )
              }
            />
            <FactRow label="Note" value={trip.notes || "—"} />
            <FactRow label="Driver" value={trip.driverName || "—"} />
          </dl>
          <DialogError error={error} />
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-[var(--hairline)] px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 sm:px-6 sm:pb-3">
          {destinationPlace && (
            <Button asChild variant="ghost" className="h-11 sm:h-10">
              <a
                href={googleMapsUrl(destinationPlace.lat, destinationPlace.lng)}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink className="h-4 w-4" aria-hidden="true" />
                Open in Google Maps
              </a>
            </Button>
          )}
          {onEdit && canManage && (
            <Button type="button" variant="secondary" className="h-11 sm:h-10" onClick={onEdit}>
              Edit trip
            </Button>
          )}
          {canManage && (
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button type="button" className="task-icon-btn h-11 w-11 sm:h-10 sm:w-10" aria-label="More trip actions">
                  <MoreHorizontal className="h-4 w-4" />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content align="end" className="task-menu">
                  <DropdownMenu.Item className="task-menu-item text-[var(--danger)]" onSelect={() => setConfirmDelete(true)}>
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete trip
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          )}
          {trip.status === "open" && canLog && (
            <Button type="button" variant="primary" className="h-11 sm:h-10" disabled={returning} onClick={() => void markReturned()}>
              {returning ? "Marking…" : "Mark returned"}
            </Button>
          )}
        </div>
        <span className="sr-only">Trip reference {trip._id}</span>
      </FleetDialogFrame>
      {confirmDelete && (
        <ConfirmDialog
          open
          title="Delete trip?"
          description={`This removes the trip to ${trip.destination} from history.`}
          onConfirm={removeTrip}
          onClose={() => setConfirmDelete(false)}
        />
      )}
    </>
  );
}

function TripEvent({
  tone,
  label,
  value,
}: {
  tone: "done" | "waiting";
  label: string;
  value: string;
}) {
  return (
    <li className="relative flex items-start gap-3 pb-4 last:pb-0">
      <span
        aria-hidden="true"
        className={cn(
          "mt-1 h-2.5 w-2.5 shrink-0 rounded-full border-2",
          tone === "done"
            ? "border-[var(--primary)] bg-[var(--primary)]"
            : "border-[var(--hairline-strong)] bg-[var(--surface)]",
        )}
      />
      <span className="absolute left-[4px] top-4 h-[calc(100%-16px)] w-px bg-[var(--hairline)] last:hidden" aria-hidden="true" />
      <span className="flex min-w-0 flex-1 items-baseline justify-between gap-3">
        <span className={cn("text-[13px]", tone === "done" ? "text-[var(--ink)]" : "text-[var(--ink-muted)]")}>{label}</span>
        <span className="shrink-0 text-[12px] tabular-nums text-[var(--ink-muted)]">{value}</span>
      </span>
    </li>
  );
}

function FactRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 text-[var(--ink-muted)]">{label}</dt>
      <dd className="min-w-0 text-right text-[var(--ink)]">{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Log an unlogged movement as a trip
// ---------------------------------------------------------------------------

export function LogAsTripDialog({
  companyId,
  now,
  alert,
  timeZone,
  onClose,
  onSaved,
}: {
  companyId: Id<"companies">;
  now: number;
  alert: FleetAlertFeedRow;
  timeZone?: string;
  onClose: () => void;
  onSaved?: (message: string) => void;
}) {
  const logAsTrip = useMutation(api.fleetMonitoring.logUnloggedAlertAsTrip);
  const driversResult = useQuery(api.fleet.listDrivers, { companyId });
  const placesResult = useQuery(api.fleetPlaces.listPlaces, { companyId });
  const recentQuery = usePaginatedQuery(
    api.fleet.listTrips,
    alert.vehicleId ? { companyId, vehicleId: alert.vehicleId } : { companyId },
    { initialNumItems: 20 },
  );
  const recentTrips = recentQuery.results as FleetTripRow[];
  const drivers = (driversResult?.drivers ?? []).filter((driver) => driver.active);
  const places = placesResult?.places ?? [];
  const matchedPlace = places.find(
    (place) =>
      (alert.toAddress && (place.name === alert.toAddress || place.address === alert.toAddress)) ||
      (alert.address && place.name === alert.address),
  );

  const [driverId, setDriverId] = useState("");
  const [destinationId, setDestinationId] = useState<string | null>(null);
  const [otherDestination, setOtherDestination] = useState(
    alert.toAddress ?? alert.address ?? "",
  );
  const effectiveDestinationId = destinationId ?? matchedPlace?._id ?? "other";
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [driverPrefilled, setDriverPrefilled] = useState(false);

  useEffect(() => {
    if (driverPrefilled || driverId || !alert.vehicleId) return;
    const last = recentTrips.find((trip) => trip.vehicleId === alert.vehicleId);
    if (last && drivers.some((driver) => driver._id === last.driverId)) {
      setDriverId(last.driverId);
      setDriverPrefilled(true);
    }
  }, [alert.vehicleId, driverId, driverPrefilled, drivers, recentTrips]);

  const destination =
    effectiveDestinationId === "other"
      ? otherDestination.trim()
      : places.find((place) => place._id === effectiveDestinationId)?.name ?? "";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    if (!alert._id) { setError("This alert cannot be logged as a trip."); return; }
    if (!driverId) { setError("Choose a driver."); return; }
    if (!destination) { setError("Choose a destination."); return; }
    setSaving(true);
    setError(null);
    try {
      await logAsTrip({
        companyId,
        alertId: alert._id,
        driverId: driverId as Id<"fleetDrivers">,
        destination,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
      onSaved?.("Trip saved and alert closed.");
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <FleetDialogFrame
      title="Log this as a trip"
      description="Save this movement as a returned trip and close the alert."
      onClose={onClose}
    >
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
        <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto px-4 py-4 sm:px-6">
          <p className="text-[13px] text-[var(--ink-muted)]">
            We&apos;ll save this movement as a returned trip and close the alert.
          </p>
          <div className="rounded-md bg-[var(--surface-muted)] px-3 py-2.5 text-[13px]">
            <div className="font-medium text-[var(--ink)]">{alert.vehicleName ?? "Vehicle"}</div>
            <div className="mt-0.5 text-[var(--ink-muted)]">
              {formatDayLabel(alert.occurredAt ?? now, now, timeZone)} ·{" "}
              {formatTimeRange(alert.occurredAt, alert.endedAt, timeZone)} ·{" "}
              {formatKm(alert.distanceKm)}
            </div>
            {(alert.fromAddress || alert.toAddress) && (
              <div className="mt-1 text-[var(--ink-secondary)]">
                {alert.fromAddress ?? "Unknown place"} → {alert.toAddress ?? "Unknown place"}
              </div>
            )}
          </div>

          <Field label="Driver" required htmlFor="fleet-log-trip-driver">
            <SelectField id="fleet-log-trip-driver" ariaLabel="Driver" value={driverId} onChange={setDriverId} disabled={!driversResult}>
              <option value="">{driversResult ? "Choose a driver" : "Loading drivers…"}</option>
              {drivers.map((driver) => (
                <option key={driver._id} value={driver._id}>{driver.name}</option>
              ))}
            </SelectField>
          </Field>

          <Field label="Destination" required htmlFor="fleet-log-trip-destination">
            <SelectField
              id="fleet-log-trip-destination"
              ariaLabel="Destination"
              value={effectiveDestinationId}
              onChange={(value) => setDestinationId(value === "other" ? "other" : value)}
            >
              {places.map((place) => (
                <option key={place._id} value={place._id}>
                  {place.name}{place.kind === "base" ? " (warehouse)" : ""}
                </option>
              ))}
              <option value="other">Other — type a destination</option>
            </SelectField>
          </Field>
          {effectiveDestinationId === "other" && (
            <Field label="Destination name" htmlFor="fleet-log-trip-other">
              <Input
                id="fleet-log-trip-other"
                className={dialogControlClass}
                value={otherDestination}
                maxLength={200}
                onChange={(event) => {
                  setOtherDestination(event.target.value);
                  setDestinationId("other");
                }}
                placeholder="e.g. Trade International, Begum Kot"
              />
            </Field>
          )}

          <Field label="Note" htmlFor="fleet-log-trip-note">
            <Textarea
              id="fleet-log-trip-note"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="e.g. Approved by Arham"
              rows={2}
            />
          </Field>
          {alert.fromAddress && alert.toAddress && (
            <p className="text-[12px] text-[var(--ink-faint)]">
              Route: {alert.fromAddress} → {alert.toAddress}
            </p>
          )}
        </div>
        <DialogError error={error} />
        <DialogFooter
          saving={saving}
          label="Save trip"
          disabled={!driverId || !destination}
          onCancel={onClose}
        />
      </form>
    </FleetDialogFrame>
  );
}

// ---------------------------------------------------------------------------
// Mark reviewed
// ---------------------------------------------------------------------------

export function ReviewAlertDialog({
  companyId,
  alert,
  canManage,
  now,
  timeZone,
  onClose,
  onSaved,
}: {
  companyId: Id<"companies">;
  alert: FleetAlertFeedRow;
  canManage: boolean;
  now: number;
  timeZone?: string;
  onClose: () => void;
  onSaved?: (message: string) => void;
}) {
  const resolveAlert = useMutation(api.fleetMonitoring.resolveAlert);
  const setVehicleTripLogging = useMutation(api.fleetMonitoring.setVehicleTripLogging);
  const [note, setNote] = useState("");
  const [personal, setPersonal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canStopTripAlerts =
    canManage && alert.kind === "unlogged_movement" && alert.vehicleId != null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    if (!alert._id) { setError("This alert cannot be reviewed."); return; }
    setSaving(true);
    setError(null);
    try {
      // Resolve first: setVehicleTripLogging resolves open movement alerts with
      // its own system note, so running it first would discard the reviewer's note.
      await resolveAlert({
        companyId,
        alertId: alert._id,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      if (personal && canStopTripAlerts && alert.vehicleId) {
        await setVehicleTripLogging({
          companyId,
          vehicleId: alert.vehicleId,
          requiresTripLogging: false,
        });
      }
      onSaved?.("Marked as reviewed.");
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const displayTitle = alertDisplayTitle(alert, now);

  return (
    <FleetDialogFrame
      title="Mark as reviewed"
      description={`${displayTitle}. ${alert.occurredAt ? formatDayLabel(alert.occurredAt, now, timeZone) : ""}`}
      onClose={onClose}
    >
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
        <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto px-4 py-4 sm:px-6">
          <p className="text-[13px] text-[var(--ink-secondary)]">
            <span className="font-medium text-[var(--ink)]">{displayTitle}</span>
            {alert.occurredAt != null && (
              <span className="text-[var(--ink-muted)]">
                {" "}· {formatDayLabel(alert.occurredAt, now, timeZone)}{" "}
                {formatTime(alert.occurredAt, timeZone)}
              </span>
            )}
          </p>
          <Field label="What happened? (optional)" htmlFor="fleet-review-note">
            <Textarea
              id="fleet-review-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="e.g. Approved personal use"
              rows={3}
              maxLength={500}
            />
          </Field>
          {canStopTripAlerts && (
            <label className="flex items-start gap-2.5 rounded-md border border-[var(--hairline)] p-3 text-[13px]">
              <Checkbox
                checked={personal}
                onCheckedChange={setPersonal}
                aria-label="This is a personal vehicle — stop asking about its trips"
                className="mt-0.5"
              />
              <span>
                <span className="block font-medium text-[var(--ink)]">
                  This is a personal vehicle — stop asking about its trips
                </span>
                <span className="mt-0.5 block text-[12px] text-[var(--ink-muted)]">
                  You can turn this back on in Fleet settings.
                </span>
              </span>
            </label>
          )}
        </div>
        <DialogError error={error} />
        <DialogFooter saving={saving} label="Save" disabled={false} onCancel={onClose} />
      </form>
    </FleetDialogFrame>
  );
}

// ---------------------------------------------------------------------------
// Add / edit place
// ---------------------------------------------------------------------------

const radiusOptions = [
  { value: 100, label: "Very close — 100 m" },
  { value: 300, label: "Normal — 300 m (recommended)" },
  { value: 500, label: "Large site — 500 m" },
  { value: 1000, label: "Very large site — 1 km" },
];

export function PlaceDialog({
  companyId,
  now,
  place,
  suggestion,
  defaultKind = "destination",
  onClose,
  onSaved,
}: {
  companyId: Id<"companies">;
  now: number;
  place?: FleetPlace;
  suggestion?: FleetPlaceSuggestion;
  defaultKind?: "base" | "destination";
  onClose: () => void;
  onSaved?: (message: string) => void;
}) {
  const createPlace = useMutation(api.fleetPlaces.createPlace);
  const updatePlace = useMutation(api.fleetPlaces.updatePlace);
  const vehiclesResult = useQuery(api.fleet.listVehicles, { companyId, now });
  const vehicles = useMemo(() => vehiclesResult?.vehicles ?? [], [vehiclesResult?.vehicles]);
  const editing = Boolean(place);
  const suggestedName = (suggestion?.address?.trim() || "Suggested place").slice(0, 100);

  const [name, setName] = useState(place?.name ?? (suggestion ? suggestedName : ""));
  const [kind, setKind] = useState<"base" | "destination">(
    place?.kind ?? (suggestion ? "destination" : defaultKind),
  );
  const [radius, setRadius] = useState<number>(place?.radiusMeters ?? 300);
  const [address, setAddress] = useState(place?.address ?? suggestion?.address ?? "");
  const [source, setSource] = useState<"vehicle" | "paste">(place ? "paste" : "vehicle");
  const [vehicleId, setVehicleId] = useState("");
  const [linkInput, setLinkInput] = useState(place ? `${place.lat}, ${place.lng}` : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (vehicleId || vehicles.length === 0) return;
    const located = vehicles.find((vehicle) => vehicle.lat != null && vehicle.lng != null);
    setVehicleId((located ?? vehicles[0])._id);
  }, [vehicleId, vehicles]);

  const selectedVehicle = vehicles.find((vehicle) => vehicle._id === vehicleId) ?? null;
  const parsedLink = parseCoordinates(linkInput);
  const coordinates = suggestion
    ? { lat: suggestion.lat, lng: suggestion.lng }
    : source === "vehicle"
      ? selectedVehicle?.lat != null && selectedVehicle.lng != null
        ? { lat: selectedVehicle.lat, lng: selectedVehicle.lng }
        : null
      : parsedLink;
  const canSubmit = name.trim().length > 0 && coordinates != null;

  function chooseVehicle(value: string) {
    setVehicleId(value);
    const vehicle = vehicles.find((candidate) => candidate._id === value);
    if (vehicle?.address && !address.trim()) setAddress(vehicle.address);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    if (!name.trim()) { setError("Place name is required."); return; }
    if (!coordinates) {
      setError("Choose a position for this place.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (place) {
        await updatePlace({
          companyId,
          placeId: place._id,
          name: name.trim(),
          kind,
          lat: coordinates.lat,
          lng: coordinates.lng,
          radiusMeters: radius,
          address: address.trim() || null,
        });
        onSaved?.("Place updated.");
      } else {
        await createPlace({
          companyId,
          name: name.trim(),
          kind,
          lat: coordinates.lat,
          lng: coordinates.lng,
          radiusMeters: radius,
          ...(address.trim() ? { address: address.trim() } : {}),
        });
        onSaved?.("Place added. It will appear in the trip list.");
      }
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <FleetDialogFrame
      title={editing ? "Edit place" : "Add a place"}
      description={editing ? "Update this saved place." : "Save a warehouse or a regular destination."}
      onClose={onClose}
    >
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
        <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto px-4 py-4 sm:px-6">
          <Field label="Name" required htmlFor="fleet-place-name" hint="What everyone calls this place.">
            <Input
              id="fleet-place-name"
              className={dialogControlClass}
              value={name}
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Saggian Plant (Achha Dairies)"
            />
          </Field>

          <div className="grid gap-1.5">
            <span className={fieldLabelClass}>
              Kind
              <RequiredIndicator />
            </span>
            <div className="grid grid-cols-2 gap-2">
              {(["destination", "base"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={kind === option}
                  onClick={() => setKind(option)}
                  className={cn(
                    "rounded-md border px-3 py-2 text-left text-[13px] transition-colors",
                    kind === option
                      ? "border-[var(--primary)] bg-[var(--surface-muted)] font-medium text-[var(--ink)]"
                      : "border-[var(--hairline)] text-[var(--ink-secondary)] hover:bg-[var(--surface-hover)]",
                  )}
                >
                  {option === "base" ? "Warehouse" : "Destination"}
                </button>
              ))}
            </div>
            <p className="text-[12px] leading-4 text-[var(--ink-faint)]">
              Warehouse = where trips start and end. Destination = everywhere else vehicles go.
            </p>
          </div>

          {suggestion ? (
            <div className="rounded-md bg-[var(--surface-muted)] px-3 py-2.5 text-[13px] text-[var(--ink-secondary)]">
              <span className="block font-medium text-[var(--ink)]">From suggestion</span>
              <span className="mt-0.5 block">
                {suggestion.visitCount} {suggestion.visitCount === 1 ? "visit" : "visits"} · last{" "}
                {relativeTime(suggestion.lastVisitAt, now)}
              </span>
            </div>
          ) : (
            <div className="grid gap-2">
              <span className={fieldLabelClass}>
                Where is it?
                <RequiredIndicator />
              </span>
              <div className="flex gap-1 rounded-md border border-[var(--hairline)] bg-[var(--surface-muted)] p-0.5">
                {([
                  { key: "vehicle", label: "Where a vehicle is now" },
                  { key: "paste", label: "Paste a map link" },
                ] as const).map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    aria-pressed={source === tab.key}
                    onClick={() => setSource(tab.key)}
                    className={cn(
                      "flex-1 rounded px-2 py-1.5 text-[12px] font-medium transition-colors",
                      source === tab.key
                        ? "bg-[var(--surface)] text-[var(--ink)]"
                        : "text-[var(--ink-muted)] hover:text-[var(--ink)]",
                    )}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {source === "vehicle" ? (
                <div className="grid gap-2 rounded-md border border-[var(--hairline)] p-3">
                  <SelectField
                    ariaLabel="Vehicle"
                    value={vehicleId}
                    onChange={chooseVehicle}
                    disabled={vehicles.length === 0}
                  >
                    <option value="">
                      {vehiclesResult === undefined ? "Loading vehicles…" : "Choose a vehicle"}
                    </option>
                    {vehicles.map((vehicle) => (
                      <option key={vehicle._id} value={vehicle._id}>
                        {vehicle.name}{vehicle.displayName ? ` · ${vehicle.registrationNumber}` : ""}
                      </option>
                    ))}
                  </SelectField>
                  {selectedVehicle?.lat != null && selectedVehicle.lng != null ? (
                    <>
                      <p className="text-[12px] text-[var(--ink-muted)]">
                        {selectedVehicle.name} is at {selectedVehicle.address || "an unknown address"} ·
                        {" "}updated {relativeTime(selectedVehicle.recordedAt, now)}
                      </p>
                      <a
                        href={googleMapsUrl(selectedVehicle.lat, selectedVehicle.lng)}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex w-fit items-center gap-1 text-[12px] font-medium text-[var(--ink-secondary)] underline-offset-2 hover:text-[var(--ink)] hover:underline"
                      >
                        <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                        Open in Google Maps
                      </a>
                    </>
                  ) : (
                    <p className="text-[12px] text-[var(--ink-muted)]">
                      {vehicles.length === 0
                        ? "No vehicles yet. Paste a map link instead."
                        : "This vehicle has no position yet. Choose another vehicle or paste a map link."}
                    </p>
                  )}
                </div>
              ) : (
                <div className="grid gap-2 rounded-md border border-[var(--hairline)] p-3">
                  <Field label="Google Maps link or coordinates" htmlFor="fleet-place-link">
                    <Input
                      id="fleet-place-link"
                      className={dialogControlClass}
                      value={linkInput}
                      onChange={(event) => setLinkInput(event.target.value)}
                      placeholder="https://maps.google.com/... or 31.582, 74.329"
                    />
                  </Field>
                  {parsedLink ? (
                    <div className="flex flex-wrap items-center gap-2 text-[12px]">
                      <span className="inline-flex items-center gap-1 text-[var(--ink)]">
                        <MapPin className="h-3.5 w-3.5 text-[var(--ink-faint)]" aria-hidden="true" />
                        {parsedLink.lat.toFixed(4)}, {parsedLink.lng.toFixed(4)}
                      </span>
                      <a
                        href={googleMapsUrl(parsedLink.lat, parsedLink.lng)}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 font-medium text-[var(--ink-secondary)] underline-offset-2 hover:text-[var(--ink)] hover:underline"
                      >
                        <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                        Open in Google Maps
                      </a>
                    </div>
                  ) : linkInput.trim() ? (
                    <p className="text-[12px] text-[var(--badge-red-fg)]" role="alert">
                      {isShortGoogleMapsLink(linkInput)
                        ? "Short links can't be read. Open it in Google Maps, then copy the full link from the address bar, or paste 'latitude, longitude'."
                        : "Couldn't find coordinates in that link. Paste a Google Maps share link or 'latitude, longitude'."}
                    </p>
                  ) : (
                    <p className="text-[12px] text-[var(--ink-faint)]">
                      Paste a share link, or type latitude, longitude.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          <Field label="How close counts as arrived">
            <SelectField
              ariaLabel="How close counts as arrived"
              value={String(radius)}
              onChange={(value) => setRadius(Number(value))}
            >
              {radiusOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
              {!radiusOptions.some((option) => option.value === radius) && (
                <option value={radius}>{radius} m</option>
              )}
            </SelectField>
          </Field>

          <Field label="Address (optional)" htmlFor="fleet-place-address" hint="Shown under the place name.">
            <Input
              id="fleet-place-address"
              className={dialogControlClass}
              value={address}
              maxLength={300}
              onChange={(event) => setAddress(event.target.value)}
              placeholder="Shown under the place name"
            />
          </Field>
        </div>
        <DialogError error={error} />
        <DialogFooter
          saving={saving}
          label={editing ? "Save changes" : "Add place"}
          disabled={!canSubmit}
          onCancel={onClose}
        />
      </form>
    </FleetDialogFrame>
  );
}

// ---------------------------------------------------------------------------
// Existing fuel and service dialogs
// ---------------------------------------------------------------------------

export function FuelDialog({
  mode,
  companyId,
  now,
  preselectedVehicleId,
  entry,
  timeZone,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  companyId: Id<"companies">;
  now: number;
  preselectedVehicleId?: Id<"fleetVehicles">;
  entry?: FleetFuelRow;
  timeZone?: string;
  onClose: () => void;
  onSaved?: (message: string) => void;
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
    entry ? dateFieldFromTimestamp(entry.filledAt, timeZone) : dateFieldFromTimestamp(now, timeZone),
  );
  const [odometer, setOdometer] = useState(entry ? kmInputFromMeters(entry.odometerMeters) : "");
  const [litres, setLitres] = useState(entry ? String(entry.litres) : "");
  const [amount, setAmount] = useState(entry ? String(entry.amount) : "");
  const [notes, setNotes] = useState(entry?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedVehicle = vehicles?.find((vehicle) => vehicle._id === vehicleId);
  // Leaving the date at today means "now": the server may default the reading.
  const isNow = !editing && dateValue === dateFieldFromTimestamp(now, timeZone);
  // Fuel always needs an odometer; only a fill-up made now can borrow the
  // tracker reading, so one is required when there is no reading to borrow.
  const odometerRequired = !editing && (!isNow || selectedVehicle?.odometerKm == null);

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
    if (odometerRequired && odometerMeters === null) {
      setError(isNow ? "Enter the odometer for this fill-up." : "Odometer is required for a past date.");
      return;
    }
    if (!editing && !upload.photo) { setError("Add a photo of the fuel gauge or receipt."); return; }
    setSaving(true);
    setError(null);
    try {
      const filledAt = entry
        ? timestampForEditedDateField(dateValue, entry.filledAt, timeZone)
        : isNow
          ? null
          : timestampForDateField(dateValue, now, timeZone);
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
      onSaved?.(editing ? "Fuel entry updated." : "Fuel entry saved.");
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
                    ? `Total distance the car has driven. Leave blank to use the latest tracker reading (${formatKm(selectedVehicle.odometerKm)}).`
                    : "This vehicle has no tracker reading. Enter the odometer."
                  : "Total distance the car has driven. Required for a past date."
            }
          >
            <Input
              id="fleet-fuel-odometer"
              className={dialogControlClass}
              inputMode="decimal"
              value={odometer}
              onChange={(event) => setOdometer(event.target.value)}
              placeholder={odometerRequired ? "Odometer at fill-up" : "Latest reading"}
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
  timeZone,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  companyId: Id<"companies">;
  now: number;
  preselectedVehicleId?: Id<"fleetVehicles">;
  entry?: FleetServiceRow;
  timeZone?: string;
  onClose: () => void;
  onSaved?: (message: string) => void;
}) {
  const createServiceEntry = useMutation(api.fleet.createServiceEntry);
  const updateServiceEntry = useMutation(api.fleet.updateServiceEntry);
  const vehiclesResult = useQuery(api.fleet.listVehicles, { companyId, now });
  const vehicles = vehiclesResult?.vehicles;
  const editing = mode === "edit" && Boolean(entry);
  const upload = useFleetPhotoUpload(companyId);

  const [vehicleId, setVehicleId] = useState<string>(entry?.vehicleId ?? preselectedVehicleId ?? "");
  const [dateValue, setDateValue] = useState(
    entry ? dateFieldFromTimestamp(entry.servicedAt, timeZone) : dateFieldFromTimestamp(now, timeZone),
  );
  const [odometer, setOdometer] = useState(entry ? kmInputFromMeters(entry.odometerMeters) : "");
  const [description, setDescription] = useState(entry?.description ?? "");
  const [cost, setCost] = useState(entry?.cost != null ? String(entry.cost) : "");
  const [notes, setNotes] = useState(entry?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedVehicle = vehicles?.find((vehicle) => vehicle._id === vehicleId);
  // Leaving the date at today means "now": the server may default the reading.
  const isNow = !editing && dateValue === dateFieldFromTimestamp(now, timeZone);

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
        ? timestampForEditedDateField(dateValue, entry.servicedAt, timeZone)
        : isNow
          ? null
          : timestampForDateField(dateValue, now, timeZone);
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
      onSaved?.(editing ? "Service entry updated." : "Service entry saved.");
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
                    ? `Total distance the car has driven. Leave blank to use the latest reading (${formatKm(selectedVehicle.odometerKm)}).`
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
  const pendingLabel =
    confirmLabel === "Archive"
      ? "Archiving…"
      : confirmLabel === "Delete"
        ? "Deleting…"
        : `${confirmLabel}…`;

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
              {pending ? pendingLabel : confirmLabel}
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
  editLabel = "Edit",
  deleteLabel = "Delete",
  deleteIcon: DeleteIcon = Trash2,
}: {
  label: string;
  onEdit: () => void;
  onDelete: () => void;
  editLabel?: string;
  deleteLabel?: string;
  deleteIcon?: React.ComponentType<{ className?: string }>;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="task-icon-btn h-11 w-11 sm:h-8 sm:w-8" aria-label={`Actions for ${label}`}>
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" className="task-menu">
          <DropdownMenu.Item className="task-menu-item" onSelect={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
            {editLabel}
          </DropdownMenu.Item>
          <DropdownMenu.Item className="task-menu-item text-[var(--danger)]" onSelect={onDelete}>
            <DeleteIcon className="h-3.5 w-3.5" />
            {deleteLabel}
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

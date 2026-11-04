import type { Id } from "../../../convex/_generated/dataModel";

export type BadgeTone = "neutral" | "blue" | "green" | "red" | "yellow";

export type ServiceStatusValue =
  | "overdue"
  | "due_soon"
  | "ok"
  | "unknown"
  | "not_configured";

export type FleetServiceStatus = {
  status: ServiceStatusValue;
  serviceIntervalKm: number | null;
  serviceIntervalDays: number | null;
  lastServicedAt: number | null;
  lastServiceOdometerMeters: number | null;
  nextDueOdometerMeters: number | null;
  nextDueAt: number | null;
  kmRemaining: number | null;
  daysRemaining: number | null;
};

export type FleetVehicleRef = {
  _id: Id<"fleetVehicles">;
  registrationNumber: string;
  displayName: string | null;
  name: string;
};

export type FleetDriverRef = { _id: Id<"fleetDrivers">; name: string };

export type FleetVehicleRow = {
  _id: Id<"fleetVehicles">;
  registrationNumber: string;
  displayName: string | null;
  name: string;
  odometerMeters: number | null;
  odometerKm: number | null;
  lat: number | null;
  lng: number | null;
  address: string | null;
  speed: number | null;
  ignitionOn: boolean | null;
  recordedAt: number | null;
  lastSeenAt: number | null;
  missingFromTrackerAt: number | null;
  status: "on_trip" | "missing" | "unknown" | "moving" | "parked";
  openTrip: {
    _id: Id<"fleetTrips">;
    driverId: Id<"fleetDrivers">;
    driverName: string;
    destination: string;
    departedAt: number;
  } | null;
  serviceStatus: FleetServiceStatus;
};

export type FleetDriverRow = {
  _id: Id<"fleetDrivers">;
  name: string;
  phone: string | null;
  active: boolean;
  createdAt: number;
  updatedAt: number;
};

export type FleetTripRow = {
  _id: Id<"fleetTrips">;
  vehicleId: Id<"fleetVehicles">;
  driverId: Id<"fleetDrivers">;
  destination: string;
  notes: string | null;
  status: "open" | "returned";
  departedAt: number;
  returnedAt: number | null;
  startOdometerMeters: number | null;
  endOdometerMeters: number | null;
  distanceMeters: number | null;
  distanceKm: number | null;
  vehicle: FleetVehicleRef | null;
  driver: FleetDriverRef | null;
  createdAt: number;
  updatedAt: number;
};

export type FleetPhoto = {
  fileName: string | null;
  contentType: string | null;
  size: number | null;
  url: string | null;
};

export type FleetFuelRow = {
  _id: Id<"fleetFuelEntries">;
  vehicleId: Id<"fleetVehicles">;
  vehicle: FleetVehicleRef | null;
  driverId: Id<"fleetDrivers"> | null;
  driver: FleetDriverRef | null;
  filledAt: number;
  litres: number;
  amount: number;
  odometerMeters: number | null;
  odometerKm: number | null;
  notes: string | null;
  kmPerL: number | null;
  medianKmPerL: number | null;
  anomaly: boolean;
  photo: {
    fileName: string;
    contentType: string;
    size: number;
    url: string | null;
  };
  createdAt: number;
  updatedAt: number;
};

export type FleetServiceRow = {
  _id: Id<"fleetServiceEntries">;
  vehicleId: Id<"fleetVehicles">;
  vehicle: FleetVehicleRef | null;
  servicedAt: number;
  odometerMeters: number | null;
  odometerKm: number | null;
  description: string;
  cost: number | null;
  notes: string | null;
  photo: FleetPhoto | null;
  createdAt: number;
  updatedAt: number;
};

export type FleetAlertRow = {
  key: string;
  kind:
    | "service_overdue"
    | "service_due_soon"
    | "fuel_anomaly"
    | "fuel_spend_spike"
    | "tracker_sync_failing"
    | "vehicle_missing";
  severity: "critical" | "warning";
  title: string;
  message: string;
  vehicleId: Id<"fleetVehicles"> | null;
  entryId: Id<"fleetFuelEntries"> | null;
  at: number | null;
};

export type FleetConnection = {
  connected: boolean;
  keyHint: string | null;
  connectedAt: number | null;
  lastSyncAt: number | null;
  lastSyncError: string | null;
  vehicleCount: number;
  isTruncated: boolean;
};

export type FleetSpendSummary = {
  currentMonthSpend: number;
  previousMonthSpend: number;
  previousThreeMonthAverage: number;
  monthOverMonthChange: number | null;
  spendSpike: boolean;
  hasThreeMonthsHistory: boolean;
};

export type FleetFuelInsights = {
  currentMonthStart: number;
  previousMonthStart: number;
  threeMonthsAgoStart: number;
  fleet: FleetSpendSummary;
  byVehicle: (FleetSpendSummary & {
    vehicleId: Id<"fleetVehicles">;
    registrationNumber: string;
    displayName: string | null;
    name: string;
  })[];
  anomalies: {
    entryId: Id<"fleetFuelEntries">;
    vehicleId: Id<"fleetVehicles">;
    vehicleName: string;
    registrationNumber: string;
    filledAt: number;
    kmPerL: number;
    medianKmPerL: number;
    litres: number;
    amount: number;
  }[];
  isTruncated: boolean;
};

export type FleetMaintenanceRow = {
  vehicleId: Id<"fleetVehicles">;
  registrationNumber: string;
  displayName: string | null;
  name: string;
  odometerMeters: number | null;
  odometerKm: number | null;
  serviceStatus: FleetServiceStatus;
};

export type FleetVehicleDetail = {
  vehicle: FleetVehicleRow;
  recentTrips: {
    _id: Id<"fleetTrips">;
    destination: string;
    notes: string | null;
    status: "open" | "returned";
    departedAt: number;
    returnedAt: number | null;
    startOdometerMeters: number | null;
    endOdometerMeters: number | null;
    distanceMeters: number | null;
    distanceKm: number | null;
    driverId: Id<"fleetDrivers">;
    driverName: string | null;
  }[];
  recentFuel: {
    _id: Id<"fleetFuelEntries">;
    filledAt: number;
    litres: number;
    amount: number;
    odometerMeters: number | null;
    odometerKm: number | null;
    notes: string | null;
    driverId: Id<"fleetDrivers"> | null;
    driverName: string | null;
    kmPerL: number | null;
    medianKmPerL: number | null;
    anomaly: boolean;
    photo: {
      fileName: string;
      contentType: string;
      size: number;
      url: string | null;
    };
  }[];
  recentServices: {
    _id: Id<"fleetServiceEntries">;
    servicedAt: number;
    odometerMeters: number | null;
    odometerKm: number | null;
    description: string;
    cost: number | null;
    notes: string | null;
    photo: FleetPhoto | null;
  }[];
};

const integerFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const amountFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const dateFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

export function formatKm(km: number | null | undefined) {
  if (km == null || !Number.isFinite(km)) return "—";
  return `${amountFormat.format(km)} km`;
}

export function formatLitres(litres: number | null | undefined) {
  if (litres == null || !Number.isFinite(litres)) return "—";
  return `${amountFormat.format(litres)} L`;
}

export function formatAmount(amount: number | null | undefined) {
  if (amount == null || !Number.isFinite(amount)) return "—";
  return `PKR ${amountFormat.format(amount)}`;
}

export function formatKmPerL(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(1)} km/L`;
}

export function formatDateTime(ms: number | null | undefined) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  return dateTimeFormat.format(new Date(ms));
}

export function formatDateOnly(ms: number | null | undefined) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  return dateFormat.format(new Date(ms));
}

/** "just now", "5 min ago", "3 hr ago", "2 days ago", then a plain date. */
export function relativeTime(ms: number | null | undefined, now: number) {
  if (ms == null || !Number.isFinite(ms)) return "never";
  const diff = Math.max(0, now - ms);
  if (diff < 60_000) return "just now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return formatDateOnly(ms);
}

export function serviceStatusLabel(status: ServiceStatusValue) {
  switch (status) {
    case "overdue":
      return "Overdue";
    case "due_soon":
      return "Due soon";
    case "ok":
      return "Up to date";
    case "unknown":
      return "Log last service";
    case "not_configured":
      return "No interval";
  }
}

export function serviceStatusTone(status: ServiceStatusValue): BadgeTone {
  switch (status) {
    case "overdue":
      return "red";
    case "due_soon":
      return "yellow";
    case "ok":
      return "green";
    case "unknown":
      return "yellow";
    case "not_configured":
      return "neutral";
  }
}

/** "1,200 km left · 12 days left" or "230 km overdue · 2 days overdue". */
export function serviceRemainingLabel(status: FleetServiceStatus) {
  const parts: string[] = [];
  if (status.kmRemaining !== null && Number.isFinite(status.kmRemaining)) {
    const km = Math.round(Math.abs(status.kmRemaining));
    parts.push(
      status.kmRemaining <= 0
        ? `${integerFormat.format(km)} km overdue`
        : `${integerFormat.format(km)} km left`,
    );
  }
  if (status.daysRemaining !== null && Number.isFinite(status.daysRemaining)) {
    const days = Math.ceil(Math.abs(status.daysRemaining));
    parts.push(
      status.daysRemaining <= 0
        ? `${days} day${days === 1 ? "" : "s"} overdue`
        : `${days} day${days === 1 ? "" : "s"} left`,
    );
  }
  return parts.length ? parts.join(" · ") : "—";
}

export function vehicleStatusChip(vehicle: Pick<FleetVehicleRow, "status">): {
  label: string;
  tone: BadgeTone;
} {
  switch (vehicle.status) {
    case "on_trip":
      return { label: "On trip", tone: "blue" };
    case "moving":
      return { label: "Moving", tone: "green" };
    case "parked":
      return { label: "Parked", tone: "neutral" };
    case "missing":
      return { label: "Missing", tone: "red" };
    case "unknown":
      return { label: "No signal", tone: "neutral" };
  }
}

export function monthOverMonthLabel(change: number | null) {
  if (change === null || !Number.isFinite(change)) return "No spend last month";
  const percent = Math.round(change * 100);
  if (percent === 0) return "Same as last month";
  return `${percent > 0 ? "+" : ""}${percent}% vs last month`;
}

export function dateFieldFromTimestamp(ms: number) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Local noon on the chosen calendar day; today keeps its real timestamp. */
export function timestampForDateField(value: string, now: number) {
  if (dateFieldFromTimestamp(now) === value) return now;
  return timestampForEditedDateField(value, now);
}

/** Editing preserves the original instant when the day did not change. */
export function timestampForEditedDateField(value: string, original: number) {
  if (dateFieldFromTimestamp(original) === value) return original;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return original;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? original : date.getTime();
}

export function kmInputFromMeters(meters: number | null | undefined) {
  if (meters == null || !Number.isFinite(meters)) return "";
  return String(meters / 1000);
}

export function metersFromKmInput(value: string) {
  const km = Number(value);
  return value.trim() !== "" && Number.isFinite(km) && km >= 0 ? km * 1000 : null;
}

export function formatFileSize(bytes: number | null | undefined) {
  if (bytes == null || !Number.isFinite(bytes)) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

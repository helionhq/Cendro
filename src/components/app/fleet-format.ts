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
  ignitionChangedAt: number | null;
  reason: string | null;
  directionDegree: number | null;
  recordedAt: number | null;
  lastSeenAt: number | null;
  missingFromTrackerAt: number | null;
  requiresTripLogging: boolean;
  offline: boolean;
  offlineSince: number | null;
  status: "on_trip" | "missing" | "unknown" | "moving" | "parked";
  openTrip: {
    _id: Id<"fleetTrips">;
    driverId: Id<"fleetDrivers">;
    driverName: string;
    destination: string;
    placeId: Id<"fleetPlaces"> | null;
    departedAt: number;
    arrivedAt: number | null;
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
  placeId: Id<"fleetPlaces"> | null;
  basePlaceId: Id<"fleetPlaces"> | null;
  arrivedAt: number | null;
  autoReturned: boolean;
  startOdometerMeters: number | null;
  endOdometerMeters: number | null;
  distanceMeters: number | null;
  distanceKm: number | null;
  actualDistanceMeters: number | null;
  actualDistanceKm: number | null;
  maxDeviationMeters: number | null;
  maxDeviationKm: number | null;
  offRoute: boolean;
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
  fleetKmPerL: number | null;
  currentMonthKm: number;
  currentMonthLitres: number;
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
    placeId: Id<"fleetPlaces"> | null;
    arrivedAt: number | null;
    autoReturned: boolean;
    startOdometerMeters: number | null;
    endOdometerMeters: number | null;
    distanceMeters: number | null;
    distanceKm: number | null;
    actualDistanceMeters: number | null;
    actualDistanceKm: number | null;
    maxDeviationMeters: number | null;
    maxDeviationKm: number | null;
    offRoute: boolean;
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

// ---------------------------------------------------------------------------
// Fleet v2 shapes
// ---------------------------------------------------------------------------

export type FleetBoardStatus = "on_trip" | "moving" | "parked" | "offline";

export type FleetBoardVehicle = {
  _id: Id<"fleetVehicles">;
  registrationNumber: string;
  displayName: string | null;
  name: string;
  status: FleetBoardStatus;
  place: { _id: Id<"fleetPlaces">; name: string; kind: "base" | "destination" } | null;
  address: string | null;
  driverName: string | null;
  destination: string | null;
  placeId: Id<"fleetPlaces"> | null;
  departedAt: number | null;
  arrivedAt: number | null;
  parkedSince: number | null;
  lastUpdate: number | null;
  offlineSince: number | null;
  requiresTripLogging: boolean;
  odometerKm: number | null;
};

export type FleetUpcomingServiceRow = {
  vehicleId: Id<"fleetVehicles">;
  name: string;
  registrationNumber: string;
  status: "overdue" | "due_soon";
  nextDueAt: number | null;
  nextDueOdometerMeters: number | null;
  kmRemaining: number | null;
  daysRemaining: number | null;
};

export type FleetDashboardKpis = {
  onTrip: number;
  moving: number;
  parked: number;
  offline: number;
  kmToday: number;
  tripsToday: number;
  openAlerts: number;
};

export type FleetAlertKind =
  | "unlogged_movement"
  | "off_route"
  | "trip_overdue"
  | "service_overdue"
  | "service_due_soon"
  | "fuel_anomaly"
  | "fuel_spend_spike"
  | "tracker_sync_failing"
  | "vehicle_missing";

export type FleetAlertFeedRow = {
  source: "event" | "derived";
  _id: Id<"fleetAlerts"> | null;
  key: string;
  kind: FleetAlertKind;
  severity: "critical" | "warning";
  title: string;
  message: string;
  vehicleId: Id<"fleetVehicles"> | null;
  vehicleName: string | null;
  tripId: Id<"fleetTrips"> | null;
  occurredAt: number | null;
  endedAt: number | null;
  status: "open" | "resolved";
  lat: number | null;
  lng: number | null;
  address: string | null;
  distanceMeters: number | null;
  distanceKm: number | null;
  maxDeviationMeters: number | null;
  maxDeviationKm: number | null;
  fromAddress: string | null;
  toAddress: string | null;
  resolutionNote: string | null;
  resolvedAt: number | null;
  resolvedByName: string | null;
};

export type FleetAlertFeed = {
  alerts: FleetAlertFeedRow[];
  count: number;
  openCount: number;
  isTruncated: boolean;
};

export type FleetPlace = {
  _id: Id<"fleetPlaces">;
  name: string;
  kind: "base" | "destination";
  lat: number;
  lng: number;
  radiusMeters: number;
  address: string | null;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
};

export type FleetPlaceSuggestion = {
  lat: number;
  lng: number;
  address: string | null;
  visitCount: number;
  vehicleCount: number;
  firstVisitAt: number;
  lastVisitAt: number;
};

export type FleetKmDay = {
  dayStart: number;
  dayEnd: number;
  km: number;
  trips: number;
};

export type FleetDestinationCount = {
  destination: string;
  placeId: Id<"fleetPlaces"> | null;
  count: number;
  km: number;
};

export type FleetRecentActivity = {
  type: "trip_started" | "trip_returned" | "fuel" | "service" | "alert";
  at: number;
  title: string;
  vehicleId: Id<"fleetVehicles">;
  vehicleName: string;
  detail: string | null;
};

export type FleetVehicleTimelineTrackerTrip = {
  _id: Id<"fleetTrackerTrips">;
  startedAt: number;
  endedAt: number;
  startLandmark: string | null;
  endLandmark: string | null;
  startLat: number | null;
  startLng: number | null;
  endLat: number | null;
  endLng: number | null;
  distanceMeters: number;
  distanceKm: number;
  travelSeconds: number;
  maxSpeedKmh: number;
  avgSpeedKmh: number | null;
  matchedTripId: Id<"fleetTrips"> | null;
  matchedTrip: {
    destination: string;
    status: "open" | "returned";
    departedAt: number;
    returnedAt: number | null;
  } | null;
};

export type FleetVehicleTimelineLoggedTrip = {
  _id: Id<"fleetTrips">;
  destination: string;
  placeId: Id<"fleetPlaces"> | null;
  status: "open" | "returned";
  departedAt: number;
  returnedAt: number | null;
  arrivedAt: number | null;
  autoReturned: boolean;
  actualDistanceMeters: number | null;
  actualDistanceKm: number | null;
  offRoute: boolean;
  startOdometerMeters: number | null;
  endOdometerMeters: number | null;
  driverId: Id<"fleetDrivers">;
};

export type FleetVehicleTimelineAlert = {
  _id: Id<"fleetAlerts">;
  kind: "unlogged_movement" | "off_route" | "trip_overdue";
  status: "open" | "resolved";
  occurredAt: number;
  endedAt: number | null;
  summary: string;
  address: string | null;
  distanceMeters: number | null;
  maxDeviationMeters: number | null;
  tripId: Id<"fleetTrips"> | null;
  resolutionNote: string | null;
  resolvedAt: number | null;
};

export type FleetVehicleTimelineDay = {
  dayStart: number;
  dayEnd: number;
  trackerTrips: FleetVehicleTimelineTrackerTrip[];
  loggedTrips: FleetVehicleTimelineLoggedTrip[];
  alerts: FleetVehicleTimelineAlert[];
};

export type FleetVehicleTimeline = {
  vehicle: {
    _id: Id<"fleetVehicles">;
    registrationNumber: string;
    displayName: string | null;
    name: string;
    requiresTripLogging: boolean;
  };
  days: FleetVehicleTimelineDay[];
  isTruncated: boolean;
};

const integerFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const amountFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const dateFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();
function dateTimeFormatFor(timeZone: string | undefined) {
  const key = timeZone ?? "local";
  let format = dateTimeFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(undefined, {
      ...(timeZone ? { timeZone } : {}),
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    dateTimeFormats.set(key, format);
  }
  return format;
}

const shortDateFormats = new Map<string, Intl.DateTimeFormat>();
function shortDateFormatFor(timeZone: string | undefined) {
  const key = timeZone ?? "local";
  let format = shortDateFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      ...(timeZone ? { timeZone } : {}),
      month: "short",
      day: "numeric",
    });
    shortDateFormats.set(key, format);
  }
  return format;
}

const timeFormats = new Map<string, Intl.DateTimeFormat>();
function timeFormat(timeZone: string | undefined) {
  const key = timeZone ?? "local";
  let format = timeFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      ...(timeZone ? { timeZone } : {}),
      hour: "numeric",
      minute: "2-digit",
    });
    timeFormats.set(key, format);
  }
  return format;
}

const weekdayFormats = new Map<string, Intl.DateTimeFormat>();
function weekdayFormat(timeZone: string | undefined) {
  const key = timeZone ?? "local";
  let format = weekdayFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      ...(timeZone ? { timeZone } : {}),
      weekday: "short",
    });
    weekdayFormats.set(key, format);
  }
  return format;
}

const longDateFormats = new Map<string, Intl.DateTimeFormat>();
function longDateFormat(timeZone: string | undefined) {
  const key = timeZone ?? "local";
  let format = longDateFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      ...(timeZone ? { timeZone } : {}),
      weekday: "long",
      month: "short",
      day: "numeric",
    });
    longDateFormats.set(key, format);
  }
  return format;
}

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

export function formatInteger(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return integerFormat.format(value);
}

export function formatDateTime(ms: number | null | undefined, timeZone?: string) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  return dateTimeFormatFor(timeZone).format(new Date(ms));
}

export function formatDateOnly(ms: number | null | undefined) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  return dateFormat.format(new Date(ms));
}

export function formatShortDate(
  ms: number | null | undefined,
  now: number,
  timeZone?: string,
) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const sameYear =
    zonedDayKey(ms, timeZone).slice(0, 4) === zonedDayKey(now, timeZone).slice(0, 4) &&
    Number.isFinite(now);
  return sameYear
    ? shortDateFormatFor(timeZone).format(new Date(ms))
    : formatDateOnly(ms);
}

/** "8:05 AM" in the company time zone. */
export function formatTime(ms: number | null | undefined, timeZone?: string) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  return timeFormat(timeZone).format(new Date(ms));
}

/** "8:05–9:48 AM" (the meridiem is repeated only when it changes). */
export function formatTimeRange(
  start: number | null | undefined,
  end: number | null | undefined,
  timeZone?: string,
) {
  if (start == null || !Number.isFinite(start)) return "—";
  if (end == null || !Number.isFinite(end)) return formatTime(start, timeZone);
  const startLabel = formatTime(start, timeZone);
  const endLabel = formatTime(end, timeZone);
  const startMeridiem = startLabel.endsWith("AM") ? "AM" : startLabel.endsWith("PM") ? "PM" : "";
  const endMeridiem = endLabel.endsWith("AM") ? "AM" : endLabel.endsWith("PM") ? "PM" : "";
  if (startMeridiem && startMeridiem === endMeridiem) {
    return `${startLabel.slice(0, -3).trimEnd()}–${endLabel}`;
  }
  return `${startLabel}–${endLabel}`;
}

export function weekdayShort(ms: number, timeZone?: string) {
  return weekdayFormat(timeZone).format(new Date(ms));
}

export function formatLongDay(ms: number, timeZone?: string) {
  return longDateFormat(timeZone).format(new Date(ms));
}

function zonedDayKey(ms: number, timeZone?: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    ...(timeZone ? { timeZone } : {}),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const year = parts.find((part) => part.type === "year")?.value ?? "";
  const month = parts.find((part) => part.type === "month")?.value ?? "";
  const day = parts.find((part) => part.type === "day")?.value ?? "";
  return `${year}-${month}-${day}`;
}

/** Today / Yesterday / "Nov 4" / "Nov 4, 2025" in the company time zone. */
export function formatDayLabel(ms: number, now: number, timeZone?: string) {
  if (!Number.isFinite(ms)) return "—";
  const key = zonedDayKey(ms, timeZone);
  if (key === zonedDayKey(now, timeZone)) return "Today";
  if (key === zonedDayKey(now - 86_400_000, timeZone)) return "Yesterday";
  return formatShortDate(ms, now, timeZone);
}

export function dayGroupKey(ms: number, timeZone?: string) {
  return zonedDayKey(ms, timeZone);
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
  return formatShortDate(ms, now);
}

/** "45 min", "1 hr 20 min", "13 hr". */
export function formatDuration(ms: number | null | undefined) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 60) return `${Math.max(0, totalMinutes)} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours} hr` : `${hours} hr ${minutes} min`;
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
export function formatRemaining(
  kmRemaining: number | null,
  daysRemaining: number | null,
) {
  const parts: string[] = [];
  if (kmRemaining !== null && Number.isFinite(kmRemaining)) {
    const km = Math.round(Math.abs(kmRemaining));
    parts.push(
      kmRemaining <= 0
        ? `${integerFormat.format(km)} km overdue`
        : `${integerFormat.format(km)} km left`,
    );
  }
  if (daysRemaining !== null && Number.isFinite(daysRemaining)) {
    const days = Math.ceil(Math.abs(daysRemaining));
    parts.push(
      daysRemaining <= 0
        ? `${days} day${days === 1 ? "" : "s"} overdue`
        : `${days} day${days === 1 ? "" : "s"} left`,
    );
  }
  return parts.length ? parts.join(" · ") : "—";
}

export function serviceRemainingLabel(status: FleetServiceStatus) {
  return formatRemaining(status.kmRemaining, status.daysRemaining);
}

export function monthOverMonthValue(change: number | null) {
  if (change === null || !Number.isFinite(change)) return "—";
  const percent = Math.round(change * 100);
  return `${percent > 0 ? "+" : ""}${percent}%`;
}

export function monthOverMonthLabel(change: number | null) {
  if (change === null || !Number.isFinite(change)) return "No spend last month";
  const percent = Math.round(change * 100);
  if (percent === 0) return "Same as last month";
  return `${percent > 0 ? "+" : ""}${percent}% vs last month`;
}

// ---------------------------------------------------------------------------
// Status vocabulary (UX spec §4.2)
// ---------------------------------------------------------------------------

type VehicleStatusInput = {
  status: FleetBoardStatus | "missing" | "unknown";
  place?: { name: string } | null;
  arrivedAt?: number | null;
  requiresTripLogging?: boolean;
  lastUpdate?: number | null;
};

export function vehicleStatusChip(vehicle: VehicleStatusInput): {
  label: string;
  tone: BadgeTone;
} {
  switch (vehicle.status) {
    case "on_trip":
      return vehicle.arrivedAt != null
        ? { label: "At destination", tone: "blue" }
        : { label: "On trip", tone: "blue" };
    case "moving":
      return vehicle.requiresTripLogging === false
        ? { label: "Moving", tone: "neutral" }
        : { label: "Moving without trip", tone: "yellow" };
    case "parked":
      return vehicle.place
        ? { label: `At ${vehicle.place.name}`, tone: "green" }
        : { label: "Parked", tone: "neutral" };
    case "missing":
    case "offline":
      return { label: "Offline", tone: "red" };
    case "unknown":
      return vehicle.lastUpdate == null
        ? { label: "Not seen yet", tone: "neutral" }
        : { label: "Offline", tone: "red" };
  }
}

export function openTripStatusChip(trip: {
  status: "open" | "returned";
  arrivedAt?: number | null;
}): { label: string; tone: BadgeTone } {
  if (trip.status === "open") {
    return trip.arrivedAt != null
      ? { label: "At destination", tone: "blue" }
      : { label: "On trip", tone: "blue" };
  }
  return { label: "Returned", tone: "neutral" };
}

export function tripStatusChip(trip: {
  status: "open" | "returned";
  autoReturned?: boolean;
}): { label: string; tone: BadgeTone } {
  if (trip.status === "open") return { label: "Out now", tone: "blue" };
  // Auto-closed trips keep the "Auto" badge beside the status in list views;
  // the trip sheet spells out "Closed automatically".
  return { label: "Returned", tone: "neutral" };
}

export function alertSeverityLabel(severity: "critical" | "warning") {
  return severity === "critical" ? "Needs review" : "Heads up";
}

/** Hours out when an overdue alert was raised (occurredAt is departure + 12 h). */
export function tripOverdueHours(
  alert: Pick<FleetAlertFeedRow, "occurredAt">,
  reference: number,
) {
  return (
    12 + Math.max(0, Math.floor((reference - (alert.occurredAt ?? reference)) / 3_600_000))
  );
}

/** Plain-language alarm titles from the UX spec, built from the stored facts. */
export function alertDisplayTitle(
  alert: Pick<
    FleetAlertFeedRow,
    "kind" | "vehicleName" | "occurredAt" | "title" | "status" | "resolvedAt"
  >,
  now: number,
) {
  const vehicle = alert.vehicleName ?? "Vehicle";
  switch (alert.kind) {
    case "unlogged_movement":
      return `${vehicle} moved without a trip`;
    case "off_route":
      return `${vehicle} went off route`;
    case "trip_overdue": {
      // Freeze reviewed rows at the moment they were reviewed; both the title
      // and the meta line derive from this same reference.
      const reference =
        alert.status === "resolved" && alert.resolvedAt != null ? alert.resolvedAt : now;
      const hoursOut = tripOverdueHours(alert, reference);
      return `${vehicle} has been out for ${hoursOut} hour${hoursOut === 1 ? "" : "s"}`;
    }
    case "service_overdue":
      return `Service overdue: ${vehicle}`;
    case "service_due_soon":
      return `Service due soon: ${vehicle}`;
    case "fuel_anomaly":
      return `Fuel use looks low: ${vehicle}`;
    case "vehicle_missing":
      return `${vehicle} is offline`;
    default:
      return alert.title;
  }
}

export function alertDisplayBody(alert: FleetAlertFeedRow) {
  switch (alert.kind) {
    case "unlogged_movement":
      return "No trip was logged for this movement.";
    case "off_route":
      return alert.address
        ? `Farthest point: ${alert.address}.`
        : "The vehicle left the normal route.";
    case "trip_overdue":
      return "The trip has not been marked returned.";
    case "vehicle_missing":
      return "It has not sent a position recently.";
    default:
      return alert.message;
  }
}

// ---------------------------------------------------------------------------
// Maps coordinates: client-side parsing for the place dialog
// ---------------------------------------------------------------------------

export type Coordinates = { lat: number; lng: number };

function validCoordinates(lat: number, lng: number): Coordinates | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

/**
 * Accepts the three share forms the product supports:
 * `@31.58,74.32`, `?q=31.58,74.32` (also query/destination/ll), and bare
 * `31.58, 74.32`. Anything else — including short maps.app.goo.gl links,
 * which carry no coordinates — returns null so the dialog can explain it.
 */
export function parseCoordinates(input: string): Coordinates | null {
  const text = input.trim();
  if (!text) return null;

  const bare = /^(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/.exec(text);
  if (bare) return validCoordinates(Number(bare[1]), Number(bare[2]));

  const at = /@(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/.exec(text);
  if (at) return validCoordinates(Number(at[1]), Number(at[2]));

  const query =
    /[?&](?:q|query|ll|destination|daddr)=(-?\d{1,3}(?:\.\d+)?)(?:%2C|,)(-?\d{1,3}(?:\.\d+)?)/i.exec(
      text,
    );
  if (query) return validCoordinates(Number(query[1]), Number(query[2]));

  return null;
}

export function googleMapsUrl(lat: number, lng: number) {
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

/** Short Google Maps links carry no coordinates; explain how to get the full link. */
export function isShortGoogleMapsLink(input: string) {
  return /^(?:https?:\/\/)?(?:maps\.app\.goo\.gl|goo\.gl\/maps)(?:[/?#]|$)/i.test(
    input.trim(),
  );
}

// ---------------------------------------------------------------------------
// Date-field helpers
// ---------------------------------------------------------------------------

const offsetFormats = new Map<string, Intl.DateTimeFormat>();
function timeZoneOffsetMs(utcMs: number, timeZone: string) {
  let format = offsetFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    offsetFormats.set(timeZone, format);
  }
  const values: Record<string, string> = {};
  for (const part of format.formatToParts(new Date(utcMs))) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  const hour = values.hour === "24" ? 0 : Number(values.hour);
  const wallClock = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    hour,
    Number(values.minute),
    Number(values.second),
  );
  return wallClock - utcMs;
}

/** Noon on the chosen calendar day in the company time zone. */
function timestampForDayAtNoon(value: string, timeZone?: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  if (!timeZone) {
    const date = new Date(year, month, day, 12, 0, 0, 0);
    return Number.isNaN(date.getTime()) ? null : date.getTime();
  }
  const wallClockNoon = Date.UTC(year, month, day, 12, 0, 0, 0);
  let guess = wallClockNoon;
  // Two passes settle normal zones and DST transition days.
  for (let pass = 0; pass < 2; pass += 1) {
    const next = wallClockNoon - timeZoneOffsetMs(guess, timeZone);
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

export function dateFieldFromTimestamp(ms: number, timeZone?: string) {
  return zonedDayKey(ms, timeZone);
}

/** Noon on the chosen company-local day; today keeps its real timestamp. */
export function timestampForDateField(value: string, now: number, timeZone?: string) {
  if (dateFieldFromTimestamp(now, timeZone) === value) return now;
  return timestampForEditedDateField(value, now, timeZone);
}

/** Editing preserves the original instant when the day did not change. */
export function timestampForEditedDateField(
  value: string,
  original: number,
  timeZone?: string,
) {
  if (dateFieldFromTimestamp(original, timeZone) === value) return original;
  return timestampForDayAtNoon(value, timeZone) ?? original;
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

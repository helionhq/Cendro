import { v } from "convex/values";

/**
 * Minimal TrackWorld / portalxs SOAP client.
 *
 * The endpoint answers with a JSON object followed directly by an empty SOAP
 * envelope. Parsing therefore takes everything before the first `<?xml` and
 * runs JSON.parse on it.
 *
 * Odometer unit: the tracker reports METERS. Verified against live data on
 * 2026-11-04: vehicle APL-079 advanced 64,663 odometer units over ~47.5 hours
 * while GetTrips for the same window summed 63.6 km — roughly 1,000 units per
 * km. Divide by 1000 for kilometres.
 *
 * Times (verified live 2026-11-09):
 * - `/Date(ms)/` is a true UTC epoch. 1794108262000 = 03:24Z = 08:24 PKT,
 *   matching the RDTS local string "2026-11-08 08:23:01".
 * - `fdt`/`tdt` are declared as xsd:dateTime: the legacy
 *   "11/8/2026 8:00:00 AM" string is rejected with a SOAP fault, so an ISO
 *   `YYYY-MM-DDTHH:mm:ss` value is required.
 * - They are read as literal wall-clock values in the tracker server's
 *   Pakistan time (UTC+5, no DST). Passing `2026-11-08T03:00:00Z` queries
 *   03:00 PKT, not 08:00 PKT, so the offset suffix is ignored. Always send a
 *   PKT wall-clock string with no zone designator (see formatTrackerWindow).
 * - An empty window answers responseCode 402 with "No Trips found..." or
 *   "No History found..." and a null array. 402 is therefore NOT an auth
 *   failure for these reads; only other 402 messages are treated as rejected.
 * - An unknown registration or an invalid key answers 401 "Not Authenticated.
 *   Invalid secret key or vehicle not authorized..." for GetTrips. Ingestion
 *   records that vehicle as a failed fetch rather than an empty window.
 */
export const TRACKER_ENDPOINT = "https://tw.portalxs.com/twpxapis/TrackingServices.asmx";
const TRACKER_NAMESPACE = "http://tempuri.org/";
const GET_VDATA_ACTION = "TWPXCC_GetVData";
const GET_TRIPS_ACTION = "TWPXCC_GetTrips";
const GET_VEHICLE_HISTORY_ACTION = "TWPXCC_GetVehicleHistory";
const TRACKER_TIMEOUT_MS = 15_000;
/** The tracker service's own clock; company time zones are irrelevant here. */
const TRACKER_TIME_ZONE = "Asia/Karachi";

export const trackerVehicleValidator = v.object({
  registrationNumber: v.string(),
  odometerMeters: v.optional(v.number()),
  lat: v.optional(v.number()),
  lng: v.optional(v.number()),
  address: v.optional(v.string()),
  speed: v.optional(v.number()),
  ignitionOn: v.optional(v.boolean()),
  ignitionChangedAt: v.optional(v.number()),
  reason: v.optional(v.string()),
  directionDegree: v.optional(v.number()),
  recordedAt: v.optional(v.number()),
});

export type TrackerVehicle = {
  registrationNumber: string;
  odometerMeters?: number;
  lat?: number;
  lng?: number;
  address?: string;
  speed?: number;
  ignitionOn?: boolean;
  ignitionChangedAt?: number;
  reason?: string;
  directionDegree?: number;
  recordedAt?: number;
};

export const trackerTripValidator = v.object({
  registrationNumber: v.string(),
  startedAt: v.number(),
  endedAt: v.number(),
  startLat: v.optional(v.number()),
  startLng: v.optional(v.number()),
  startLandmark: v.optional(v.string()),
  endLat: v.optional(v.number()),
  endLng: v.optional(v.number()),
  endLandmark: v.optional(v.string()),
  distanceMeters: v.number(),
  travelSeconds: v.number(),
  maxSpeedKmh: v.number(),
  avgSpeedKmh: v.optional(v.number()),
});

export type TrackerTrip = {
  registrationNumber: string;
  startedAt: number;
  endedAt: number;
  startLat?: number;
  startLng?: number;
  startLandmark?: string;
  endLat?: number;
  endLng?: number;
  endLandmark?: string;
  distanceMeters: number;
  travelSeconds: number;
  maxSpeedKmh: number;
  avgSpeedKmh?: number;
};

export const trackerHistoryPointValidator = v.object({
  registrationNumber: v.optional(v.string()),
  at: v.number(),
  lat: v.number(),
  lng: v.number(),
  speed: v.number(),
  reason: v.optional(v.string()),
  odometerMeters: v.optional(v.number()),
  ignitionOn: v.optional(v.boolean()),
});

export type TrackerHistoryPoint = {
  registrationNumber?: string;
  at: number;
  lat: number;
  lng: number;
  speed: number;
  reason?: string;
  odometerMeters?: number;
  ignitionOn?: boolean;
};

export const EMPTY_TRACKER_RESPONSE_MESSAGE =
  "The tracker returned no vehicles. Check the tracker key or try again.";

/** Carries a user-safe message only; the key and raw response never leave here. */
export class TrackerError extends Error {
  readonly safeMessage: string;

  constructor(safeMessage: string) {
    super(safeMessage);
    this.name = "TrackerError";
    this.safeMessage = safeMessage;
  }
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildTrackerRequest(action: string, fields: Record<string, string>) {
  const elements = Object.entries(fields)
    .filter(([name]) => name !== "secret_key")
    .map(([name, value]) => `<${name}>${escapeXml(value)}</${name}>`)
    .join("");
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
    "<soap:Body>" +
    `<${action} xmlns="${TRACKER_NAMESPACE}">` +
    `<secret_key>${escapeXml(fields.secret_key ?? "")}</secret_key>` +
    elements +
    `</${action}>` +
    "</soap:Body>" +
    "</soap:Envelope>"
  );
}

export function buildGetVDataRequest(secretKey: string) {
  return buildTrackerRequest(GET_VDATA_ACTION, { secret_key: secretKey });
}

function numberField(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Tracker dates look like `\/Date(1793785727000)\/` after JSON decoding. */
export function parseTrackerDate(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const match = /^\/Date\((-?\d+)\)\/$/.exec(value);
  return match ? Number(match[1]) : undefined;
}

/** Landmarks arrive prefixed with an internal marker such as "0 " or "1 ". */
export function cleanTrackerLandmark(value: unknown): string | undefined {
  const text = stringField(value);
  return text ? text.replace(/^\s*\d+\s+/, "").trim() || undefined : undefined;
}

function ignitionField(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseTrackerVehicle(raw: unknown): TrackerVehicle | null {
  if (!isRecord(raw)) return null;
  const registrationNumber =
    typeof raw.RegistrationNumber === "string" ? raw.RegistrationNumber.trim() : "";
  if (!registrationNumber) return null;

  const vehicle: TrackerVehicle = { registrationNumber };
  const odometerMeters = numberField(raw.Odometer);
  const lat = numberField(raw.Latitude);
  const lng = numberField(raw.Longitude);
  const speed = numberField(raw.Speed);
  const ignitionOn = ignitionField(raw.LastIgnitionStatus);
  const ignitionChangedAt = parseTrackerDate(raw.LastIgnitionStatusDateTime);
  const recordedAt = parseTrackerDate(raw.RecordDateTime);
  const address = stringField(raw.Address);
  const reason = stringField(raw.Reason);
  const directionDegree = numberField(raw.DirectionDegree);

  if (odometerMeters !== undefined) vehicle.odometerMeters = odometerMeters;
  if (lat !== undefined) vehicle.lat = lat;
  if (lng !== undefined) vehicle.lng = lng;
  if (speed !== undefined) vehicle.speed = speed;
  if (ignitionOn !== undefined) vehicle.ignitionOn = ignitionOn;
  if (ignitionChangedAt !== undefined) vehicle.ignitionChangedAt = ignitionChangedAt;
  if (recordedAt !== undefined) vehicle.recordedAt = recordedAt;
  if (address) vehicle.address = address;
  if (reason) vehicle.reason = reason;
  if (directionDegree !== undefined) vehicle.directionDegree = directionDegree;
  return vehicle;
}

type ParsedTrackerBody = {
  responseCode: number;
  responseMsg: string;
  data: Record<string, unknown>;
};

function parseTrackerBody(body: string): ParsedTrackerBody {
  // The JSON prefix ends at the empty SOAP envelope. If no envelope is present
  // the whole body is JSON, which keeps the parser tolerant of that shape.
  const xmlIndex = body.indexOf("<?xml");
  const jsonText = (xmlIndex >= 0 ? body.slice(0, xmlIndex) : body).trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new TrackerError("The tracker returned an unexpected response.");
  }
  if (!isRecord(parsed) || typeof parsed.responseCode !== "number") {
    throw new TrackerError("The tracker returned an unexpected response.");
  }
  return {
    responseCode: parsed.responseCode,
    responseMsg: typeof parsed.responseMsg === "string" ? parsed.responseMsg : "",
    data: parsed,
  };
}

function assertTrackerSuccess(
  parsed: ParsedTrackerBody,
  emptyResponsePattern: RegExp | null,
): "ok" | "empty" {
  const { responseCode, responseMsg } = parsed;
  if (responseCode === 200) return "ok";
  // A 402 is overloaded: GetTrips/GetVehicleHistory also use it for "no data
  // in this window". Only those operations pass a pattern; for GetVData a 402
  // is always the (existing) rejected-key answer.
  if (responseCode === 402 && emptyResponsePattern?.test(responseMsg)) return "empty";
  if (responseCode === 401 || responseCode === 402 || responseCode === 403) {
    throw new TrackerError("The tracker rejected this key. Check it and try again.");
  }
  throw new TrackerError("The tracker rejected the request. Try again in a moment.");
}

export type ParsedGetVData = {
  responseCode: number;
  responseMsg: string;
  vehicles: TrackerVehicle[];
};

export function parseGetVDataBody(body: string): ParsedGetVData {
  const parsed = parseTrackerBody(body);
  assertTrackerSuccess(parsed, null);

  const rawVehicles = parsed.data._vehicleData;
  if (rawVehicles !== null && rawVehicles !== undefined && !Array.isArray(rawVehicles)) {
    throw new TrackerError("The tracker returned an unexpected response.");
  }
  const vehicles = Array.isArray(rawVehicles)
    ? rawVehicles
        .map(parseTrackerVehicle)
        .filter((vehicle): vehicle is TrackerVehicle => vehicle !== null)
    : [];
  return { responseCode: parsed.responseCode, responseMsg: parsed.responseMsg, vehicles };
}

const AVERAGE_SPEED_PATTERN = /^\s*(-?\d+(?:\.\d+)?)/;

/** Parse the "21.0 km/hr" average-speed string; null in the source means none. */
function averageSpeedField(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = AVERAGE_SPEED_PATTERN.exec(value);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseTrackerTrip(raw: unknown): TrackerTrip | null {
  if (!isRecord(raw)) return null;
  const registrationNumber = stringField(raw.RegNo);
  const startedAt = parseTrackerDate(raw.IGON_RDT);
  const endedAt = parseTrackerDate(raw.IGOFF_RDT);
  if (!registrationNumber || startedAt === undefined || endedAt === undefined) return null;
  if (endedAt < startedAt) return null;

  const mileageKm = numberField(raw.Mileage);
  const travelSeconds = numberField(raw.TravelTimeS);
  const trip: TrackerTrip = {
    registrationNumber,
    startedAt,
    endedAt,
    distanceMeters: mileageKm !== undefined ? Math.max(0, Math.round(mileageKm * 1000)) : 0,
    travelSeconds: travelSeconds !== undefined ? Math.max(0, Math.round(travelSeconds)) : 0,
    maxSpeedKmh: Math.max(0, numberField(raw.MaxSpeed) ?? 0),
  };
  const startLat = numberField(raw.IGON_LAT);
  const startLng = numberField(raw.IGON_LON);
  const endLat = numberField(raw.IGOFF_LAT);
  const endLng = numberField(raw.IGOFF_LON);
  const startLandmark = cleanTrackerLandmark(raw.IGON_LandMark);
  const endLandmark = cleanTrackerLandmark(raw.IGOFF_LandMark);
  const avgSpeedKmh = averageSpeedField(raw.AvgSpeed);
  if (startLat !== undefined) trip.startLat = startLat;
  if (startLng !== undefined) trip.startLng = startLng;
  if (endLat !== undefined) trip.endLat = endLat;
  if (endLng !== undefined) trip.endLng = endLng;
  if (startLandmark) trip.startLandmark = startLandmark;
  if (endLandmark) trip.endLandmark = endLandmark;
  if (avgSpeedKmh !== undefined) trip.avgSpeedKmh = avgSpeedKmh;
  return trip;
}

export type ParsedGetTrips = {
  responseCode: number;
  responseMsg: string;
  trips: TrackerTrip[];
};

export function parseGetTripsBody(body: string): ParsedGetTrips {
  const parsed = parseTrackerBody(body);
  if (assertTrackerSuccess(parsed, /no\s+trips\s+found/i) === "empty") {
    return { responseCode: parsed.responseCode, responseMsg: parsed.responseMsg, trips: [] };
  }
  const rawTrips = parsed.data._trips;
  if (rawTrips !== null && rawTrips !== undefined && !Array.isArray(rawTrips)) {
    throw new TrackerError("The tracker returned an unexpected response.");
  }
  const trips = Array.isArray(rawTrips)
    ? rawTrips.map(parseTrackerTrip).filter((trip): trip is TrackerTrip => trip !== null)
    : [];
  return { responseCode: parsed.responseCode, responseMsg: parsed.responseMsg, trips };
}

function historyAttributeMap(raw: unknown) {
  const fields = new Map<string, string>();
  if (!Array.isArray(raw)) return fields;
  for (const attribute of raw) {
    if (!isRecord(attribute)) continue;
    const name = stringField(attribute.FieldName);
    if (!name) continue;
    fields.set(name, typeof attribute.FieldValue === "string" ? attribute.FieldValue : "");
  }
  return fields;
}

export function parseTrackerHistoryPoint(raw: unknown): TrackerHistoryPoint | null {
  if (!isRecord(raw)) return null;
  const at = parseTrackerDate(raw.RecordDateTime);
  const lat = numberField(raw.LAT);
  const lng = numberField(raw.LON);
  if (at === undefined || lat === undefined || lng === undefined) return null;
  const attributes = historyAttributeMap(raw.Attributes);
  const point: TrackerHistoryPoint = {
    at,
    lat,
    lng,
    speed: Math.max(0, numberField(raw.Speed) ?? 0),
  };
  const registrationNumber = stringField(raw.RegNo);
  const reason = stringField(raw.Reason);
  const odometerMeters = numberField(attributes.get("Odometer"));
  const ignitionOn = ignitionField(attributes.get("IgStatus"));
  if (registrationNumber) point.registrationNumber = registrationNumber;
  if (reason) point.reason = reason;
  if (odometerMeters !== undefined) point.odometerMeters = odometerMeters;
  if (ignitionOn !== undefined) point.ignitionOn = ignitionOn;
  return point;
}

export type ParsedVehicleHistory = {
  responseCode: number;
  responseMsg: string;
  points: TrackerHistoryPoint[];
};

export function parseVehicleHistoryBody(body: string): ParsedVehicleHistory {
  const parsed = parseTrackerBody(body);
  if (assertTrackerSuccess(parsed, /no\s+history\s+found/i) === "empty") {
    return { responseCode: parsed.responseCode, responseMsg: parsed.responseMsg, points: [] };
  }
  const rawPoints = parsed.data._vehicleHistory;
  if (rawPoints !== null && rawPoints !== undefined && !Array.isArray(rawPoints)) {
    throw new TrackerError("The tracker returned an unexpected response.");
  }
  const points = Array.isArray(rawPoints)
    ? rawPoints
        .map(parseTrackerHistoryPoint)
        .filter((point): point is TrackerHistoryPoint => point !== null)
    : [];
  return { responseCode: parsed.responseCode, responseMsg: parsed.responseMsg, points };
}

const trackerWindowFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TRACKER_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/**
 * Format an instant as `YYYY-MM-DDTHH:mm:ss` Pakistan wall time. This exact
 * shape is what the SOAP `fdt`/`tdt` xsd:dateTime parameters expect; offsets
 * and `Z` are read literally by the server (see the file header).
 */
export function formatTrackerWindow(at: number) {
  const parts: Record<string, string> = {};
  for (const part of trackerWindowFormatter.formatToParts(new Date(at))) {
    parts[part.type] = part.value;
  }
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

async function postTrackerRequest(
  secretKey: string,
  action: string,
  fields: Record<string, string>,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TRACKER_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(TRACKER_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          SOAPAction: `"${TRACKER_NAMESPACE}${action}"`,
        },
        body: buildTrackerRequest(action, { secret_key: secretKey, ...fields }),
        signal: controller.signal,
      });
    } catch {
      throw new TrackerError("Could not reach the tracker. Showing the last synced data.");
    }

    if (!response.ok) {
      throw new TrackerError("The tracker returned an error. Try again in a moment.");
    }

    try {
      // Keep the abort timer alive through the body read, not just headers.
      return await response.text();
    } catch {
      throw new TrackerError("The tracker returned an unexpected response.");
    }
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchTrackerVehicles(secretKey: string): Promise<ParsedGetVData> {
  return parseGetVDataBody(await postTrackerRequest(secretKey, GET_VDATA_ACTION, {}));
}

export async function fetchTrackerTrips(
  secretKey: string,
  registrationNumber: string,
  from: number,
  to: number,
): Promise<ParsedGetTrips> {
  const body = await postTrackerRequest(secretKey, GET_TRIPS_ACTION, {
    regNo: registrationNumber,
    fdt: formatTrackerWindow(from),
    tdt: formatTrackerWindow(to),
  });
  const parsed = parseGetTripsBody(body);
  // The service filters by regNo, but never trust a cross-vehicle row in a
  // tenant-scoped ingestion path.
  return {
    ...parsed,
    trips: parsed.trips.filter((trip) => trip.registrationNumber === registrationNumber),
  };
}

export async function fetchTrackerVehicleHistory(
  secretKey: string,
  registrationNumber: string,
  from: number,
  to: number,
): Promise<ParsedVehicleHistory> {
  const parsed = parseVehicleHistoryBody(
    await postTrackerRequest(secretKey, GET_VEHICLE_HISTORY_ACTION, {
      regNo: registrationNumber,
      fdt: formatTrackerWindow(from),
      tdt: formatTrackerWindow(to),
    }),
  );
  // The service filters by regNo; keep a cross-vehicle row from corrupting
  // arrival or off-route detection if that ever changes.
  return {
    ...parsed,
    points: parsed.points.filter(
      (point) =>
        point.registrationNumber === undefined ||
        point.registrationNumber === registrationNumber,
    ),
  };
}

export function trackerKeyHint(secretKey: string) {
  return secretKey.slice(-4);
}

/** Safe to store on the connection or show in the UI; never contains the key. */
export function trackerSafeMessage(error: unknown) {
  return error instanceof TrackerError
    ? error.safeMessage
    : "Could not reach the tracker. Showing the last synced data.";
}

import { v } from "convex/values";

/**
 * Minimal TrackWorld / portalxs SOAP client for the one operation Fleet needs.
 *
 * The endpoint answers with a JSON object followed directly by an empty SOAP
 * envelope. Parsing therefore takes everything before the first `<?xml` and
 * runs JSON.parse on it.
 *
 * Odometer unit: the tracker reports METERS. Verified against live data on
 * 2026-11-04: vehicle APL-079 advanced 64,663 odometer units over ~47.5 hours
 * while GetTrips for the same window summed 63.6 km — roughly 1,000 units per
 * km. Divide by 1000 for kilometres.
 */
export const TRACKER_ENDPOINT = "https://tw.portalxs.com/twpxapis/TrackingServices.asmx";
const TRACKER_NAMESPACE = "http://tempuri.org/";
const GET_VDATA_ACTION = `${TRACKER_NAMESPACE}TWPXCC_GetVData`;
const TRACKER_TIMEOUT_MS = 15_000;

export const trackerVehicleValidator = v.object({
  registrationNumber: v.string(),
  odometerMeters: v.optional(v.number()),
  lat: v.optional(v.number()),
  lng: v.optional(v.number()),
  address: v.optional(v.string()),
  speed: v.optional(v.number()),
  ignitionOn: v.optional(v.boolean()),
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
  recordedAt?: number;
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

export function buildGetVDataRequest(secretKey: string) {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
    "<soap:Body>" +
    `<TWPXCC_GetVData xmlns="${TRACKER_NAMESPACE}">` +
    `<secret_key>${escapeXml(secretKey)}</secret_key>` +
    "</TWPXCC_GetVData>" +
    "</soap:Body>" +
    "</soap:Envelope>"
  );
}

function numberField(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** Tracker dates look like `\/Date(1793785727000)\/` after JSON decoding. */
export function parseTrackerDate(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const match = /^\/Date\((-?\d+)\)\/$/.exec(value);
  return match ? Number(match[1]) : undefined;
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
  const recordedAt = parseTrackerDate(raw.RecordDateTime);
  const address = typeof raw.Address === "string" ? raw.Address.trim() : "";

  if (odometerMeters !== undefined) vehicle.odometerMeters = odometerMeters;
  if (lat !== undefined) vehicle.lat = lat;
  if (lng !== undefined) vehicle.lng = lng;
  if (speed !== undefined) vehicle.speed = speed;
  if (ignitionOn !== undefined) vehicle.ignitionOn = ignitionOn;
  if (recordedAt !== undefined) vehicle.recordedAt = recordedAt;
  if (address) vehicle.address = address;
  return vehicle;
}

export type ParsedGetVData = {
  responseCode: number;
  responseMsg: string;
  vehicles: TrackerVehicle[];
};

export function parseGetVDataBody(body: string): ParsedGetVData {
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

  const responseCode = parsed.responseCode;
  const responseMsg = typeof parsed.responseMsg === "string" ? parsed.responseMsg : "";
  if (responseCode !== 200) {
    throw new TrackerError(
      responseCode === 401 || responseCode === 402 || responseCode === 403
        ? "The tracker rejected this key. Check it and try again."
        : "The tracker rejected the request. Try again in a moment.",
    );
  }

  const rawVehicles = parsed._vehicleData;
  if (rawVehicles !== null && rawVehicles !== undefined && !Array.isArray(rawVehicles)) {
    throw new TrackerError("The tracker returned an unexpected response.");
  }
  const vehicles = Array.isArray(rawVehicles)
    ? rawVehicles.map(parseTrackerVehicle).filter((vehicle): vehicle is TrackerVehicle => vehicle !== null)
    : [];

  return { responseCode, responseMsg, vehicles };
}

export async function fetchTrackerVehicles(secretKey: string): Promise<ParsedGetVData> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TRACKER_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(TRACKER_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          SOAPAction: `"${GET_VDATA_ACTION}"`,
        },
        body: buildGetVDataRequest(secretKey),
        signal: controller.signal,
      });
    } catch {
      throw new TrackerError("Could not reach the tracker. Showing the last synced data.");
    }

    if (!response.ok) {
      throw new TrackerError("The tracker returned an error. Try again in a moment.");
    }

    let body: string;
    try {
      // Keep the abort timer alive through the body read, not just headers.
      body = await response.text();
    } catch {
      throw new TrackerError("The tracker returned an unexpected response.");
    }
    return parseGetVDataBody(body);
  } finally {
    clearTimeout(timeout);
  }
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

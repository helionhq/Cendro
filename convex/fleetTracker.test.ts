import { describe, expect, test } from "vitest";
import {
  formatTrackerWindow,
  parseGetTripsBody,
  parseGetVDataBody,
  parseVehicleHistoryBody,
  TrackerError,
} from "./fleetTracker";

const envelope =
  '<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><TWPXCC_GetTripsResponse xmlns="http://tempuri.org/" /></soap:Body></soap:Envelope>';

function body(payload: unknown) {
  return `${JSON.stringify(payload)}${envelope}`;
}

describe("tracker parsing", () => {
  test("GetTrips converts km strings to metres and strips landmark prefixes", () => {
    const parsed = parseGetTripsBody(
      body({
        responseCode: 200,
        responseMsg: "Sucessful",
        _trips: [
          {
            RegNo: "APL-079",
            IGON_RDT: "/Date(1794145087000)/",
            IGON_LAT: "31.4622916",
            IGON_LON: "74.458025",
            IGON_LandMark: "0 H No 79,St 2,Sector E,DHA 6,Lahore,Punjab",
            IGOFF_RDT: "/Date(1794145137000)/",
            IGOFF_LAT: "31.46236",
            IGOFF_LON: "74.4580033",
            IGOFF_LandMark: "1 80, Street 2, Block E, DHA Phase 6, Lahore, Punjab",
            Mileage: "1.7",
            TravelTimeS: "292",
            MaxSpeed: "23",
            AvgSpeed: "21.0 km/hr",
          },
        ],
      }),
    );
    expect(parsed.trips).toHaveLength(1);
    expect(parsed.trips[0]).toMatchObject({
      registrationNumber: "APL-079",
      distanceMeters: 1_700,
      travelSeconds: 292,
      maxSpeedKmh: 23,
      avgSpeedKmh: 21,
      startLandmark: "H No 79,St 2,Sector E,DHA 6,Lahore,Punjab",
      endLandmark: "80, Street 2, Block E, DHA Phase 6, Lahore, Punjab",
    });
  });

  test("a 402 no-trips window is a successful empty read, not an auth failure", () => {
    const parsed = parseGetTripsBody(
      body({ responseCode: 402, responseMsg: "No Trips found...", _trips: null }),
    );
    expect(parsed.trips).toEqual([]);
  });

  test("a 402 rejected-key response still throws", () => {
    expect(() =>
      parseGetTripsBody(
        body({
          responseCode: 402,
          responseMsg: "No Data found. Please check and verify your Secret Key",
          _trips: null,
        }),
      ),
    ).toThrow(TrackerError);
  });

  test("GetVehicleHistory reads attributes and treats an empty window as empty", () => {
    const parsed = parseVehicleHistoryBody(
      body({
        responseCode: 200,
        responseMsg: "Sucessful",
        _vehicleHistory: [
          {
            RegNo: "APL-079",
            RecordDateTime: "/Date(1794108268000)/",
            LAT: "31.462305",
            LON: "74.458055",
            Speed: "5",
            Reason: "Turn",
            Attributes: [
              { FieldName: "Odometer", FieldValue: "51158448" },
              { FieldName: "IgStatus", FieldValue: "True" },
              { FieldName: "FuelLevel", FieldValue: "" },
            ],
          },
        ],
      }),
    );
    expect(parsed.points[0]).toMatchObject({
      at: 1_794_108_268_000,
      odometerMeters: 51_158_448,
      ignitionOn: true,
      reason: "Turn",
    });

    expect(
      parseVehicleHistoryBody(
        body({ responseCode: 402, responseMsg: "No History found...", _vehicleHistory: null }),
      ).points,
    ).toEqual([]);
  });

  test("GetVData exposes the extra live fields Fleet v2 needs", () => {
    const parsed = parseGetVDataBody(
      body({
        responseCode: 200,
        responseMsg: "Sucessful",
        _vehicleData: [
          {
            RegistrationNumber: "APL-079",
            Latitude: "31.4695483",
            Longitude: "74.4500666",
            Speed: 0,
            Odometer: 51_253_679,
            LastIgnitionStatus: "False",
            LastIgnitionStatusDateTime: "/Date(1794227045000)/",
            RecordDateTime: "/Date(1794227045000)/",
            Address: "DHA Phase 6, Lahore",
            Reason: "Ignition Off",
            DirectionDegree: 341,
          },
        ],
      }),
    );
    expect(parsed.vehicles[0]).toMatchObject({
      ignitionOn: false,
      ignitionChangedAt: 1_794_227_045_000,
      reason: "Ignition Off",
      directionDegree: 341,
    });
  });

  test("tracker windows are formatted as Pakistan wall time, not UTC", () => {
    // 1794108262000 = 03:24:22 UTC = 08:24:22 PKT.
    expect(formatTrackerWindow(1_794_108_262_000)).toBe("2026-11-08T08:24:22");
  });
});

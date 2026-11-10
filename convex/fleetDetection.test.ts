import { describe, expect, test } from "vitest";
import {
  clusterByDistance,
  groupConsecutiveTrips,
  haversineMeters,
  isTrackerTripCovered,
  maxCorridorDeviation,
  mostCommonValue,
  pointToSegmentDistanceMeters,
  selectBasePlace,
} from "./fleetDetection";

const MINUTE = 60_000;

describe("fleet geometry", () => {
  test("haversine matches one degree of latitude", () => {
    // One degree of latitude is ~111.2 km on a 6,371 km sphere.
    expect(haversineMeters({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(111_195, -2);
  });

  test("point-to-segment distance is perpendicular inside the segment", () => {
    // 0.01 degrees of latitude north of a segment running along longitude.
    const distance = pointToSegmentDistanceMeters(
      { lat: 0.01, lng: 0.01 },
      { lat: 0, lng: 0 },
      { lat: 0, lng: 0.02 },
    );
    expect(distance).toBeCloseTo(1_113, -1);
  });

  test("clustering joins nearby stops and keeps far ones separate", () => {
    const clusters = clusterByDistance(
      [
        { lat: 0, lng: 0, name: "first" },
        { lat: 0, lng: 0.0005, name: "nearby" },
        { lat: 0.01, lng: 0, name: "far" },
      ],
      250,
    );
    expect(clusters.map((cluster) => cluster.length)).toEqual([2, 1]);
    expect(mostCommonValue(["Saggian Plant", undefined, "Saggian Plant", "Other"])).toBe(
      "Saggian Plant",
    );
  });

  test("the corridor picks the farthest point from the straight base-destination line", () => {
    const deviation = maxCorridorDeviation(
      [
        { lat: 0, lng: 0.01, at: 1, label: "on route" },
        { lat: 0.05, lng: 0.01, at: 2, label: "far off" },
      ],
      { lat: 0, lng: 0 },
      { lat: 0, lng: 0.02 },
    );
    expect(deviation?.point.label).toBe("far off");
    expect(deviation?.maxDeviationMeters).toBeGreaterThan(5_000);
  });

  test("base selection excludes the destination when another base exists", () => {
    const baseA = { _id: "a", lat: 0, lng: 0, radiusMeters: 300 };
    const baseB = { _id: "b", lat: 0, lng: 0.01, radiusMeters: 300 };
    expect(
      selectBasePlace({ lat: 0.0001, lng: 0.0001 }, [baseA, baseB], "b")?._id,
    ).toBe("a");
  });
});

describe("tracker trip coverage and grouping", () => {
  test("a tracker trip is covered only inside the logged window plus 15 minutes", () => {
    const logged = [{ departedAt: 1_000, returnedAt: 2_000 }];
    expect(isTrackerTripCovered({ startedAt: 1_100, endedAt: 1_900 }, logged, 5_000, 200)).toBe(true);
    expect(isTrackerTripCovered({ startedAt: 100, endedAt: 1_900 }, logged, 5_000, 200)).toBe(false);
    // Open trips run through `now`: 2,400 is within now (2,500) + buffer.
    const open = [{ departedAt: 1_000, returnedAt: null }];
    expect(isTrackerTripCovered({ startedAt: 2_000, endedAt: 2_400 }, open, 2_500, 200)).toBe(true);
  });

  test("consecutive uncovered outings group by a 30-minute gap", () => {
    const groups = groupConsecutiveTrips([
      { startedAt: 0, endedAt: 10 * MINUTE },
      { startedAt: 15 * MINUTE, endedAt: 25 * MINUTE },
      { startedAt: 60 * MINUTE, endedAt: 70 * MINUTE },
    ]);
    expect(groups.map((group) => group.length)).toEqual([2, 1]);
  });
});

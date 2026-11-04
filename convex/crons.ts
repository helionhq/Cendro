import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("record missed JD cycles", { hours: 1 }, internal.tasks.recordMissedJdCyclesBatch, {});
crons.interval("sweep expired task upload claims", { hours: 24 }, internal.tasks.sweepExpiredTaskUploadClaims, {});
crons.interval("sweep expired task import previews", { hours: 24 }, internal.taskImports.sweepExpiredTaskImportPreviews, {});
crons.interval("sync fleet trackers", { minutes: 10 }, internal.fleetSync.syncAllTrackers, {});
crons.interval("sweep expired fleet upload claims", { hours: 24 }, internal.fleetInternal.sweepExpiredFleetUploadClaims, {});

export default crons;

import { customMutation } from "convex-helpers/server/customFunctions";
import { Triggers } from "convex-helpers/server/triggers";
import { internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
// eslint-disable-next-line no-restricted-imports
import { internalMutation as rawInternalMutation, mutation as rawMutation, type MutationCtx } from "./_generated/server";
import { registerJdReportTriggers, takeJdReportWork } from "./jdReportTriggers";

const triggers = new Triggers<DataModel>();
registerJdReportTriggers(triggers);

// Every mutation writes through the triggers, and derived tables catch up in
// the same transaction once the handler succeeds, so they never disagree with
// their sources. The report update runs as a nested mutation: importing it
// here would cycle back through the modules that import these builders.
// ESLint enforces these builders over the raw ones.
const withDerivedTables = {
  args: {},
  input: (ctx: MutationCtx) => ({
    ctx: triggers.wrapDB(ctx),
    args: {},
    onSuccess: async ({ ctx }: { ctx: MutationCtx }) => {
      const work = takeJdReportWork(ctx);
      if (work) await ctx.runMutation(internal.jdReport.applyLedgerWrites, work);
    },
  }),
};

export const mutation = customMutation(rawMutation, withDerivedTables);
export const internalMutation = customMutation(rawInternalMutation, withDerivedTables);

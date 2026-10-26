/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as aiChat from "../aiChat.js";
import type * as aiWorkspace from "../aiWorkspace.js";
import type * as analytics from "../analytics.js";
import type * as companies from "../companies.js";
import type * as companyManagement from "../companyManagement.js";
import type * as crons from "../crons.js";
import type * as dashboardTime from "../dashboardTime.js";
import type * as email from "../email.js";
import type * as invitations from "../invitations.js";
import type * as permissions from "../permissions.js";
import type * as platform from "../platform.js";
import type * as queryLimits from "../queryLimits.js";
import type * as references from "../references.js";
import type * as roles from "../roles.js";
import type * as searchText from "../searchText.js";
import type * as sopListPreferences from "../sopListPreferences.js";
import type * as sops from "../sops.js";
import type * as taskCycles from "../taskCycles.js";
import type * as taskEvidence from "../taskEvidence.js";
import type * as taskImports from "../taskImports.js";
import type * as taskListPreferences from "../taskListPreferences.js";
import type * as tasks from "../tasks.js";
import type * as users from "../users.js";
import type * as validation from "../validation.js";
import type * as workCalendar from "../workCalendar.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  aiChat: typeof aiChat;
  aiWorkspace: typeof aiWorkspace;
  analytics: typeof analytics;
  companies: typeof companies;
  companyManagement: typeof companyManagement;
  crons: typeof crons;
  dashboardTime: typeof dashboardTime;
  email: typeof email;
  invitations: typeof invitations;
  permissions: typeof permissions;
  platform: typeof platform;
  queryLimits: typeof queryLimits;
  references: typeof references;
  roles: typeof roles;
  searchText: typeof searchText;
  sopListPreferences: typeof sopListPreferences;
  sops: typeof sops;
  taskCycles: typeof taskCycles;
  taskEvidence: typeof taskEvidence;
  taskImports: typeof taskImports;
  taskListPreferences: typeof taskListPreferences;
  tasks: typeof tasks;
  users: typeof users;
  validation: typeof validation;
  workCalendar: typeof workCalendar;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};

import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { taskListOrderEntryValidator, taskListPreferenceValidator } from "./taskListPreferences";
import { sopListPreferenceValidator } from "./sopListPreferences";

const role = v.string();
const priority = v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("critical"));
const rec = v.union(v.literal("daily"), v.literal("every_other_day"), v.literal("weekly"), v.literal("semimonthly"), v.literal("monthly"), v.literal("quarterly"), v.literal("semiannually"), v.literal("annually"));
const taskStatus = v.union(v.literal("due"), v.literal("in_progress"), v.literal("completed"), v.literal("awaiting_confirmation"));
const scope = v.union(v.literal("company"), v.literal("branch"), v.literal("department"), v.literal("user"));
const taskType = v.union(v.literal("jd"), v.literal("one_time"));

export default defineSchema({
  appUsers: defineTable({ clerkSubject: v.string(), email: v.string(), firstName: v.string(), secondName: v.optional(v.string()), imageUrl: v.optional(v.string()), createdAt: v.number(), updatedAt: v.number() }).index("by_subject", ["clerkSubject"]).index("by_email", ["email"]),
  companies: defineTable({ name: v.string(), timeZone: v.optional(v.string()), createdAt: v.number(), createdBy: v.optional(v.id("appUsers")), deletedAt: v.optional(v.number()), authVersion: v.optional(v.number()) }).index("by_deleted", ["deletedAt"]),
  companyMemberships: defineTable({ companyId: v.id("companies"), userId: v.id("appUsers"), role, active: v.boolean(), firstName: v.optional(v.string()), secondName: v.optional(v.string()), createdAt: v.number(), updatedAt: v.number() }).index("by_company", ["companyId"]).index("by_user", ["userId"]).index("by_company_user", ["companyId", "userId"]).index("by_companyId_and_role", ["companyId", "role"]),
  branches: defineTable({ companyId: v.id("companies"), name: v.string(), order: v.optional(v.number()), createdAt: v.number(), updatedAt: v.number() }).index("by_company", ["companyId"]),
  departments: defineTable({ companyId: v.id("companies"), branchId: v.id("branches"), name: v.string(), order: v.optional(v.number()), createdAt: v.number(), updatedAt: v.number() }).index("by_company", ["companyId"]).index("by_branch", ["branchId"]),
  userBranchAssignments: defineTable({ companyId: v.id("companies"), membershipId: v.id("companyMemberships"), branchId: v.id("branches") }).index("by_branch", ["branchId"]).index("by_membershipId_and_branchId", ["membershipId", "branchId"]),
  userDepartmentAssignments: defineTable({ companyId: v.id("companies"), membershipId: v.id("companyMemberships"), departmentId: v.id("departments") }).index("by_department", ["departmentId"]).index("by_membershipId_and_departmentId", ["membershipId", "departmentId"]),
  managerBranchScopes: defineTable({ companyId: v.id("companies"), managerMembershipId: v.id("companyMemberships"), branchId: v.id("branches"), updatedAt: v.number() }).index("by_branch", ["branchId"]).index("by_company", ["companyId"]).index("by_managerMembershipId_and_branchId", ["managerMembershipId", "branchId"]),
  managerDepartmentScopes: defineTable({ companyId: v.id("companies"), managerMembershipId: v.id("companyMemberships"), departmentId: v.id("departments"), updatedAt: v.number() }).index("by_department", ["departmentId"]).index("by_company", ["companyId"]).index("by_managerMembershipId_and_departmentId", ["managerMembershipId", "departmentId"]),
  managerUserScopes: defineTable({ companyId: v.id("companies"), managerMembershipId: v.id("companyMemberships"), userMembershipId: v.id("companyMemberships"), updatedAt: v.number() }).index("by_user", ["userMembershipId"]).index("by_company", ["companyId"]).index("by_managerMembershipId_and_userMembershipId", ["managerMembershipId", "userMembershipId"]),
  roles: defineTable({ companyId: v.id("companies"), name: v.string(), capabilities: v.array(v.string()), createdAt: v.number(), updatedAt: v.number() }).index("by_company", ["companyId"]).index("by_company_and_name", ["companyId", "name"]),
  // Deprecated: superseded by role-owned capabilities. Retained only so the
  // legacy-cleanup path can still read and delete any remaining rows.
  permissionOverrides: defineTable({ companyId: v.id("companies"), membershipId: v.id("companyMemberships"), capability: v.string(), effect: v.union(v.literal("allow"), v.literal("deny")), updatedAt: v.number() }).index("by_membershipId_and_capability", ["membershipId", "capability"]),
  invitations: defineTable({
    companyId: v.id("companies"),
    email: v.string(),
    role,
    branchIds: v.optional(v.array(v.id("branches"))),
    departmentIds: v.optional(v.array(v.id("departments"))),
    managedBranchIds: v.optional(v.array(v.id("branches"))),
    managedDepartmentIds: v.optional(v.array(v.id("departments"))),
    managedUserMembershipIds: v.optional(v.array(v.id("companyMemberships"))),
    // Deprecated: no longer written or read. Retained so older invitation
    // documents remain valid until the cleanup clears the field.
    permissionOverrides: v.optional(v.array(v.object({ capability: v.string(), effect: v.union(v.literal("allow"), v.literal("deny")) }))),
    token: v.string(),
    status: v.union(v.literal("pending"), v.literal("accepted"), v.literal("revoked")),
    invitedBy: v.optional(v.id("appUsers")),
    createdAt: v.number(),
    expiresAt: v.number(),
    sentAt: v.optional(v.number()),
    authVersion: v.optional(v.number()),
    issuedAt: v.optional(v.number()),
    targetMembershipId: v.optional(v.id("companyMemberships")),
    targetMembershipUpdatedAt: v.optional(v.number()),
  }).index("by_company", ["companyId"]).index("by_token", ["token"]).index("by_email", ["email"]).index("by_companyId_and_email_and_status", ["companyId", "email", "status"]).index("by_companyId_and_status_and_targetMembershipId", ["companyId", "status", "targetMembershipId"]),
  referenceCounters: defineTable({ companyId: v.id("companies"), kind: v.union(v.literal("jd"), v.literal("one_time"), v.literal("sop")), lastNumber: v.number() }).index("by_companyId_and_kind", ["companyId", "kind"]),
  // Activation phase: existing deployments must first deploy schema-only
  // staging revision 2d4c7ab and finish all four index backfills (see README).
  jdTasks: defineTable({ companyId: v.id("companies"), reference: v.string(), title: v.string(), description: v.optional(v.string()), notes: v.optional(v.string()), time: v.optional(v.string()), quantity: v.optional(v.number()), recurrence: rec, pausedAt: v.optional(v.number()), cycleStartedAt: v.number(), status: taskStatus, statusCycleStart: v.optional(v.number()), overdueAt: v.optional(v.number()), evidenceRequired: v.optional(v.boolean()), confirmerMembershipId: v.optional(v.id("companyMemberships")), assigneeMembershipIds: v.array(v.id("companyMemberships")), createdByMembershipId: v.id("companyMemberships"), createdAt: v.number(), updatedAt: v.number() }).index("by_company", ["companyId"]).index("by_companyId_and_pausedAt", ["companyId", "pausedAt"]).index("by_companyId_and_pausedAt_and_reference", ["companyId", "pausedAt", "reference"]).index("by_companyId_and_reference", ["companyId", "reference"]).searchIndex("search_active_title", { searchField: "title", filterFields: ["companyId", "pausedAt"] }),
  jdTaskCompletions: defineTable({ companyId: v.id("companies"), jdTaskId: v.id("jdTasks"), cycleStart: v.number(), cycleEnd: v.optional(v.number()), retiredAt: v.optional(v.number()), completedByMembershipId: v.optional(v.id("companyMemberships")), completedAt: v.number(), note: v.optional(v.string()) }).index("by_task_and_cycleStart", ["jdTaskId", "cycleStart"]).index("by_companyId_and_cycleStart", ["companyId", "cycleStart"]),
  // Kept optional while legacy schedule-generation records remain live.
  jdTaskCycleRecords: defineTable({ companyId: v.id("companies"), jdTaskId: v.id("jdTasks"), cycleStart: v.number(), cycleEnd: v.number(), status: v.literal("missed"), recordedAt: v.number(), retiredAt: v.optional(v.number()), scheduleGeneration: v.optional(v.number()) }).index("by_task_and_cycleStart", ["jdTaskId", "cycleStart"]).index("by_task_and_cycleEnd", ["jdTaskId", "cycleEnd"]).index("by_companyId_and_cycleEnd", ["companyId", "cycleEnd"]),
  // One row per company: which weekdays count as working days for JD task
  // due dates. Holidays live in their own rows so ranges stay unbounded in
  // number without rewriting a shared document.
  companyCalendars: defineTable({ companyId: v.id("companies"), workingDays: v.array(v.number()), updatedAt: v.number(), updatedByMembershipId: v.optional(v.id("companyMemberships")) }).index("by_company", ["companyId"]),
  // startDate/endDate are "YYYY-MM-DD" calendar dates in the company's own
  // calendar — they are not instants and carry no timezone.
  companyHolidays: defineTable({ companyId: v.id("companies"), name: v.string(), startDate: v.string(), endDate: v.string(), recursYearly: v.optional(v.boolean()), createdByMembershipId: v.optional(v.id("companyMemberships")), createdAt: v.number() }).index("by_company", ["companyId"]),
  oneTimeTasks: defineTable({ companyId: v.id("companies"), reference: v.string(), title: v.string(), description: v.optional(v.string()), notes: v.optional(v.string()), dueDate: v.optional(v.number()), time: v.optional(v.string()), quantity: v.optional(v.number()), assigneeMembershipIds: v.array(v.id("companyMemberships")), createdByMembershipId: v.id("companyMemberships"), priority, status: taskStatus, overdueAt: v.optional(v.number()), completedAt: v.optional(v.number()), completedByMembershipId: v.optional(v.id("companyMemberships")), evidenceRequired: v.optional(v.boolean()), confirmerMembershipId: v.optional(v.id("companyMemberships")), createdAt: v.number(), updatedAt: v.number() }).index("by_company", ["companyId"]).index("by_companyId_and_reference", ["companyId", "reference"]).index("by_companyId_and_createdAt", ["companyId", "createdAt"]).searchIndex("search_title", { searchField: "title", filterFields: ["companyId"] }),
  taskListPreferences: defineTable(taskListPreferenceValidator).index("by_companyId_and_membershipId_and_taskType", ["companyId", "membershipId", "taskType"]),
  taskCustomViews: defineTable({ companyId: v.id("companies"), membershipId: v.id("companyMemberships"), taskType, orderedIds: v.array(v.string()), revision: v.number() }).index("by_companyId_and_membershipId_and_taskType", ["companyId", "membershipId", "taskType"]),
  taskListOrderEntries: defineTable(taskListOrderEntryValidator).index("by_companyId_and_membershipId_and_taskType_and_taskId", ["companyId", "membershipId", "taskType", "taskId"]),
  taskComments: defineTable({ companyId: v.id("companies"), taskType, taskId: v.string(), authorMembershipId: v.id("companyMemberships"), body: v.string(), createdAt: v.number() }).index("by_task", ["taskType", "taskId"]).index("by_company", ["companyId"]),
  taskActivityLogs: defineTable({ companyId: v.id("companies"), taskType, taskId: v.string(), actorMembershipId: v.id("companyMemberships"), event: v.union(v.literal("created"), v.literal("status_changed"), v.literal("paused"), v.literal("resumed")), fromStatus: v.optional(taskStatus), toStatus: v.optional(taskStatus), createdAt: v.number() }).index("by_task", ["taskType", "taskId"]).index("by_company", ["companyId"]).index("by_taskType_and_taskId_and_event_and_createdAt", ["taskType", "taskId", "event", "createdAt"]),
  taskAttachments: defineTable({ companyId: v.id("companies"), taskType, taskId: v.string(), fileName: v.string(), contentType: v.string(), size: v.number(), storageId: v.id("_storage"), createdByMembershipId: v.id("companyMemberships"), createdAt: v.number() }).index("by_task", ["taskType", "taskId"]).index("by_company", ["companyId"]).index("by_storageId", ["storageId"]),
  // One row per issued upload URL. Held until addAttachment consumes it, so
  // orphan cleanup can prove the caller was issued an upload slot in this
  // company instead of deleting arbitrary unreferenced blobs cross-tenant.
  taskUploadClaims: defineTable({ companyId: v.id("companies"), membershipId: v.id("companyMemberships"), storageId: v.optional(v.id("_storage")), createdAt: v.number() }).index("by_company", ["companyId"]),
  // Evidence binds to the completed cycle for recurring tasks; one active row
  // per cycle (JD) or per completion (one-time). Rows are deleted on reopen and
  // retired (never deleted) when a recurrence change supersedes their cycle.
  taskEvidence: defineTable({ companyId: v.id("companies"), taskType, taskId: v.string(), cycleStart: v.optional(v.number()), text: v.optional(v.string()), files: v.array(v.object({ storageId: v.id("_storage"), fileName: v.string(), contentType: v.string(), size: v.number() })), createdByMembershipId: v.id("companyMemberships"), createdAt: v.number(), retiredAt: v.optional(v.number()) }).index("by_task", ["taskType", "taskId"]).index("by_task_and_cycleStart", ["taskType", "taskId", "cycleStart"]),
  // Indexed blob references for evidence (its files live in a bounded array on
  // taskEvidence, which cannot be indexed). Cleanup consults this alongside
  // taskAttachments before deleting any blob.
  taskEvidenceBlobs: defineTable({ evidenceId: v.id("taskEvidence"), storageId: v.id("_storage") }).index("by_storageId", ["storageId"]).index("by_evidenceId", ["evidenceId"]),
  // One row per submission waiting on its designated confirmer. Deleted when
  // resolved. JD rows are per cycle; one-time rows carry no cycle fields.
  taskConfirmationRequests: defineTable({ companyId: v.id("companies"), taskType, taskId: v.string(), cycleStart: v.optional(v.number()), cycleEnd: v.optional(v.number()), confirmerMembershipId: v.id("companyMemberships"), submittedByMembershipId: v.id("companyMemberships"), submittedAt: v.number() }).index("by_confirmerMembershipId_and_taskType_and_submittedAt", ["confirmerMembershipId", "taskType", "submittedAt"]).index("by_taskType_and_taskId_and_cycleStart", ["taskType", "taskId", "cycleStart"]),
  sops: defineTable({ companyId: v.id("companies"), reference: v.string(), title: v.string(), content: v.string(), scopeType: scope, creatorMembershipId: v.id("companyMemberships"), updatedByMembershipId: v.id("companyMemberships"), createdAt: v.number(), updatedAt: v.number() }).index("by_company", ["companyId"]).index("by_companyId_and_reference", ["companyId", "reference"]).searchIndex("search_content", { searchField: "content", filterFields: ["companyId"] }).searchIndex("search_title", { searchField: "title", filterFields: ["companyId"] }),
  sopBranchScopes: defineTable({ companyId: v.id("companies"), sopId: v.id("sops"), branchId: v.id("branches") }).index("by_branch", ["branchId"]).index("by_company", ["companyId"]).index("by_sopId_and_branchId", ["sopId", "branchId"]),
  sopDepartmentScopes: defineTable({ companyId: v.id("companies"), sopId: v.id("sops"), departmentId: v.id("departments") }).index("by_department", ["departmentId"]).index("by_company", ["companyId"]).index("by_sopId_and_departmentId", ["sopId", "departmentId"]),
  sopUserScopes: defineTable({ companyId: v.id("companies"), sopId: v.id("sops"), userMembershipId: v.id("companyMemberships") }).index("by_user", ["userMembershipId"]).index("by_company", ["companyId"]).index("by_sopId_and_userMembershipId", ["sopId", "userMembershipId"]),
  sopListPreferences: defineTable(sopListPreferenceValidator).index("by_companyId_and_membershipId", ["companyId", "membershipId"]),
  auditEvents: defineTable({ companyId: v.optional(v.id("companies")), actorUserId: v.optional(v.id("appUsers")), actorEmail: v.optional(v.string()), action: v.string(), targetType: v.string(), targetId: v.optional(v.string()), metadata: v.optional(v.any()), createdAt: v.number() }).index("by_company", ["companyId"]),
  aiChatSessions: defineTable({ companyId: v.id("companies"), membershipId: v.id("companyMemberships"), title: v.optional(v.string()), hasMessages: v.optional(v.boolean()), createdAt: v.number(), updatedAt: v.number() }).index("by_membership_and_updatedAt", ["membershipId", "updatedAt"]).index("by_company", ["companyId"]),
  aiChatMessages: defineTable({ sessionId: v.id("aiChatSessions"), role: v.union(v.literal("user"), v.literal("assistant"), v.literal("tool")), content: v.string(), clientMessageId: v.optional(v.string()), createdAt: v.number() }).index("by_session", ["sessionId"]).index("by_session_and_clientMessageId", ["sessionId", "clientMessageId"]),
  aiRateLimits: defineTable({ key: v.string(), count: v.number(), resetAt: v.number(), updatedAt: v.number() }).index("by_key", ["key"]).index("by_resetAt", ["resetAt"]),
  aiChatPersistenceRequests: defineTable({ requestId: v.string(), createdAt: v.number() }).index("by_requestId", ["requestId"]),
  taskImportBatches: defineTable({ companyId: v.id("companies"), actorMembershipId: v.id("companyMemberships"), kind: taskType, importKey: v.string(), batchKey: v.string(), source: v.union(v.literal("cendro"), v.literal("ai")), requestFingerprint: v.string(), result: v.object({ created: v.number(), updated: v.number(), skipped: v.number(), failed: v.number(), taskReferences: v.array(v.string()) }), createdAt: v.number() }).index("by_companyId_and_importKey_and_batchKey", ["companyId", "importKey", "batchKey"]),
  taskImportPreviews: defineTable({ companyId: v.id("companies"), actorMembershipId: v.id("companyMemberships"), kind: taskType, fingerprint: v.string(), rowCount: v.number(), createdAt: v.number() }),
});

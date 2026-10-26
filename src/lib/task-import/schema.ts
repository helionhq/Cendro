import { z } from "zod";

export const taskKinds = ["jd", "one_time"] as const;
export const extractionSources = ["cendro"] as const;
export const frequencies = ["daily", "every_other_day", "weekly", "semimonthly", "monthly", "quarterly", "semiannually", "annually"] as const;
export const priorities = ["low", "medium", "high", "critical"] as const;
export const taskStatuses = ["due", "in_progress", "completed"] as const;

export type TaskImportKind = (typeof taskKinds)[number];
export type ExtractionSource = (typeof extractionSources)[number];
export type Frequency = (typeof frequencies)[number];
export type Priority = (typeof priorities)[number];
export type TaskImportStatus = (typeof taskStatuses)[number];

export const taskImportFieldNames = [
  "reference",
  "title",
  "description",
  "notes",
  "recurrence",
  "dueDate",
  "priority",
  "time",
  "quantity",
  "assignees",
  "status",
  "isActive",
  "evidenceRequired",
] as const;

export type TaskImportField = (typeof taskImportFieldNames)[number];

const presentFieldSchema = z.enum(taskImportFieldNames);
const taskKindSchema = z.enum(taskKinds);
const extractionSourceSchema = z.enum(extractionSources);
const frequencySchema = z.enum(frequencies);
const prioritySchema = z.enum(priorities);
const statusSchema = z.enum(taskStatuses);

/**
 * Clean, JSON-safe row representation for Cendro task workbook import.
 * Missing scalar values are represented by null so the same object can cross
 * the browser/Convex boundaries without relying on undefined semantics.
 */
export const taskImportDraftSchema = z.object({
  rowKey: z.string().trim().min(1).max(200),
  sourceSheet: z.string().trim().min(1).max(200),
  sourceRow: z.number().int().min(1).max(1_000_000),
  source: extractionSourceSchema,
  kind: taskKindSchema,
  reference: z.string().max(200).nullable(),
  title: z.string().max(500).nullable(),
  description: z.string().max(20_000).nullable(),
  notes: z.string().max(20_000).nullable(),
  recurrence: frequencySchema.nullable(),
  dueDate: z.number().finite().nullable(),
  priority: prioritySchema.nullable(),
  time: z.string().max(200).nullable(),
  quantity: z.number().finite().nullable(),
  rawAssigneeText: z.string().max(2_000),
  assigneeEmails: z.array(z.string().max(320)).max(50),
  status: statusSchema.nullable(),
  isActive: z.boolean().nullable(),
  // Optional on the wire so older clients still validate during a rolling deploy.
  evidenceRequired: z.boolean().nullable().optional(),
  presentFields: z.array(presentFieldSchema).max(taskImportFieldNames.length),
  warnings: z.array(z.string().max(500)).max(20),
}).strict().superRefine((row, context) => {
  const uniqueFields = new Set(row.presentFields);
  if (uniqueFields.size !== row.presentFields.length) {
    context.addIssue({ code: "custom", path: ["presentFields"], message: "presentFields must not contain duplicates" });
  }
  if (row.kind === "jd" && (row.dueDate !== null || uniqueFields.has("dueDate"))) {
    context.addIssue({ code: "custom", path: ["dueDate"], message: "JD rows cannot contain a due date" });
  }
  if (row.kind === "jd" && (row.priority !== null || uniqueFields.has("priority"))) {
    context.addIssue({ code: "custom", path: ["priority"], message: "JD rows cannot contain a priority" });
  }
  if (row.kind === "one_time" && (row.recurrence !== null || uniqueFields.has("recurrence"))) {
    context.addIssue({ code: "custom", path: ["recurrence"], message: "One-time rows cannot contain a recurrence" });
  }
  if (row.kind === "one_time" && (row.isActive !== null || uniqueFields.has("isActive"))) {
    context.addIssue({ code: "custom", path: ["isActive"], message: "One-time rows cannot contain an active state" });
  }
});

export type TaskImportDraft = z.infer<typeof taskImportDraftSchema>;

export function referenceForKind(value: unknown, kind: TaskImportKind) {
  const reference = typeof value === "string" ? value.trim().toUpperCase() : value == null ? "" : String(value).trim().toUpperCase();
  const prefix = kind === "jd" ? "JD" : "TSK";
  if (!reference) return { value: null as string | null, error: `Task code is required and must match ${prefix}-001.` };
  const valid = kind === "jd"
    ? /^JD-\d{3,15}$/.test(reference)
    : /^(?:TSK|OT)-\d{3,15}$/.test(reference);
  if (!valid) return { value: reference, error: `Code must match ${prefix}-001.` };
  return { value: reference };
}

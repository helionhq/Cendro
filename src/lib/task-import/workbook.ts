import { strFromU8, unzipSync } from "fflate";
import readXlsxFile, { type SheetData } from "read-excel-file/browser";
import writeXlsxFile, { type Cell, type SheetData as WriteSheetData } from "write-excel-file/browser";
import {
  taskImportDraftSchema,
  referenceForKind,
  type Frequency,
  type Priority,
  type TaskImportDraft,
  type TaskImportKind,
} from "./schema";

export const TASK_IMPORT_SCHEMA_VERSION = 1;
export const TASK_IMPORT_FORMAT = "cendro-task-export";
export const TASK_IMPORT_MAX_ROWS = 500;
export const TASK_IMPORT_MAX_SHEETS = 20;
export const TASK_IMPORT_MAX_COLUMNS = 20;
export const TASK_IMPORT_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const TASK_IMPORT_MAX_EXPANDED_BYTES = 50 * 1024 * 1024;

export const recurrenceLabels: Record<Frequency, string> = {
  daily: "Daily",
  every_other_day: "Alternate days",
  weekly: "Weekly",
  semimonthly: "Semi-monthly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  semiannually: "Bi-yearly",
  annually: "Yearly",
};

export const priorityLabels: Record<Priority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

export type WorkbookTaskRow = {
  reference?: string | null;
  title: string;
  description?: string | null;
  notes?: string | null;
  recurrence?: Frequency | null;
  dueDate?: number | null;
  priority?: Priority | null;
  time?: string | null;
  quantity?: number | null;
  assigneeEmails?: string | null;
  isActive?: boolean | null;
  evidenceRequired?: boolean | null;
};

export type ExportTask = WorkbookTaskRow & { reference: string };

export type WorkbookMetadata = {
  format: string;
  version: number;
  kind: TaskImportKind;
  companyId: string;
  companyName: string;
  exportedAt: string;
};

export type ParsedWorkbook = {
  rows: TaskImportDraft[];
};

// "Is Active" and "Evidence Required" trail the JD headers so older sheets
// without them still parse; export always writes both and import treats them
// as optional. Optional columns are resolved by header name where possible,
// because deleting an earlier optional column shifts later ones.
const jdRequiredHeaderCount = 8;
const evidenceFallbackIndex = 9;
const jdHeaders = ["Code", "Title", "Description", "Notes", "Frequency", "Time", "Quantity", "Assignee Emails", "Is Active", "Evidence Required"] as const;
const oneTimeHeaders = ["Code", "Title", "Description", "Notes", "Due Date", "Priority", "Time", "Quantity", "Assignee Emails", "Evidence Required"] as const;
// "Evidence Required" trails the one-time headers for the same reason.
const oneTimeRequiredHeaderCount = oneTimeHeaders.length - 1;

const metadataKeyAliases: Record<string, keyof WorkbookMetadata> = {
  format: "format",
  "format identifier": "format",
  "schema version": "version",
  version: "version",
  "task kind": "kind",
  "source company id": "companyId",
  "company id": "companyId",
  "source company name": "companyName",
  "company name": "companyName",
  "export timestamp": "exportedAt",
};

export function taskSheetName(kind: TaskImportKind) {
  return kind === "jd" ? "JD Tasks" : "One-Time Tasks";
}

export function expectedHeaders(kind: TaskImportKind) {
  return kind === "jd" ? [...jdHeaders] : [...oneTimeHeaders];
}

export function normalizeHeader(value: unknown) {
  return scalarText(value).toLowerCase().replace(/[\s_-]+/g, " ").trim();
}

export function protectFormulaText(value: string) {
  const text = value;
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

export function unprotectFormulaText(value: string) {
  return /^'[=+\-@]/.test(value) ? value.slice(1) : value;
}

export function scalarText(value: unknown) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function sourceText(value: unknown) {
  return unprotectFormulaText(scalarText(value));
}

export function parseAssigneeEmails(value: unknown) {
  const raw = sourceText(value);
  const emails = raw.split(";").map((part) => part.trim().toLowerCase()).filter(Boolean);
  return { raw, emails };
}

export function normalizeFrequency(value: unknown): Frequency | null {
  const normalized = normalizeEnumToken(value);
  const aliases: Record<string, Frequency> = {
    daily: "daily",
    day: "daily",
    everyday: "daily",
    everyotherday: "every_other_day",
    alternate: "every_other_day",
    alternatedays: "every_other_day",
    everyother: "every_other_day",
    weekly: "weekly",
    week: "weekly",
    semimonthly: "semimonthly",
    semimonth: "semimonthly",
    "twiceamonth": "semimonthly",
    monthly: "monthly",
    month: "monthly",
    quarterly: "quarterly",
    quarter: "quarterly",
    qtr: "quarterly",
    every3months: "quarterly",
    everythreemonths: "quarterly",
    semiannually: "semiannually",
    semiannual: "semiannually",
    biannual: "semiannually",
    biyearly: "semiannually",
    annually: "annually",
    annual: "annually",
    yearly: "annually",
    year: "annually",
  };
  return aliases[normalized] ?? null;
}

export function normalizePriority(value: unknown): Priority | null {
  const normalized = normalizeEnumToken(value);
  const aliases: Record<string, Priority> = { low: "low", l: "low", medium: "medium", med: "medium", m: "medium", high: "high", h: "high", critical: "critical", crit: "critical", c: "critical" };
  return aliases[normalized] ?? null;
}

function normalizeEnumToken(value: unknown) {
  return scalarText(value).toLowerCase().replace(/[\s_\-/]+/g, "");
}

export function parseStrictDate(value: unknown): { value: number | null; error?: string } {
  if (value === null || value === undefined || value === "") return { value: null };
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? { value: null, error: "Invalid spreadsheet date." } : { value: time };
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return { value: null, error: "Numeric due dates must be stored as real Excel dates." };
  }
  const text = scalarText(value);
  if (!text) return { value: null };
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(text)) {
    const [, first, second] = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text)!;
    const a = Number(first);
    const b = Number(second);
    if (a <= 12 && b <= 12) return { value: null, error: "Ambiguous due date; use an Excel date or an unambiguous YYYY-MM-DD value." };
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (!match) return { value: null, error: "Due date must be an Excel date or YYYY-MM-DD." };
  const [, year, month, day, hours = "23", minutes = "59", seconds = "59"] = match;
  if (Number(hours) > 23 || Number(minutes) > 59 || Number(seconds) > 59) return { value: null, error: "Invalid due date." };
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hours), Number(minutes), Number(seconds), 0);
  if (date.getFullYear() !== Number(year) || date.getMonth() !== Number(month) - 1 || date.getDate() !== Number(day)) return { value: null, error: "Invalid due date." };
  return { value: date.getTime() };
}

export function isFormulaLikeValue(value: unknown) {
  return typeof value === "string" && /^[=+\-@]/.test(value);
}

export function rowHasValues(row: readonly unknown[]) {
  return row.some((cell) => cell !== null && cell !== undefined && scalarText(cell) !== "");
}

export function duplicateReferences(rows: readonly Pick<TaskImportDraft, "reference">[]) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const reference = row.reference?.trim().toUpperCase();
    if (reference) counts.set(reference, (counts.get(reference) ?? 0) + 1);
  }
  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([reference]) => reference));
}

export function buildExportMetadata(kind: TaskImportKind, companyId: string, companyName: string, exportedAt: string): WorkbookMetadata {
  return { format: TASK_IMPORT_FORMAT, version: TASK_IMPORT_SCHEMA_VERSION, kind, companyId, companyName, exportedAt };
}

function metadataFromRows(rows: SheetData): WorkbookMetadata | null {
  const metadata: Partial<WorkbookMetadata> = {};
  for (const row of rows) {
    if (!row || !row[0]) continue;
    const key = metadataKeyAliases[normalizeHeader(row[0])];
    if (!key) continue;
    const value = row[1];
    if (key === "version") metadata.version = Number(value);
    else if (key === "kind") metadata.kind = scalarText(value) as TaskImportKind;
    else metadata[key] = scalarText(value) as never;
  }
  if (!metadata.format || !metadata.version || !metadata.kind || !metadata.companyId || !metadata.companyName || !metadata.exportedAt) return null;
  const parsed = { ...metadata } as WorkbookMetadata;
  return parsed;
}

function findHeaderRow(rows: SheetData, kind: TaskImportKind) {
  const headers = expectedHeaders(kind).map(normalizeHeader);
  const required = kind === "jd" ? jdRequiredHeaderCount : oneTimeRequiredHeaderCount;
  return rows.findIndex((row) =>
    headers.slice(0, required).every((header, index) => {
      const cell = normalizeHeader(row[index]);
      if (index === 0) return cell === "code" || cell === "reference";
      return cell === header;
    })
  );
}

type OptionalColumn = { index: number; state: "present" | "unrecognized" | "absent" };

function headerIndex(row: readonly unknown[], name: string) {
  return row.findIndex((cell) => normalizeHeader(cell) === name);
}

// The legacy "Status" column from older exports is silently ignored; any
// other nonempty ninth header (e.g. a misspelled "Is Actve") is flagged per
// row so lifecycle edits cannot vanish without a warning. A sheet whose
// optional Is Active column was deleted may hold "Evidence Required" in that
// slot, which is not an active-state header and must stay quiet.
function activeColumnState(row: readonly unknown[], kind: TaskImportKind): OptionalColumn {
  if (kind !== "jd") return { index: jdRequiredHeaderCount, state: "absent" };
  const found = headerIndex(row, "is active");
  if (found >= 0) return { index: found, state: "present" };
  const header = normalizeHeader(row[jdRequiredHeaderCount]);
  return {
    index: jdRequiredHeaderCount,
    state: header === "" || header === "status" || header === "evidence required" ? "absent" : "unrecognized",
  };
}

// "Evidence Required" is optional for both kinds and resolved by name so it
// survives optional-column shifts. When the header is missing, a nonempty
// value in its usual slot is surfaced so the dropped value is not silent.
function evidenceColumnState(row: readonly unknown[]): OptionalColumn {
  const found = headerIndex(row, "evidence required");
  if (found >= 0) return { index: found, state: "present" };
  const header = normalizeHeader(row[evidenceFallbackIndex]);
  return { index: evidenceFallbackIndex, state: header === "" ? "absent" : "unrecognized" };
}

function valueAt(row: readonly unknown[], index: number) {
  return row[index] ?? null;
}

function normalizeYesNo(value: unknown): boolean | null {
  const normalized = normalizeEnumToken(value);
  if (normalized === "yes") return true;
  if (normalized === "no") return false;
  return null;
}

function makeDraft(kind: TaskImportKind, sourceSheet: string, sourceRow: number, row: readonly unknown[], activeColumn: OptionalColumn, evidenceColumn: OptionalColumn): TaskImportDraft {
  const referenceResult = referenceForKind(sourceText(valueAt(row, 0)), kind);
  const assignees = parseAssigneeEmails(sourceText(valueAt(row, kind === "jd" ? 7 : 8)));
  const title = sourceText(valueAt(row, 1)) || null;
  const description = sourceText(valueAt(row, 2)) || null;
  const notes = sourceText(valueAt(row, 3)) || null;
  const time = sourceText(valueAt(row, kind === "jd" ? 5 : 6)) || null;
  const quantityText = sourceText(valueAt(row, kind === "jd" ? 6 : 7));
  const quantity = quantityText ? Number(quantityText) : null;
  const validQuantity = typeof quantity === "number" && Number.isFinite(quantity) && quantity > 0 ? quantity : null;
  const parsedDate = kind === "one_time" ? parseStrictDate(valueAt(row, 4)) : { value: null };
  const recurrence = kind === "jd" ? normalizeFrequency(valueAt(row, 4)) : null;
  const priority = kind === "one_time" ? normalizePriority(valueAt(row, 5)) : null;
  const activeCellText = activeColumn.state === "absent" ? "" : sourceText(valueAt(row, activeColumn.index));
  const isActiveText = activeColumn.state === "present" ? activeCellText : "";
  const isActive = isActiveText ? normalizeYesNo(isActiveText) : null;
  const evidenceCellText = sourceText(valueAt(row, evidenceColumn.index));
  const evidenceText = evidenceColumn.state === "present" ? evidenceCellText : "";
  const evidenceRequired = evidenceText ? normalizeYesNo(evidenceText) : null;
  const warnings = [
    ...(referenceResult.error ? [referenceResult.error] : []),
    ...(parsedDate.error ? [parsedDate.error] : []),
    ...(quantityText && (validQuantity === null) ? ["Quantity must be a positive number."] : []),
    ...(kind === "jd" && sourceText(valueAt(row, 4)) && !recurrence ? ["Frequency is not a supported canonical value."] : []),
    ...(kind === "one_time" && sourceText(valueAt(row, 5)) && !priority ? ["Priority is not a supported canonical value."] : []),
    ...(isActiveText && isActive === null ? ["Is active must be Yes or No."] : []),
    ...(activeColumn.state === "unrecognized" && activeCellText ? [`Column ${activeColumn.index + 1} has a value but its header is not "Is Active"; the value was ignored.`] : []),
    ...(evidenceText && evidenceRequired === null ? ["Evidence required must be Yes or No."] : []),
    ...(evidenceColumn.state !== "present" && evidenceCellText ? [`Column ${evidenceColumn.index + 1} has a value but its header is not "Evidence Required"; the value was ignored.`] : []),
    ...(isFormulaLikeValue(valueAt(row, 0)) || isFormulaLikeValue(valueAt(row, 1)) ? ["Formula-like text was rejected as an input value."] : []),
  ];
  const presentFields = [
    ...(sourceText(valueAt(row, 0)) ? ["reference"] : []),
    "title",
    "description",
    "notes",
    ...(kind === "jd" ? ["recurrence"] : ["dueDate", "priority"]),
    "time",
    "quantity",
    "assignees",
    ...(isActiveText ? ["isActive"] : []),
    ...(evidenceText ? ["evidenceRequired"] : []),
  ] as TaskImportDraft["presentFields"];
  return taskImportDraftSchema.parse({
    rowKey: `${sourceSheet}:${sourceRow}`,
    sourceSheet,
    sourceRow,
    source: "cendro",
    kind,
    reference: referenceResult.value,
    title,
    description,
    notes,
    recurrence,
    dueDate: parsedDate.value,
    priority,
    time,
    quantity: validQuantity,
    rawAssigneeText: assignees.raw,
    assigneeEmails: assignees.emails,
    status: null,
    isActive,
    evidenceRequired,
    presentFields,
    warnings,
  });
}

function parseTaskSheet(rows: SheetData, kind: TaskImportKind, sheetName: string) {
  const headerIndex = findHeaderRow(rows, kind);
  if (headerIndex < 0) return { rows: [] as TaskImportDraft[], headerIndex };
  const activeColumn = activeColumnState(rows[headerIndex], kind);
  const evidenceColumn = evidenceColumnState(rows[headerIndex]);
  const drafts = rows.slice(headerIndex + 1).map((row, index) => ({ row, index })).filter(({ row }) => rowHasValues(row)).map(({ row, index }) => makeDraft(kind, sheetName, headerIndex + index + 2, row, activeColumn, evidenceColumn));
  return { rows: drafts, headerIndex };
}

export function parseCendroWorkbookSheets(sheets: readonly { sheet: string; data: SheetData }[], activeCompanyId: string, kind: TaskImportKind): ParsedWorkbook {
  const metadataSheet = sheets.find((sheet) => sheet.sheet === "Cendro Metadata");
  const taskSheet = sheets.find((sheet) => sheet.sheet === taskSheetName(kind));
  const metadata = metadataSheet ? metadataFromRows(metadataSheet.data) : null;
  if (!metadata || metadata.format !== TASK_IMPORT_FORMAT) {
    throw new Error("This file is not a valid Cendro task workbook. Export a Cendro workbook first to get the correct template.");
  }
  if (!taskSheet) throw new Error(`This workbook does not contain the ${taskSheetName(kind)} sheet for the selected task page.`);
  if (metadata.version !== TASK_IMPORT_SCHEMA_VERSION) throw new Error("This Cendro workbook uses an unsupported schema version.");
  if (metadata.kind !== kind) throw new Error("This workbook belongs to a different task kind.");
  if (metadata.companyId !== activeCompanyId) throw new Error("This workbook belongs to another company.");
  const parsed = parseTaskSheet(taskSheet.data, kind, taskSheet.sheet);
  if (parsed.headerIndex < 0) throw new Error("The Cendro task sheet headers do not match this version.");
  if (parsed.rows.length === 0) throw new Error("The Cendro task sheet contains no task rows to import.");
  if (parsed.rows.length > TASK_IMPORT_MAX_ROWS) throw new Error(`A standard import may contain at most ${TASK_IMPORT_MAX_ROWS} task rows.`);
  const duplicateRefs = duplicateReferences(parsed.rows);
  const rows = parsed.rows.map((row) => duplicateRefs.has(row.reference?.toUpperCase() ?? "") ? { ...row, warnings: [...row.warnings, "Duplicate reference in workbook."] } : row);
  return { rows };
}

export function formulaCellsInXml(xml: string) {
  return /<f(?:\s|>)/i.test(xml);
}

export async function preflightWorkbook(file: Blob) {
  let expandedBytes = 0;
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: (entry) => {
    expandedBytes += entry.originalSize;
    if (expandedBytes > TASK_IMPORT_MAX_EXPANDED_BYTES) throw new Error("Workbook expands beyond the supported size limit.");
    return entry.name === "xl/workbook.xml" || /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry.name) || /vbaProject\.bin$/i.test(entry.name);
  } });
  if (Object.keys(entries).some((path) => /vbaProject\.bin$/i.test(path))) throw new Error("Macro-enabled workbook content is not supported. Save a macro-free copy as .xlsx first.");
  const workbookXml = entries["xl/workbook.xml"] ? strFromU8(entries["xl/workbook.xml"]) : "";
  const sheetCount = (workbookXml.match(/<sheet\b/gi) ?? []).length;
  if (!workbookXml || sheetCount === 0) throw new Error("This file is not a readable .xlsx workbook.");
  if (sheetCount > TASK_IMPORT_MAX_SHEETS) throw new Error(`Workbook may contain at most ${TASK_IMPORT_MAX_SHEETS} sheets.`);
  for (const [path, bytes] of Object.entries(entries)) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/i.test(path)) continue;
    const xml = strFromU8(bytes);
    if (formulaCellsInXml(xml)) throw new Error("This workbook contains formula cells. Replace formulas with pasted literal values before importing.");
  }
  return entries;
}

export async function parseWorkbook(file: File, activeCompanyId: string, kind: TaskImportKind): Promise<ParsedWorkbook> {
  validateWorkbookFile(file);
  if (file.size > TASK_IMPORT_MAX_FILE_BYTES) throw new Error("Workbook must be 10 MB or smaller.");
  await preflightWorkbook(file);
  const sheets = await readXlsxFile(file);
  return parseCendroWorkbookSheets(sheets, activeCompanyId, kind);
}

export function validateWorkbookFile(file: Pick<File, "name" | "size" | "type">) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".xls") || name.endsWith(".xlsm")) throw new Error("Legacy .xls and macro-enabled .xlsm files are not supported. Save a copy as .xlsx first.");
  if (!name.endsWith(".xlsx")) throw new Error("Choose an .xlsx workbook.");
}

function textCell(value: unknown) {
  return { value: protectFormulaText(scalarText(value)), type: String };
}

function dateCell(value: number | null | undefined) {
  return value == null ? null : { value: new Date(value), type: Date, format: "yyyy-mm-dd hh:mm" };
}

function taskRows(kind: TaskImportKind, tasks: readonly ExportTask[]): WriteSheetData {
  const headers = expectedHeaders(kind).map((value) => ({ value, fontWeight: "bold" as const, backgroundColor: "#EDEBE6" }));
  const rows: WriteSheetData = [headers];
  for (const task of tasks) {
    const evidenceCell = textCell(task.evidenceRequired === true ? "Yes" : "No");
    const values: Cell[] = kind === "jd"
      ? [textCell(task.reference), textCell(task.title), textCell(task.description), textCell(task.notes), textCell(task.recurrence), textCell(task.time), task.quantity == null ? null : { value: task.quantity, type: Number }, textCell(task.assigneeEmails), textCell(task.isActive === false ? "No" : "Yes"), evidenceCell]
      : [textCell(task.reference), textCell(task.title), textCell(task.description), textCell(task.notes), dateCell(task.dueDate), textCell(task.priority), textCell(task.time), task.quantity == null ? null : { value: task.quantity, type: Number }, textCell(task.assigneeEmails), evidenceCell];
    rows.push(values);
  }
  return rows;
}

function metadataRows(metadata: WorkbookMetadata): WriteSheetData {
  return [
    [textCell("Format identifier"), textCell(metadata.format)],
    [textCell("Schema version"), { value: metadata.version, type: Number }],
    [textCell("Task kind"), textCell(metadata.kind)],
    [textCell("Source company ID"), textCell(metadata.companyId)],
    [textCell("Source company name"), textCell(metadata.companyName)],
    [textCell("Export timestamp"), textCell(metadata.exportedAt)],
    [],
    [textCell("Instructions"), textCell("Edit task fields. Use task code to create or update tasks. If the code exists, the task is updated; if not, a new task is created with that code. Blank assignee cells preserve existing assignees; new tasks need an assignee.")],
    [textCell("Frequency values"), textCell(Object.entries(recurrenceLabels).map(([key, label]) => `${key} = ${label}`).join("; "))],
    [textCell("Priority values"), textCell(Object.entries(priorityLabels).map(([key, label]) => `${key} = ${label}`).join("; "))],
    [textCell("Is active values"), textCell("JD tasks only: Yes or No. No makes the task inactive; blank leaves the current state unchanged.")],
    [textCell("Evidence required values"), textCell("Yes or No. Blank leaves the current state unchanged; new tasks default to No.")],
  ];
}

export async function exportTaskWorkbook(kind: TaskImportKind, companyId: string, companyName: string, tasks: readonly ExportTask[]) {
  const metadata = buildExportMetadata(kind, companyId, companyName, new Date().toISOString());
  return await writeXlsxFile([
    { sheet: taskSheetName(kind), data: taskRows(kind, tasks), columns: expectedHeaders(kind).map((header) => ({ width: Math.max(header.length + 2, 16) })), stickyRowsCount: 1, dateFormat: "yyyy-mm-dd hh:mm" },
    { sheet: "Cendro Metadata", data: metadataRows(metadata), columns: [{ width: 24 }, { width: 100 }] },
  ]);
}

export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

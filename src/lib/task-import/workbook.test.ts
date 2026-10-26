import readXlsxFile from "read-excel-file/browser";
import { describe, expect, test } from "vitest";
import {
  buildExportMetadata,
  formulaCellsInXml,
  duplicateReferences,
  exportTaskWorkbook,
  parseCendroWorkbookSheets,
  normalizeFrequency,
  normalizePriority,
  parseStrictDate,
  parseAssigneeEmails,
  protectFormulaText,
} from "./workbook";
import { referenceForKind } from "./schema";

describe("task workbook pure helpers", () => {
  test("normalizes canonical enum aliases", () => {
    expect(normalizeFrequency("Every other day")).toBe("every_other_day");
    expect(normalizeFrequency("qtr")).toBe("quarterly");
    expect(normalizeFrequency("bi-yearly")).toBe("semiannually");
    expect(normalizePriority("MED")).toBe("medium");
    expect(normalizePriority("Critical")).toBe("critical");
    expect(normalizePriority("CRIT")).toBe("critical");
    expect(normalizePriority("urgent")).toBeNull();
  });

  test("rejects ambiguous dates and accepts unambiguous dates", () => {
    expect(parseStrictDate("01/02/2026").error).toMatch(/Ambiguous/);
    const parsed = new Date(parseStrictDate("2026-02-01").value!);
    expect([parsed.getFullYear(), parsed.getMonth(), parsed.getDate()]).toEqual([2026, 1, 1]);
    expect([parsed.getHours(), parsed.getMinutes(), parsed.getSeconds()]).toEqual([23, 59, 59]);
    expect(parseStrictDate("2026-02-01 25:00").error).toBe("Invalid due date.");
  });

  test("normalizes semicolon separated emails without fuzzy names", () => {
    expect(parseAssigneeEmails(" A@Example.com; b@example.com; ")).toEqual({ raw: "A@Example.com; b@example.com;", emails: ["a@example.com", "b@example.com"] });
  });

  test("protects formula-leading text and validates references", () => {
    expect(protectFormulaText("=1+1")).toBe("'=1+1");
    expect(referenceForKind("JD-001", "jd")).toEqual({ value: "JD-001" });
    expect(referenceForKind("JD-0001", "jd")).toEqual({ value: "JD-0001" });
    expect(referenceForKind("JD-10000", "jd")).toEqual({ value: "JD-10000" });
    expect(referenceForKind("TSK-001", "jd").error).toBeTruthy();
    expect(referenceForKind("OT-001", "jd").error).toBeTruthy();
    expect(referenceForKind("TSK-001", "one_time")).toEqual({ value: "TSK-001" });
    expect(referenceForKind("OT-0001", "one_time")).toEqual({ value: "OT-0001" });
    expect(referenceForKind("", "jd").error).toBe("Task code is required and must match JD-001.");
    expect(referenceForKind(null, "one_time").error).toBe("Task code is required and must match TSK-001.");
    expect(referenceForKind("INVALID", "jd").error).toBe("Code must match JD-001.");
    expect(referenceForKind("JD-1", "jd").error).toBe("Code must match JD-001.");
    expect(referenceForKind("JD-9007199254740992", "jd").error).toBe("Code must match JD-001.");
    expect(referenceForKind("JD-99999999999999999999", "jd").error).toBe("Code must match JD-001.");
  });

  test("finds duplicate workbook references", () => {
    expect(duplicateReferences([{ reference: "JD-001" }, { reference: "jd-001" }, { reference: null }])).toEqual(new Set(["JD-001"]));
  });

  test("rejects formula XML rather than executing it", () => {
    expect(formulaCellsInXml("<worksheet><c r=\"A1\"><f>1+1</f><v>2</v></c></worksheet>")).toBe(true);
    expect(formulaCellsInXml("<worksheet><c r=\"A1\"><v>2</v></c></worksheet>")).toBe(false);
  });

  test("builds versioned metadata", () => {
    expect(buildExportMetadata("one_time", "company-1", "Acme", "2026-01-01T00:00:00.000Z")).toMatchObject({ format: "cendro-task-export", version: 1, kind: "one_time" });
  });

  test("rejects invalid metadata from an unsupported workbook", () => {
    expect(() => parseCendroWorkbookSheets([
      { sheet: "Cendro Metadata", data: [["Format identifier", "other-format"], ["Schema version", 1], ["Task kind", "jd"], ["Source company ID", "company-1"], ["Source company name", "Acme"], ["Export timestamp", "2026-01-01T00:00:00.000Z"]] },
      { sheet: "JD Tasks", data: [["Reference", "Title", "Description", "Notes", "Frequency", "Time", "Quantity", "Assignee Emails", "Status"]] },
    ], "company-1", "jd")).toThrow(/not a valid Cendro task workbook/);
  });

  test("exports and parses a Cendro workbook without task IDs or a Status column", async () => {
    const workbook = await exportTaskWorkbook("one_time", "company-1", "Acme", [
      { reference: "TSK-001", title: "=literal text", description: "Body", notes: "Important note", dueDate: Date.UTC(2026, 1, 1, 23, 59, 59), priority: "high", time: "30m", quantity: 2, assigneeEmails: "a@example.com", evidenceRequired: true },
      { reference: "TSK-002", title: "Critical task", priority: "critical" },
    ]);
    const sheets = await readXlsxFile(await workbook.toBlob());
    const taskSheet = sheets.find((sheet) => sheet.sheet === "One-Time Tasks")!;
    expect(taskSheet.data[0]).toEqual(["Code", "Title", "Description", "Notes", "Due Date", "Priority", "Time", "Quantity", "Assignee Emails", "Evidence Required"]);
    expect(taskSheet.data[1][9]).toBe("Yes");
    expect(taskSheet.data[2][9]).toBe("No");
    const parsed = parseCendroWorkbookSheets(sheets, "company-1", "one_time");
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({ reference: "TSK-001", title: "=literal text", description: "Body", notes: "Important note", priority: "high", quantity: 2, assigneeEmails: ["a@example.com"], status: null, evidenceRequired: true });
    expect(parsed.rows[0].dueDate).toBeTypeOf("number");
    expect(parsed.rows[1]).toMatchObject({ reference: "TSK-002", title: "Critical task", priority: "critical", status: null, evidenceRequired: false });
  });

  test("exports and parses a JD task workbook preserving description, notes and active state", async () => {
    const workbook = await exportTaskWorkbook("jd", "company-1", "Acme", [
      { reference: "JD-001", title: "Daily maintenance", description: "Inspect equipment", notes: "Check oil level", recurrence: "daily", time: "1h", quantity: 1, assigneeEmails: "admin@example.com", isActive: true, evidenceRequired: true },
      { reference: "JD-002", title: "Paused checklist", recurrence: "weekly", isActive: false },
    ]);
    const sheets = await readXlsxFile(await workbook.toBlob());
    const taskSheet = sheets.find((sheet) => sheet.sheet === "JD Tasks")!;
    expect(taskSheet.data[0]).toEqual(["Code", "Title", "Description", "Notes", "Frequency", "Time", "Quantity", "Assignee Emails", "Is Active", "Evidence Required"]);
    expect(taskSheet.data[1][8]).toBe("Yes");
    expect(taskSheet.data[2][8]).toBe("No");
    expect(taskSheet.data[1][9]).toBe("Yes");
    expect(taskSheet.data[2][9]).toBe("No");
    const parsed = parseCendroWorkbookSheets(sheets, "company-1", "jd");
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({ reference: "JD-001", title: "Daily maintenance", description: "Inspect equipment", notes: "Check oil level", recurrence: "daily", status: null, isActive: true, evidenceRequired: true });
    expect(parsed.rows[0].presentFields).toContain("isActive");
    expect(parsed.rows[0].presentFields).toContain("evidenceRequired");
    expect(parsed.rows[1]).toMatchObject({ reference: "JD-002", isActive: false, evidenceRequired: false });
  });

  test("parses older JD sheets without an Is active column", () => {
    const parsed = parseCendroWorkbookSheets([
      { sheet: "Cendro Metadata", data: [["Format identifier", "cendro-task-export"], ["Schema version", 1], ["Task kind", "jd"], ["Source company ID", "company-1"], ["Source company name", "Acme"], ["Export timestamp", "2026-01-01T00:00:00.000Z"]] },
      { sheet: "JD Tasks", data: [["Code", "Title", "Description", "Notes", "Frequency", "Time", "Quantity", "Assignee Emails"], ["JD-001", "Daily maintenance", "", "", "daily", "", "", "admin@example.com"]] },
    ], "company-1", "jd");
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({ reference: "JD-001", isActive: null });
    expect(parsed.rows[0].presentFields).not.toContain("isActive");
  });

  test("flags an invalid Is active value on a JD row", () => {
    const parsed = parseCendroWorkbookSheets([
      { sheet: "Cendro Metadata", data: [["Format identifier", "cendro-task-export"], ["Schema version", 1], ["Task kind", "jd"], ["Source company ID", "company-1"], ["Source company name", "Acme"], ["Export timestamp", "2026-01-01T00:00:00.000Z"]] },
      { sheet: "JD Tasks", data: [["Code", "Title", "Description", "Notes", "Frequency", "Time", "Quantity", "Assignee Emails", "Is Active"], ["JD-001", "Daily maintenance", "", "", "daily", "", "", "admin@example.com", "maybe"]] },
    ], "company-1", "jd");
    expect(parsed.rows[0]).toMatchObject({ reference: "JD-001", isActive: null });
    expect(parsed.rows[0].presentFields).toContain("isActive");
    expect(parsed.rows[0].warnings).toContain("Is active must be Yes or No.");
  });

  test("warns when a ninth-column value sits under an unrecognized header", () => {
    const parsed = parseCendroWorkbookSheets([
      { sheet: "Cendro Metadata", data: [["Format identifier", "cendro-task-export"], ["Schema version", 1], ["Task kind", "jd"], ["Source company ID", "company-1"], ["Source company name", "Acme"], ["Export timestamp", "2026-01-01T00:00:00.000Z"]] },
      { sheet: "JD Tasks", data: [["Code", "Title", "Description", "Notes", "Frequency", "Time", "Quantity", "Assignee Emails", "Is Actve"], ["JD-001", "Daily maintenance", "", "", "daily", "", "", "admin@example.com", "No"], ["JD-002", "Other", "", "", "weekly", "", "", "admin@example.com", ""]] },
    ], "company-1", "jd");
    expect(parsed.rows).toHaveLength(2);
    // The unrecognized column is not applied, but the dropped value is surfaced.
    expect(parsed.rows[0]).toMatchObject({ reference: "JD-001", isActive: null });
    expect(parsed.rows[0].presentFields).not.toContain("isActive");
    expect(parsed.rows[0].warnings).toContain("Column 9 has a value but its header is not \"Is Active\"; the value was ignored.");
    // Rows with an empty cell under the unrecognized header lose nothing and stay quiet.
    expect(parsed.rows[1].warnings).toHaveLength(0);
  });

  test("parses Evidence Required case-insensitively, treats blank as absent, and warns on invalid values", () => {
    const parsed = parseCendroWorkbookSheets([
      { sheet: "Cendro Metadata", data: [["Format identifier", "cendro-task-export"], ["Schema version", 1], ["Task kind", "one_time"], ["Source company ID", "company-1"], ["Source company name", "Acme"], ["Export timestamp", "2026-01-01T00:00:00.000Z"]] },
      { sheet: "One-Time Tasks", data: [
        ["Code", "Title", "Description", "Notes", "Due Date", "Priority", "Time", "Quantity", "Assignee Emails", "Evidence Required"],
        ["TSK-001", "Yes task", "", "", "", "medium", "", "", "admin@example.com", "YES"],
        ["TSK-002", "No task", "", "", "", "medium", "", "", "admin@example.com", "no"],
        ["TSK-003", "Blank task", "", "", "", "medium", "", "", "admin@example.com", ""],
        ["TSK-004", "Invalid task", "", "", "", "medium", "", "", "admin@example.com", "maybe"],
      ] },
    ], "company-1", "one_time");
    expect(parsed.rows[0]).toMatchObject({ evidenceRequired: true });
    expect(parsed.rows[0].presentFields).toContain("evidenceRequired");
    expect(parsed.rows[1]).toMatchObject({ evidenceRequired: false });
    // A blank cell leaves the field absent so an update preserves it.
    expect(parsed.rows[2]).toMatchObject({ evidenceRequired: null });
    expect(parsed.rows[2].presentFields).not.toContain("evidenceRequired");
    expect(parsed.rows[3]).toMatchObject({ evidenceRequired: null });
    expect(parsed.rows[3].presentFields).toContain("evidenceRequired");
    expect(parsed.rows[3].warnings).toContain("Evidence required must be Yes or No.");
  });

  test("resolves Evidence Required by header when the optional Is Active column is absent", () => {
    const parsed = parseCendroWorkbookSheets([
      { sheet: "Cendro Metadata", data: [["Format identifier", "cendro-task-export"], ["Schema version", 1], ["Task kind", "jd"], ["Source company ID", "company-1"], ["Source company name", "Acme"], ["Export timestamp", "2026-01-01T00:00:00.000Z"]] },
      { sheet: "JD Tasks", data: [
        ["Code", "Title", "Description", "Notes", "Frequency", "Time", "Quantity", "Assignee Emails", "Evidence Required"],
        ["JD-001", "Daily maintenance", "", "", "daily", "", "", "admin@example.com", "Yes"],
      ] },
    ], "company-1", "jd");
    expect(parsed.rows[0]).toMatchObject({ reference: "JD-001", isActive: null, evidenceRequired: true });
    expect(parsed.rows[0].presentFields).toContain("evidenceRequired");
    // The shifted column is the evidence header, not a broken Is Active header.
    expect(parsed.rows[0].warnings).toEqual([]);
  });

  test("warns when a tenth-column Evidence value sits under an unrecognized header", () => {
    const parsed = parseCendroWorkbookSheets([
      { sheet: "Cendro Metadata", data: [["Format identifier", "cendro-task-export"], ["Schema version", 1], ["Task kind", "one_time"], ["Source company ID", "company-1"], ["Source company name", "Acme"], ["Export timestamp", "2026-01-01T00:00:00.000Z"]] },
      { sheet: "One-Time Tasks", data: [
        ["Code", "Title", "Description", "Notes", "Due Date", "Priority", "Time", "Quantity", "Assignee Emails", "Evidence"],
        ["TSK-001", "Dropped value", "", "", "", "medium", "", "", "admin@example.com", "Yes"],
        ["TSK-002", "Empty value", "", "", "", "medium", "", "", "admin@example.com", ""],
      ] },
    ], "company-1", "one_time");
    expect(parsed.rows[0]).toMatchObject({ evidenceRequired: null });
    expect(parsed.rows[0].presentFields).not.toContain("evidenceRequired");
    expect(parsed.rows[0].warnings).toContain("Column 10 has a value but its header is not \"Evidence Required\"; the value was ignored.");
    expect(parsed.rows[1].warnings).toHaveLength(0);
  });

  test("warns when a tenth-column value sits under a missing Evidence Required header", () => {
    const parsed = parseCendroWorkbookSheets([
      { sheet: "Cendro Metadata", data: [["Format identifier", "cendro-task-export"], ["Schema version", 1], ["Task kind", "one_time"], ["Source company ID", "company-1"], ["Source company name", "Acme"], ["Export timestamp", "2026-01-01T00:00:00.000Z"]] },
      { sheet: "One-Time Tasks", data: [
        ["Code", "Title", "Description", "Notes", "Due Date", "Priority", "Time", "Quantity", "Assignee Emails"],
        ["TSK-001", "Dropped value", "", "", "", "medium", "", "", "admin@example.com", "Yes"],
        ["TSK-002", "Empty value", "", "", "", "medium", "", "", "admin@example.com", ""],
      ] },
    ], "company-1", "one_time");
    // The absent column is still not imported, but its dropped value is surfaced.
    expect(parsed.rows[0]).toMatchObject({ evidenceRequired: null });
    expect(parsed.rows[0].presentFields).not.toContain("evidenceRequired");
    expect(parsed.rows[0].warnings).toContain("Column 10 has a value but its header is not \"Evidence Required\"; the value was ignored.");
    expect(parsed.rows[1].warnings).toHaveLength(0);
  });

  test("handles sheets with trailing empty rows like Google Sheets exports and ignores an old Status column", () => {
    const emptyRows = Array.from({ length: 998 }, () => [null, null, null, null, null, null, null, null, null]);
    const parsed = parseCendroWorkbookSheets([
      { sheet: "Cendro Metadata", data: [["Format identifier", "cendro-task-export"], ["Schema version", 1], ["Task kind", "jd"], ["Source company ID", "company-1"], ["Source company name", "Acme"], ["Export timestamp", "2026-01-01T00:00:00.000Z"], ...emptyRows] },
      { sheet: "JD Tasks", data: [["Reference", "Title", "Description", "Notes", "Frequency", "Time", "Quantity", "Assignee Emails", "Status"], ["JD-0001", "Updated Title in Google Sheets", "", "", "daily", "", null, "admin@example.com", "Completed"], ...emptyRows] },
    ], "company-1", "jd");
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].title).toBe("Updated Title in Google Sheets");
    expect(parsed.rows[0].reference).toBe("JD-0001");
    expect(parsed.rows[0].status).toBeNull();
    expect(parsed.rows[0].presentFields).not.toContain("status");
  });
});

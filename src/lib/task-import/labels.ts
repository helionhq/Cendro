import type { Frequency, Priority } from "./schema";

// Kept free of the workbook's Excel dependencies so UI code (the dashboard)
// can show the same labels without bundling the import/export stack.
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

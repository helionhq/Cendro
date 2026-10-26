import { afterEach, expect, test, vi } from "vitest";
import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getFunctionName } from "convex/server";
import type { OptimisticLocalStore } from "convex/browser";
import type { ListInsertion } from "@/lib/list-drag";
import { createMockElement } from "./test-dom";
import { TaskDetail, TaskList } from "./task-pages";
import OneTimeTasksLayout from "@/app/(app)/one-time-tasks/layout";

Object.assign(document, { createElementNS: (_namespace: string, tag: string) => createMockElement(tag) });
Object.assign(window, { matchMedia: () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }) });

const state = vi.hoisted(() => ({
  view: { orderedIds: ["A", "B", "C"], revision: 0 },
  pending: false,
  renderRows: false,
  taskIds: ["A", "B", "C"],
  taskStates: {} as Record<string, { status: string; rawStatus: string }>,
  dueDates: {} as Record<string, number>,
  serverTime: null as number | null,
  clockFails: false,
  clockRequests: 0,
  clockFailAfterFirst: false,
  clockWait: null as Promise<void> | null,
  statusWait: null as Promise<void> | null,
  detail: null as null | { task: { _id: string; title: string; createdAt: number; priority: string; dueDate: number; assigneeMembershipIds: string[]; evidenceRequired?: boolean; confirmerMembershipId?: string; confirmer?: unknown; state: { status: string; rawStatus: string; currentCycleStart?: number } }; canUpdate: boolean },
  otherAssigneeIds: [] as string[],
  evidenceRequired: [] as string[],
  evidenceResults: [] as unknown[],
  exported: [] as { evidenceRequired?: boolean }[],
  statusWrites: [] as { taskId: string; status: string; evidence?: unknown }[],
  assignable: [] as unknown[],
  confirmers: [] as unknown[],
  awaitingRows: [] as unknown[],
  createWrites: [] as Record<string, unknown>[],
  updateWrites: [] as Record<string, unknown>[],
  confirmWrites: [] as { requestId: string }[],
  sendBackWrites: [] as { requestId: string }[],
  pausedIds: [] as string[],
  lifecycleAllowed: true,
  capabilities: [] as string[],
  ignorePausedQuery: false,
  lifecycleWrites: [] as { taskIds: string[]; paused: boolean }[],
  railRows: new Map<string, () => void>(),
  selectMy: null as null | (() => void),
  selectAll: null as null | (() => void),
  selectAwaiting: null as null | (() => void),
  selects: new Map<string, () => void>(),
  checkboxes: new Map<string, { checked: boolean; onCheckedChange: (value: boolean) => void; onSelect?: (event: { preventDefault: () => void }) => void }>(),
  filterPaused: null as null | ((value: boolean) => void),
  drop: null as null | ((id: string, insertion: ListInsertion) => void),
  selectCustom: null as null | (() => void),
  writes: [] as { args: { orderedIds: string[]; expectedRevision: number }; resolve: (value: { orderedIds: string[]; revision: number }) => void }[],
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), useParams: () => ({ id: state.detail?.task._id }) }));
vi.mock("motion/react", () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  useReducedMotion: () => true,
  motion: { div: ({ children, className }: { children: ReactNode; className: string }) => React.createElement("div", { className }, children) },
}));
vi.mock("./company-context", () => ({ useCompany: () => ({
  activeCompanyId: "company", active: { membership: { _id: "member" }, company: { name: "Company" }, capabilities: state.capabilities },
}) }));
vi.mock("convex/react", () => {
  const getServerTime = async () => {
    state.clockRequests++;
    if (state.clockFails || (state.clockFailAfterFirst && state.clockRequests > 1)) throw new Error("Clock unavailable");
    const serverTime = state.serverTime ?? Date.now();
    if (state.clockWait) await state.clockWait;
    return serverTime;
  };
  return {
    useConvex: () => ({}),
    useQuery: (ref: Parameters<typeof getFunctionName>[0]) => {
      switch (getFunctionName(ref)) {
        case "tasks:getOneTime": return state.detail;
        case "tasks:getJd": return state.detail;
        case "tasks:getCustomView": return state.view;
        case "tasks:getListPreference": return { sort: { mode: "default" }, customOrder: null, revision: 0 };
        case "tasks:assignableUsers": return { users: state.assignable, isTruncated: false };
        case "tasks:eligibleConfirmers": return { users: state.confirmers, isTruncated: false };
        case "tasks:listAwaitingConfirmation": return { isTruncated: false, rows: state.awaitingRows };
        default: return [];
      }
    },
    usePaginatedQuery: (ref: Parameters<typeof getFunctionName>[0], args: { paused?: boolean }) => {
      if (getFunctionName(ref) === "tasks:getTaskEvidence") return { status: "Exhausted", loadMore: vi.fn(), results: state.evidenceResults };
      if (getFunctionName(ref) === "tasks:listAttachments") return { status: "Exhausted", loadMore: vi.fn(), results: [] };
      state.railRows.clear();
      state.selects.clear();
      state.checkboxes.clear();
      return { status: "Exhausted", loadMore: vi.fn(), results:
        [...(state.pending ? ["pending:new"] : []), ...state.taskIds]
          .filter((_id) => state.ignorePausedQuery || state.pausedIds.includes(_id) === Boolean(args.paused))
          .map((_id) => ({
            _id, reference: _id, title: _id, recurrence: _id === "B" ? "weekly" : "daily", priority: "low", createdAt: 1,
            dueDate: state.dueDates[_id],
            pausedAt: state.pausedIds.includes(_id) ? 1 : undefined,
            canPause: state.lifecycleAllowed, canResume: state.lifecycleAllowed,
            evidenceRequired: state.evidenceRequired.includes(_id) || undefined,
            assigneeMembershipIds: [state.otherAssigneeIds.includes(_id) ? "other" : "member"], assignees: [], state: state.taskStates[_id] ?? { status: "Due" },
          })),
      };
    },
    useMutation: (ref: Parameters<typeof getFunctionName>[0]) => {
      if (getFunctionName(ref) === "tasks:getServerTime") return getServerTime;
      if (getFunctionName(ref) === "tasks:updateOneTimeStatus") {
        type StatusArgs = { taskId: string; status: string };
        let optimistic: ((store: OptimisticLocalStore, args: StatusArgs) => void) | undefined;
        const store = {
          getQuery: () => undefined,
          getAllQueries: (query: Parameters<typeof getFunctionName>[0]) => getFunctionName(query) === "tasks:getOneTime" && state.detail
            ? [{ args: { companyId: "company", taskId: state.detail.task._id }, value: state.detail }] : [],
          setQuery: (_query: unknown, _args: unknown, value: unknown) => { state.detail = value as typeof state.detail; },
        } as OptimisticLocalStore;
        const mutate = async (args: StatusArgs) => { state.statusWrites.push(args); optimistic?.(store, args); if (state.statusWait) await state.statusWait; };
        return Object.assign(mutate, { withOptimisticUpdate: (update: typeof optimistic) => { optimistic = update; return mutate; } });
      }
      const name = getFunctionName(ref);
      if (name === "tasks:createOneTime" || name === "tasks:createJd") {
        const create = async (args: Record<string, unknown>) => { state.createWrites.push(args); return "new"; };
        return Object.assign(create, { withOptimisticUpdate: () => create });
      }
      if (name === "tasks:updateOneTime" || name === "tasks:updateJd") {
        const update = async (args: Record<string, unknown>) => { state.updateWrites.push(args); };
        return Object.assign(update, { withOptimisticUpdate: () => update });
      }
      if (name === "tasks:confirmTaskCompletion" || name === "tasks:sendBackTaskCompletion") {
        const resolve = async (args: { requestId: string }) => {
          if (name === "tasks:confirmTaskCompletion") state.confirmWrites.push(args);
          else state.sendBackWrites.push(args);
        };
        return Object.assign(resolve, { withOptimisticUpdate: () => resolve });
      }
      const mutate = ["tasks:saveCustomView", "tasks:saveListOrder"].includes(name)
        ? (args: typeof state.writes[number]["args"]) => new Promise<{ orderedIds: string[]; revision: number }>((resolve) => state.writes.push({ args, resolve }))
        : name === "tasks:setJdPausedBulk"
          ? async (args: { taskIds: string[]; paused: boolean }) => { state.lifecycleWrites.push(args); }
          : vi.fn();
      return Object.assign(mutate, { withOptimisticUpdate: () => mutate });
    },
  };
});
// Drive the list's drag/drop seam without depending on pointer geometry or animation.
vi.mock("./list-dnd", () => ({
  useListDrag: (options: { onDrop: typeof state.drop }) => { state.drop = options.onDrop; return { active: false }; },
  ListDragOverlay: () => null,
  ListDragRailRow: ({ id, children }: { id: string; children: React.ReactElement<{ onCheckedChange: () => void }> }) => {
    state.railRows.set(id, children.props.onCheckedChange);
    return null;
  },
  ListSortableRow: ({ id, children }: { id: string; children: ReactNode }) => state.renderRows ? React.createElement("tr", { "data-task-id": id }, children) : null,
}));
vi.mock("@dnd-kit/react", () => ({ DragDropProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("./task-rail-scroll", () => ({
  useTaskRailAutoScroll: () => ({ syncToggleScrollState: vi.fn() }),
  TaskRail: ({ children }: { children: ReactNode }) => {
    React.Children.forEach(children, (child) => {
      if (!React.isValidElement<{ children?: ReactNode; onClick?: () => void }>(child)) return;
      React.Children.forEach(child.props.children, (button) => {
        if (!React.isValidElement<{ children?: ReactNode; onClick?: () => void }>(button)) return;
        const label = React.Children.toArray(button.props.children);
        if (label.includes("Custom")) state.selectCustom = button.props.onClick ?? null;
        if (label.includes("My Tasks")) state.selectMy = button.props.onClick ?? null;
        if (label.includes("All Tasks")) state.selectAll = button.props.onClick ?? null;
        if (label.includes("Awaiting confirmation")) state.selectAwaiting = button.props.onClick ?? null;
      });
    });
    return null;
  },
}));
vi.mock("@/lib/use-is-coarse-pointer", () => ({ useIsCoarsePointer: () => false }));
// Inspect the rows the selection export hands to the workbook writer.
vi.mock("@/lib/task-import/workbook", () => ({
  exportTaskWorkbook: async (_kind: string, _companyId: string, _companyName: string, rows: { evidenceRequired?: boolean }[]) => {
    state.exported = rows;
    return { toBlob: async () => new Blob(["workbook"]) };
  },
  downloadBlob: () => {},
}));
// Render dialog forms inline and only while open, without portal geometry.
vi.mock("@radix-ui/react-dialog", () => ({
  Root: ({ open, children }: { open: boolean; children: ReactNode }) => open ? children : null,
  Portal: ({ children }: { children: ReactNode }) => children,
  Overlay: () => null,
  Content: ({ children }: { children: ReactNode }) => React.createElement("div", { role: "dialog" }, children),
  Title: ({ children }: { children: ReactNode }) => React.createElement("h2", null, children),
  Description: ({ children }: { children: ReactNode }) => React.createElement("p", null, children),
  Close: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@radix-ui/react-dropdown-menu", () => {
  const pass = ({ children }: { children: ReactNode }) => children;
  const findLabel = (node: ReactNode): string | null => {
    if (typeof node === "string") return node;
    if (Array.isArray(node)) {
      for (const child of node) {
        const label = findLabel(child);
        if (label) return label;
      }
      return null;
    }
    if (React.isValidElement<{ children?: ReactNode }>(node)) return findLabel(node.props.children);
    return null;
  };
  return { Root: pass, Trigger: pass, Portal: pass, Content: pass, Sub: pass, SubTrigger: pass, SubContent: pass,
    Item: ({ onSelect, children }: { onSelect?: () => void; children?: ReactNode }) => {
      const label = findLabel(children);
      if (label && onSelect) state.selects.set(label, onSelect);
      return children;
    },
    CheckboxItem: ({ children, ...props }: { checked: boolean; onCheckedChange: (value: boolean) => void; onSelect?: (event: { preventDefault: () => void }) => void; children: ReactNode }) => {
      const label = findLabel(children);
      if (label) state.checkboxes.set(label, props);
      if (label === "Inactive tasks") state.filterPaused = props.onCheckedChange;
      return children;
    },
  };
});

let container: ReturnType<typeof createMockElement>;
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  state.view = { orderedIds: ["A", "B", "C"], revision: 0 };
  state.pending = false;
  state.renderRows = false;
  state.taskIds = ["A", "B", "C"];
  state.taskStates = {};
  state.dueDates = {};
  state.serverTime = null;
  state.clockFails = false;
  state.clockRequests = 0;
  state.clockFailAfterFirst = false;
  state.clockWait = null;
  state.statusWait = null;
  state.detail = null;
  state.otherAssigneeIds = [];
  state.evidenceRequired = [];
  state.evidenceResults = [];
  state.exported = [];
  state.statusWrites = [];
  state.assignable = [];
  state.confirmers = [];
  state.awaitingRows = [];
  state.createWrites = [];
  state.updateWrites = [];
  state.confirmWrites = [];
  state.sendBackWrites = [];
  state.pausedIds = [];
  state.lifecycleAllowed = true;
  state.capabilities = [];
  state.ignorePausedQuery = false;
  state.lifecycleWrites = [];
  state.filterPaused = null;
  state.selectAwaiting = null;
  state.selects.clear();
  state.checkboxes.clear();
  state.writes = [];
});

async function mount(kind: "jd" | "one", custom = true) {
  container = createMockElement();
  root = createRoot(container);
  await act(async () => root!.render(kind === "one" ? React.createElement(OneTimeTasksLayout, null, null) : React.createElement(TaskList, { kind })));
  if (custom) await act(async () => state.selectCustom!());
}

test("Custom keeps queued moves when its subscription arrives before the save acknowledgement", async () => {
  await mount("jd");
  await act(async () => state.drop!("B", { anchorId: "A", edge: "before" }));
  await act(async () => state.drop!("C", { anchorId: "B", edge: "before" }));
  expect(state.writes).toHaveLength(1);
  state.view = { orderedIds: ["B", "A", "C"], revision: 1 };
  await act(async () => root!.render(React.createElement(TaskList, { kind: "jd" })));
  await act(async () => state.writes[0].resolve(state.view));
  expect(state.writes[1].args).toMatchObject({ orderedIds: ["C", "B", "A"], expectedRevision: 1 });
  // Returning to the in-flight order must coalesce, not produce a redundant save.
  await act(async () => state.drop!("C", { anchorId: "B", edge: "after" }));
  await act(async () => state.drop!("C", { anchorId: "B", edge: "before" }));
  await act(async () => state.writes[1].resolve({ orderedIds: ["C", "B", "A"], revision: 2 }));
  expect(state.writes).toHaveLength(2);
});

test.each([true, false])("reordering excludes optimistic creation rows (Custom: %s)", async (custom) => {
  state.pending = true;
  await mount("one", custom);
  await act(async () => state.drop!("B", { anchorId: "A", edge: "before" }));
  expect(state.writes[0].args).toMatchObject({ orderedIds: ["B", "A", "C"], expectedRevision: 0 });
});

function descendants(node: any): any[] {
  return [node, ...(node.children ?? []).flatMap(descendants)];
}
function button(label: string) {
  return descendants(container).find((node) => node.tagName === "BUTTON" && (node.getAttribute?.("aria-label") === label || descendants(node).some((child) => child.nodeValue === label || child.textContent === label)));
}
async function clickButton(label: string) {
  const node = button(label);
  expect(node).toBeDefined();
  const props = node[Object.keys(node).find((key) => key.startsWith("__reactProps$"))!];
  await act(async () => props.onClick());
}

test("bulk lifecycle actions follow selection state and permissions, and submit the selected IDs", async () => {
  await mount("jd", false);
  await act(async () => state.railRows.get("A")!());
  await act(async () => state.railRows.get("B")!());
  expect(button("Make inactive")).toBeDefined();
  // Icon-only button: the label lives on the tooltip, not as button text.
  expect(button("Make inactive")?.getAttribute("data-tooltip")).toBe("Make inactive");
  expect(button("Make active")).toBeUndefined();
  await clickButton("Make inactive");
  expect(state.lifecycleWrites).toEqual([{ companyId: "company", taskIds: ["A", "B"], paused: true }]);
  state.pausedIds = ["A", "B", "C"];
  await act(async () => state.filterPaused!(true));
  await act(async () => state.railRows.get("A")!());
  expect(button("Make active")).toBeDefined();
  await clickButton("Make active");
  expect(state.lifecycleWrites[1]).toMatchObject({ taskIds: ["A"], paused: false });
  state.lifecycleAllowed = false;
  await act(async () => root!.render(React.createElement(TaskList, { kind: "jd" })));
  await act(async () => state.railRows.get("A")!());
  expect(button("Make active")).toBeUndefined();
});

test("a live selection that becomes mixed offers neither pause nor resume", async () => {
  await mount("jd", false);
  await act(async () => state.railRows.get("A")!());
  await act(async () => state.railRows.get("B")!());
  state.ignorePausedQuery = true;
  state.pausedIds = ["B"];
  await act(async () => root!.render(React.createElement(TaskList, { kind: "jd" })));
  expect(button("Make inactive")).toBeUndefined();
  expect(button("Make active")).toBeUndefined();
});

test("paused filtering works in All and My views and with a frequency filter, while Custom never includes paused rows", async () => {
  state.pausedIds = ["B"];
  state.capabilities = ["tasks:jd:view:any"];
  await mount("jd", false);
  expect([...state.railRows.keys()]).toEqual(["A", "C"]);
  await act(async () => state.filterPaused!(true));
  expect([...state.railRows.keys()]).toEqual(["B"]);
  await act(async () => state.selectMy!());
  expect([...state.railRows.keys()]).toEqual(["B"]);
  await act(async () => state.selects.get("Daily")!());
  expect([...state.railRows.keys()]).toEqual([]);
  await act(async () => state.selects.get("Weekly")!());
  expect([...state.railRows.keys()]).toEqual(["B"]);
  state.filterPaused = null;
  await act(async () => state.selectCustom!());
  expect(state.filterPaused).toBeNull();
  expect([...state.railRows.keys()]).toEqual(["A", "C"]);
});

function oneTimeStatuses() {
  state.taskIds = ["A", "B", "C", "D"];
  state.taskStates = {
    A: { status: "Pending", rawStatus: "due" },
    B: { status: "In Progress", rawStatus: "in_progress" },
    C: { status: "Completed", rawStatus: "completed" },
    D: { status: "Overdue", rawStatus: "overdue" },
  };
}

async function checkFilter(label: string, checked: boolean) {
  const option = state.checkboxes.get(label);
  expect(option).toBeDefined();
  await act(async () => option!.onCheckedChange(checked));
}

test("One-Time All and My default to non-overdue statuses and support independent status selections", async () => {
  oneTimeStatuses();
  state.taskIds.push("E");
  state.taskStates.E = { status: "Overdue", rawStatus: "overdue" };
  state.otherAssigneeIds = ["E"];
  state.capabilities = ["tasks:one_time:view:any"];
  await mount("one", false);
  expect([...state.railRows.keys()]).toEqual(["A", "B", "C"]);
  expect(["Pending", "In progress", "Completed"].map((label) => state.checkboxes.get(label)?.checked)).toEqual([true, true, true]);
  expect(state.checkboxes.get("Overdue")?.checked).toBe(false);
  expect(state.checkboxes.get("All statuses")?.checked).toBe(false);
  await act(async () => state.selectMy!());
  expect([...state.railRows.keys()]).toEqual(["A", "B", "C"]);

  const preventDefault = vi.fn();
  state.checkboxes.get("Overdue")!.onSelect!({ preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce(); // Multi-select does not dismiss the menu.
  await checkFilter("Overdue", true);
  expect([...state.railRows.keys()]).toEqual(["A", "B", "C", "D"]);
  await checkFilter("Pending", false);
  expect([...state.railRows.keys()]).toEqual(["B", "C", "D"]);
  await act(async () => state.selectAll!());
  expect([...state.railRows.keys()]).toEqual(["B", "C", "D", "E"]);
  await checkFilter("All statuses", true);
  expect([...state.railRows.keys()]).toEqual(["A", "B", "C", "D", "E"]);
  await checkFilter("All statuses", false);
  expect([...state.railRows.keys()]).toEqual([]);
  await clickButton("Clear filters");
  expect([...state.railRows.keys()]).toEqual(["A", "B", "C", "D", "E"]);
});

test("One-Time Custom has only an overdue toggle, independent of All/My filters, and preserves hidden order on drag", async () => {
  oneTimeStatuses();
  state.view = { orderedIds: ["A", "D", "B", "C"], revision: 0 };
  await mount("one", false);
  await checkFilter("Completed", false);
  await act(async () => state.selectCustom!());
  expect([...state.railRows.keys()]).toEqual(["A", "B", "C"]);
  expect([...state.checkboxes.keys()]).toEqual(["Show overdue tasks"]);
  expect(state.selects.size).toBe(0);
  expect(state.checkboxes.get("Show overdue tasks")?.checked).toBe(false);
  await act(async () => state.drop!("B", { anchorId: "A", edge: "before" }));
  expect(state.writes[0].args).toMatchObject({ orderedIds: ["B", "D", "A", "C"], expectedRevision: 0 });
  await act(async () => state.writes[0].resolve({ orderedIds: ["B", "D", "A", "C"], revision: 1 }));
  await checkFilter("Show overdue tasks", true);
  expect([...state.railRows.keys()]).toEqual(["B", "D", "A", "C"]);
  await checkFilter("Show overdue tasks", false);
  expect([...state.railRows.keys()]).toEqual(["B", "A", "C"]);
  await act(async () => state.selectAll!());
  expect([...state.railRows.keys()]).toEqual(["A", "B"]);
});

test("Custom explains an overdue-only empty view and offers to reveal the tasks", async () => {
  state.taskStates = Object.fromEntries(["A", "B", "C"].map((id) => [id, { status: "Overdue", rawStatus: "overdue" }]));
  await mount("one");
  expect([...state.railRows.keys()]).toEqual([]);
  expect(button("Show overdue tasks")).toBeDefined();
  await clickButton("Show overdue tasks");
  expect([...state.railRows.keys()]).toEqual(["A", "B", "C"]);
});

test("the default overdue filter does not turn a genuinely empty list into a no-matches state", async () => {
  state.taskIds = [];
  await mount("one", false);
  expect(descendants(container).some((node) => node.nodeValue === "No tasks yet" || node.textContent === "No tasks yet")).toBe(true);
  expect(button("Clear filters")).toBeUndefined();
});

test("an empty inactive JD view keeps its filter and offers to return to active tasks", async () => {
  await mount("jd", false);
  await checkFilter("Inactive tasks", true);
  expect([...state.railRows.keys()]).toEqual([]);
  expect(descendants(container).some((node) => node.textContent === "No matching tasks")).toBe(true);
  await clickButton("Clear filters");
  expect(new Set(state.railRows.keys())).toEqual(new Set(["A", "B", "C"]));
});

test("explicit One-Time status filters remain clearable even when the query is empty", async () => {
  state.taskIds = [];
  await mount("one", false);
  await checkFilter("Completed", false);
  expect(button("Clear filters")).toBeDefined();
});

test.each([false, true])("One-Time tasks become overdue without a subscription update (Custom: %s)", async (custom) => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
  vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
  state.taskStates = {
    A: { status: "Pending", rawStatus: "due" },
    B: { status: "In Progress", rawStatus: "in_progress" },
    C: { status: "Completed", rawStatus: "completed" },
  };
  state.dueDates = { A: Date.now() + 1000, B: Date.now() + 2000, C: Date.now() - 1000 };
  state.capabilities = ["tasks:one_time:view:any"];
  await mount("one", custom);
  expect([...state.railRows.keys()]).toEqual(["A", "B", "C"]);
  await act(async () => { await vi.advanceTimersByTimeAsync(1001); });
  expect([...state.railRows.keys()]).toEqual(["B", "C"]);
  if (!custom) await act(async () => state.selectMy!());
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect([...state.railRows.keys()]).toEqual(["C"]);
  await checkFilter(custom ? "Show overdue tasks" : "Overdue", true);
  expect([...state.railRows.keys()]).toEqual(["A", "B", "C"]);
});

test.each([false, true])("list and open detail share clock success, failure and recovery (initial failure: %s)", async (initialFailure) => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
  state.serverTime = Date.parse("2026-10-14T12:00:00Z");
  vi.setSystemTime(state.serverTime + 600_000);
  const dueDate = state.serverTime + 1000;
  state.dueDates = { A: dueDate };
  state.clockFails = initialFailure;
  state.clockFailAfterFirst = !initialFailure; // A separate drawer request would fail.
  state.detail = { task: { _id: "A", title: "A", createdAt: 1, priority: "low", dueDate, assigneeMembershipIds: ["member"], state: { status: "Pending", rawStatus: "due" } }, canUpdate: false };
  container = createMockElement();
  root = createRoot(container);
  await act(async () => root!.render(React.createElement(OneTimeTasksLayout, null,
    React.createElement("section", { "aria-label": "Task detail" }, React.createElement(TaskDetail, { kind: "one", id: "A" })),
  )));
  const detail = descendants(container).find((node) => node.getAttribute?.("aria-label") === "Task detail");
  const statusControls = () => descendants(detail).filter((node) => node.getAttribute?.("aria-label") === "Change status");
  expect([...state.railRows.keys()]).toContain("A");
  expect(statusControls()).toHaveLength(1);
  expect(descendants(detail).some((node) => node.textContent === "Pending" || node.nodeValue === "Pending")).toBe(true);
  expect(state.clockRequests).toBe(1);
  if (initialFailure) {
    expect(descendants(container).filter((node) => node.textContent === "Could not refresh task deadlines. Retrying automatically.")).toHaveLength(2);
    state.clockFails = false;
    state.serverTime += 1001;
  }
  await act(async () => { await vi.advanceTimersByTimeAsync(1001); });
  expect([...state.railRows.keys()]).not.toContain("A");
  expect(descendants(detail).some((node) => node.getAttribute?.("aria-label") === "Overdue (locked)")).toBe(true);
  expect(statusControls()).toHaveLength(0);
  expect(state.detail.task.state.rawStatus).toBe("due"); // The subscription has not changed.
  expect(state.clockRequests).toBe(initialFailure ? 2 : 1);
  expect(descendants(container).some((node) => node.getAttribute?.("role") === "alert")).toBe(false);
});

test.each([-600_000, 600_000])("deadline updates ignore device clock skew (%s ms)", async (skew) => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
  state.serverTime = Date.parse("2026-10-14T12:00:00Z");
  vi.setSystemTime(state.serverTime + skew);
  state.dueDates = { A: state.serverTime + 1000, B: state.serverTime + 2000 };
  await mount("one", false);
  expect([...state.railRows.keys()]).toEqual(["A", "B", "C"]);
  await act(async () => { await vi.advanceTimersByTimeAsync(1001); });
  expect([...state.railRows.keys()]).toEqual(["B", "C"]);
  vi.setSystemTime(Date.now() + 3_600_000); // Changing the wall clock must not advance server time.
  await act(async () => root!.render(React.createElement(OneTimeTasksLayout, null, null)));
  expect([...state.railRows.keys()]).toEqual(["B", "C"]);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect([...state.railRows.keys()]).toEqual(["C"]);
});

test("failed server clock synchronization preserves server state and reports the failure", async () => {
  state.clockFails = true;
  state.dueDates = { A: Date.now() - 1000 };
  await mount("one", false);
  expect([...state.railRows.keys()]).toEqual(["A", "B", "C"]);
  expect(descendants(container).some((node) => node.textContent === "Could not refresh task deadlines. Retrying automatically.")).toBe(true);
});

test("clock failure and recovery preserve an actionable task-order conflict", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
  let onVisible: (() => void) | undefined;
  vi.spyOn(document, "addEventListener").mockImplementation((type, listener) => {
    if (type === "visibilitychange") onVisible = listener as () => void;
  });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  try {
    await mount("one");
    await act(async () => state.drop!("B", { anchorId: "A", edge: "before" }));
    state.view = { orderedIds: ["C", "B", "A"], revision: 1 };
    await act(async () => root!.render(React.createElement(OneTimeTasksLayout, null, null)));
    const hasConflict = () => descendants(container).some((node) => node.textContent === "Task order changed in another session. Please repeat the move.");
    expect(hasConflict()).toBe(true);
    state.clockFails = true;
    await act(async () => onVisible!());
    expect(hasConflict()).toBe(true);
    expect(descendants(container).some((node) => node.textContent === "Could not refresh task deadlines. Retrying automatically.")).toBe(true);
    state.clockFails = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(hasConflict()).toBe(true);
    expect(descendants(container).some((node) => node.textContent === "Could not refresh task deadlines. Retrying automatically.")).toBe(false);
  } finally {
    Reflect.deleteProperty(document, "visibilityState");
  }
});

test("an initially unavailable clock recovers automatically while the page remains visible", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
  const start = Date.parse("2026-10-14T12:00:00Z");
  vi.setSystemTime(start);
  state.clockFails = true;
  state.dueDates = { A: start + 500, B: start + 4000 };
  await mount("one", false);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); // A second failed attempt.
  state.clockFails = false;
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect([...state.railRows.keys()]).toEqual(["B", "C"]);
  expect(descendants(container).some((node) => node.getAttribute?.("role") === "alert")).toBe(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(1001); });
  expect([...state.railRows.keys()]).toEqual(["C"]);
});

test("clock retries pause while hidden, resume on visibility, and are removed on unmount", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
  state.clockFails = true;
  state.dueDates = { A: Date.now() + 500 };
  let visibility = "visible";
  let onVisible: (() => void) | undefined;
  vi.spyOn(document, "addEventListener").mockImplementation((type, listener) => {
    if (type === "visibilitychange") onVisible = listener as () => void;
  });
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  try {
    await mount("one", false);
    expect(vi.getTimerCount()).toBe(1);
    visibility = "hidden";
    await act(async () => onVisible!());
    expect(vi.getTimerCount()).toBe(0);
    state.clockFails = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect([...state.railRows.keys()]).toEqual(["A", "B", "C"]);
    visibility = "visible";
    await act(async () => onVisible!());
    expect([...state.railRows.keys()]).toEqual(["B", "C"]);
    let reject!: (error: Error) => void;
    state.clockWait = new Promise<void>((_resolve, rejectRequest) => { reject = rejectRequest; });
    await act(async () => onVisible!());
    visibility = "hidden";
    await act(async () => onVisible!());
    await act(async () => reject(new Error("Clock unavailable")));
    expect(vi.getTimerCount()).toBe(0); // A request that fails after hiding must not restart retries.
    state.clockWait = null;
    state.clockFails = true;
    visibility = "visible";
    await act(async () => onVisible!());
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => root!.unmount());
    root = undefined;
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    Reflect.deleteProperty(document, "visibilityState");
  }
});

test("a failed clock refresh retains overdue status and keeps future deadline timers running", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
  state.serverTime = Date.parse("2026-10-14T12:00:00Z");
  state.dueDates = { A: state.serverTime + 1000, B: state.serverTime + 2000 };
  let onVisible: (() => void) | undefined;
  vi.spyOn(document, "addEventListener").mockImplementation((type, listener) => {
    if (type === "visibilitychange") onVisible = listener as () => void;
  });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  try {
    await mount("one", false);
    await act(async () => { await vi.advanceTimersByTimeAsync(1001); });
    expect([...state.railRows.keys()]).toEqual(["B", "C"]);
    state.clockFails = true;
    await act(async () => onVisible!());
    expect([...state.railRows.keys()]).toEqual(["B", "C"]);
    expect(descendants(container).some((node) => node.textContent === "Could not refresh task deadlines. Retrying automatically.")).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect([...state.railRows.keys()]).toEqual(["C"]);
  } finally {
    Reflect.deleteProperty(document, "visibilityState");
  }
});

test("optimistic status changes use the trusted deadline projection, not the device wall clock", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
  vi.stubGlobal("innerWidth", 1024);
  vi.stubGlobal("innerHeight", 768);
  vi.stubGlobal("ResizeObserver", class {
    constructor(private onResize: () => void) {}
    observe(node: HTMLElement) { Object.defineProperty(node, "offsetHeight", { value: 100 }); this.onResize(); }
    disconnect() {}
  });
  state.serverTime = Date.parse("2026-10-14T12:00:00Z");
  vi.setSystemTime(state.serverTime + 600_000);
  state.dueDates = { A: state.serverTime + 5000 };
  state.detail = { task: { _id: "A", title: "A", createdAt: 1, priority: "low", dueDate: state.dueDates.A, assigneeMembershipIds: ["member"], state: { status: "Pending", rawStatus: "due" } }, canUpdate: false };
  let release!: () => void;
  state.statusWait = new Promise<void>((resolve) => { release = resolve; });
  state.renderRows = true;
  const page = () => React.createElement(OneTimeTasksLayout, null,
    React.createElement("section", { "aria-label": "Task detail" }, React.createElement(TaskDetail, { kind: "one", id: "A" })),
  );
  try {
    container = createMockElement();
    root = createRoot(container);
    await act(async () => root!.render(page()));
    const row = descendants(container).find((node) => node.getAttribute?.("data-task-id") === "A");
    expect(descendants(row).some((node) => node.getAttribute?.("class")?.includes("text-[var(--danger)]"))).toBe(false);
    expect(descendants(row).some((node) => node.getAttribute?.("class")?.includes("text-[var(--badge-yellow-fg)]"))).toBe(true);
    const detail = descendants(container).find((node) => node.getAttribute?.("aria-label") === "Task detail");
    const statusControl = () => descendants(detail).find((node) => node.getAttribute?.("aria-label") === "Change status");
    statusControl().getBoundingClientRect = () => ({ top: 0, bottom: 30, left: 0, right: 100, width: 100, height: 30 });
    await act(async () => statusControl().dispatchEvent(new Event("click", { bubbles: true })));
    await clickButton("In Progress");
    await act(async () => root!.render(page())); // Deliver the optimistic subscription update.
    expect([...state.railRows.keys()]).toContain("A");
    expect(statusControl()).toBeDefined();
    expect(descendants(container).some((node) => node.getAttribute?.("aria-label") === "Overdue (locked)")).toBe(false);
    expect(descendants(container).some((node) => node.textContent === "In Progress" || node.nodeValue === "In Progress")).toBe(true);
  } finally {
    await act(async () => release());
    vi.unstubAllGlobals();
  }
});

test.each([[400, false], [5000, false], [5000, true]] as const)("a delayed initial clock sample does not restart an elapsed deadline (%s ms, clock paused: %s)", async (delay, pausedClock) => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
  state.serverTime = Date.parse("2026-10-14T12:00:00Z");
  vi.setSystemTime(state.serverTime + 600_000);
  state.dueDates = { A: state.serverTime + 100, B: state.serverTime + 100_000 };
  state.detail = { task: { _id: "A", title: "A", createdAt: 1, priority: "low", dueDate: state.dueDates.A, assigneeMembershipIds: ["member"], state: { status: "Pending", rawStatus: "due" } }, canUpdate: false };
  let release!: () => void;
  state.clockWait = new Promise<void>((resolve) => { release = resolve; });
  container = createMockElement();
  root = createRoot(container);
  await act(async () => root!.render(React.createElement(OneTimeTasksLayout, null, React.createElement(TaskDetail, { kind: "one", id: "A" }))));
  expect(button("Change status")?.getAttribute("disabled")).not.toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(delay); });
  const monotonicClock = pausedClock ? vi.spyOn(performance, "now").mockReturnValue(0) : undefined;
  state.clockWait = null;
  state.serverTime += delay;
  await act(async () => release());
  monotonicClock?.mockRestore();
  if (delay === 5000) {
    // An arbitrarily old initial sample is unusable; keep controls disabled
    // until the single automatic retry obtains fresh server time.
    expect([...state.railRows.keys()]).toContain("A");
    expect(button("Change status")?.getAttribute("disabled")).not.toBeNull();
    expect(descendants(container).some((node) => node.getAttribute?.("role") === "alert")).toBe(true);
    state.serverTime += 1000;
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  }
  expect([...state.railRows.keys()]).toEqual(["B", "C"]);
  expect(button("Change status")).toBeUndefined();
  expect(descendants(container).some((node) => node.getAttribute?.("aria-label") === "Overdue (locked)")).toBe(true);
  expect(descendants(container).some((node) => node.getAttribute?.("role") === "alert")).toBe(false);
});

test("visibility advances trusted deadlines immediately even while the refresh is pending", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
  state.serverTime = Date.parse("2026-10-14T12:00:00Z");
  state.dueDates = { A: state.serverTime + 1000, B: state.serverTime + 100_000 };
  state.detail = { task: { _id: "B", title: "B", createdAt: 1, priority: "low", dueDate: state.dueDates.B, assigneeMembershipIds: ["member"], state: { status: "Pending", rawStatus: "due" } }, canUpdate: false };
  let onVisible: (() => void) | undefined;
  vi.spyOn(document, "addEventListener").mockImplementation((type, listener) => {
    if (type === "visibilitychange") onVisible = listener as () => void;
  });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  try {
    container = createMockElement();
    root = createRoot(container);
    await act(async () => root!.render(React.createElement(OneTimeTasksLayout, null, React.createElement(TaskDetail, { kind: "one", id: "B" }))));
    expect(button("Change status")?.getAttribute("disabled")).toBeNull();
    vi.spyOn(performance, "now").mockReturnValue(5000); // Elapsed time, but no delivered deadline timer.
    let reject!: (error: Error) => void;
    state.clockWait = new Promise<void>((_resolve, rejectRequest) => { reject = rejectRequest; });
    await act(async () => onVisible!());
    expect([...state.railRows.keys()]).toEqual(["B", "C"]);
    expect(button("Change status")?.getAttribute("disabled")).not.toBeNull();
    await act(async () => reject(new Error("Clock unavailable")));
    expect(button("Change status")?.getAttribute("disabled")).not.toBeNull();
    state.clockWait = null;
    state.serverTime += 6000;
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(button("Change status")?.getAttribute("disabled")).toBeNull();
  } finally {
    Reflect.deleteProperty(document, "visibilityState");
  }
});

test("visibility changes neither queue overlapping clock requests nor accept pre-hide replies", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
  state.serverTime = Date.parse("2026-10-14T12:00:00Z");
  state.dueDates = { A: state.serverTime + 10 };
  let release!: () => void;
  state.clockWait = new Promise<void>((resolve) => { release = resolve; });
  let visibility = "visible";
  let onVisible: (() => void) | undefined;
  vi.spyOn(document, "addEventListener").mockImplementation((type, listener) => {
    if (type === "visibilitychange") onVisible = listener as () => void;
  });
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  try {
    await mount("one", false);
    for (let cycle = 0; cycle < 3; cycle++) {
      visibility = "hidden";
      await act(async () => onVisible!());
      visibility = "visible";
      await act(async () => onVisible!());
    }
    expect(state.clockRequests).toBe(1);
    visibility = "hidden";
    await act(async () => onVisible!());
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    state.clockWait = null;
    await act(async () => release());
    expect([...state.railRows.keys()]).toContain("A");
    state.serverTime += 200;
    visibility = "visible";
    await act(async () => onVisible!());
    expect(state.clockRequests).toBe(2);
    expect([...state.railRows.keys()]).toEqual(["B", "C"]);
  } finally {
    Reflect.deleteProperty(document, "visibilityState");
  }
});

test("a delayed successful clock refresh cannot rewind an already observed deadline", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
  const start = Date.parse("2026-10-14T12:00:00Z");
  state.serverTime = start;
  state.dueDates = { A: start + 1000 };
  let onVisible: (() => void) | undefined;
  vi.spyOn(document, "addEventListener").mockImplementation((type, listener) => {
    if (type === "visibilitychange") onVisible = listener as () => void;
  });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  try {
    await mount("one", false);
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    state.serverTime = start + 200;
    let release!: () => void;
    state.clockWait = new Promise<void>((resolve) => { release = resolve; });
    await act(async () => onVisible!());
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect([...state.railRows.keys()]).toEqual(["B", "C"]);
    await act(async () => release()); // The timestamp was captured before A's deadline.
    expect([...state.railRows.keys()]).toEqual(["B", "C"]);
  } finally {
    Reflect.deleteProperty(document, "visibilityState");
  }
});

test("overdue-only All and My views explain the default filter and reuse Clear filters", async () => {
  state.taskStates = Object.fromEntries(["A", "B", "C"].map((id) => [id, { status: "Overdue", rawStatus: "overdue" }]));
  state.capabilities = ["tasks:one_time:view:any"];
  await mount("one", false);
  const explanation = "Overdue tasks are hidden by default. Select Overdue in the status filter or clear filters to show them.";
  expect(descendants(container).some((node) => node.textContent === explanation)).toBe(true);
  await act(async () => state.selectMy!());
  expect(descendants(container).some((node) => node.textContent === explanation)).toBe(true);
  expect(button("Show overdue tasks")).toBeUndefined();
  await clickButton("Clear filters");
  expect([...state.railRows.keys()]).toEqual(["A", "B", "C"]);
});

test("returning to a suspended tab immediately re-evaluates deadlines", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
  vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
  let onVisible: (() => void) | undefined;
  vi.spyOn(document, "addEventListener").mockImplementation((type, listener) => {
    if (type === "visibilitychange") onVisible = listener as () => void;
  });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  try {
    state.dueDates = { A: Date.now() + 1000 };
    await mount("one", false);
    vi.setSystemTime(Date.now() + 5000); // The browser has not delivered its timer yet.
    await act(async () => onVisible!());
    expect([...state.railRows.keys()]).toEqual(["B", "C"]);
  } finally {
    Reflect.deleteProperty(document, "visibilityState");
  }
});

test("deadline updates cancel the old timer and handle deadlines beyond the browser timer limit", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
  vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
  const start = Date.now();
  const month = 30 * 24 * 60 * 60 * 1000;
  state.dueDates = { A: start + 1000 };
  await mount("one", false);
  state.dueDates.A = start + month;
  await act(async () => root!.render(React.createElement(OneTimeTasksLayout, null, null)));
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect([...state.railRows.keys()]).toEqual(["A", "B", "C"]);
  await act(async () => { await vi.advanceTimersByTimeAsync(2_147_483_647 - 2000); });
  expect([...state.railRows.keys()]).toEqual(["A", "B", "C"]);
  await act(async () => { await vi.advanceTimersByTimeAsync(month - 2_147_483_647 + 1); });
  expect([...state.railRows.keys()]).toEqual(["B", "C"]);
});

test("Job Description retains its all-status default and single-select status filter", async () => {
  oneTimeStatuses();
  await mount("jd", false);
  expect(new Set(state.railRows.keys())).toEqual(new Set(["A", "B", "C", "D"]));
  await act(async () => state.selects.get("Completed")!());
  expect([...state.railRows.keys()]).toEqual(["C"]);
  await act(async () => state.selects.get("All statuses")!());
  expect(new Set(state.railRows.keys())).toEqual(new Set(["A", "B", "C", "D"]));
});

function reactProps(node: any) {
  return node[Object.keys(node).find((key) => key.startsWith("__reactProps$"))!];
}

async function chooseStatus(taskId: string, label: string) {
  const row = descendants(container).find((node) => node.getAttribute?.("data-task-id") === taskId);
  expect(row, `row ${taskId}`).toBeDefined();
  const trigger = descendants(row).find((node) => node.getAttribute?.("aria-label") === "Change status");
  expect(trigger, `status control for ${taskId}`).toBeDefined();
  trigger.getBoundingClientRect = () => ({ top: 0, bottom: 30, left: 0, right: 100, width: 100, height: 30 });
  await act(async () => trigger.dispatchEvent(new Event("click", { bubbles: true, cancelable: true })));
  await clickButton(label);
}

function dialogNode() {
  return descendants(container).find((node) => node.getAttribute?.("role") === "dialog");
}

async function renderStatusRows() {
  vi.stubGlobal("innerWidth", 1024);
  vi.stubGlobal("innerHeight", 768);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  state.renderRows = true;
  await mount("one", false);
}

test("an evidence-required task opens the completion dialog and submits text evidence", async () => {
  state.evidenceRequired = ["A"];
  state.taskStates = { A: { status: "Pending", rawStatus: "due" } };
  await renderStatusRows();
  await chooseStatus("A", "Completed");
  const dialog = dialogNode();
  expect(dialog).toBeDefined();
  // Nothing is marked complete until the dialog is submitted.
  expect(state.statusWrites).toHaveLength(0);
  const textarea = descendants(dialog).find((node) => node.tagName === "TEXTAREA" && node.getAttribute?.("aria-label") === "Evidence");
  expect(textarea).toBeDefined();
  await act(async () => reactProps(textarea).onChange({ target: { value: "  Signed off  " } }));
  await clickButton("Complete task");
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(state.statusWrites).toHaveLength(1);
  expect(state.statusWrites[0]).toMatchObject({ taskId: "A", status: "completed", evidence: { text: "Signed off", files: [] } });
  expect(dialogNode()).toBeUndefined();
});

test("a task without evidence completes directly", async () => {
  state.taskStates = { A: { status: "Pending", rawStatus: "due" } };
  await renderStatusRows();
  await chooseStatus("A", "Completed");
  await act(async () => { await Promise.resolve(); });
  expect(dialogNode()).toBeUndefined();
  expect(state.statusWrites).toHaveLength(1);
  expect(state.statusWrites[0]).toMatchObject({ taskId: "A", status: "completed" });
  expect(state.statusWrites[0]).not.toHaveProperty("evidence");
});

test("exporting selected tasks carries the evidence-required flag", async () => {
  state.evidenceRequired = ["A"];
  state.capabilities = ["tasks:jd:export"];
  await mount("jd", false);
  await act(async () => state.railRows.get("A")!());
  await clickButton("Export selected task");
  await vi.waitFor(() => expect(state.exported).toHaveLength(1));
  expect(state.exported).toHaveLength(1);
  expect(state.exported[0]).toMatchObject({ reference: "A", evidenceRequired: true });
});

const confirmerUser = { membership: { _id: "confirmer", role: "Manager" }, user: { name: "Casey", email: "casey@example.com" } };
const assigneeUser = { membership: { _id: "assignee", role: "Member" }, user: { name: "Ada", email: "ada@example.com" } };
const awaitingRow = {
  _id: "req1", taskId: "T1", taskType: "one_time", reference: "T1", title: "Ship report",
  assignees: [assigneeUser], submittedBy: assigneeUser, submittedAt: 1000, cycleStart: null, cycleEnd: null,
};

test("the task dialog requires a confirmer and sends the selection", async () => {
  state.capabilities = ["tasks:one_time:create"];
  state.assignable = [assigneeUser];
  state.confirmers = [confirmerUser];
  await mount("one", false);
  await clickButton("New task");
  const dialog = descendants(container).find((node) => node.getAttribute?.("role") === "dialog");
  expect(dialog).toBeDefined();
  const titleInput = descendants(dialog).find((node) => node.getAttribute?.("aria-label") === "Task title");
  await act(async () => reactProps(titleInput).onChange({ target: { value: "Ship report" } }));
  const assigneeTrigger = descendants(dialog).find((node) => node.getAttribute?.("aria-label") === "Assigned To (required): Select assignee");
  await act(async () => assigneeTrigger.dispatchEvent(new Event("click", { bubbles: true, cancelable: true })));
  await clickButton("Ada");
  const confirmationToggle = descendants(dialog).find((node) => node.getAttribute?.("role") === "switch" && node.getAttribute?.("aria-label") === "Require confirmation to complete");
  await act(async () => confirmationToggle.dispatchEvent(new Event("click", { bubbles: true, cancelable: true })));
  expect(descendants(dialog).some((node) => node.textContent === "Select a confirmer.")).toBe(false);

  const form = descendants(dialog).find((node) => node.tagName === "FORM");
  await act(async () => { reactProps(form).onSubmit({ preventDefault: () => {} }); await Promise.resolve(); });
  expect(state.createWrites).toHaveLength(0);
  expect(descendants(dialog).some((node) => node.textContent === "Select a confirmer.")).toBe(true);

  await act(async () => state.selects.get("Casey")!());
  await act(async () => { reactProps(form).onSubmit({ preventDefault: () => {} }); await Promise.resolve(); });
  expect(state.createWrites[0]).toMatchObject({ title: "Ship report", confirmerMembershipId: "confirmer" });
});

test("turning confirmation off on edit sends null", async () => {
  state.capabilities = ["tasks:one_time:update:any"];
  state.confirmers = [confirmerUser];
  state.assignable = [confirmerUser];
  state.detail = {
    task: {
      _id: "A", title: "A", createdAt: 1, priority: "low", dueDate: Date.now() + 86_400_000,
      assigneeMembershipIds: ["member"], confirmerMembershipId: "confirmer", confirmer: confirmerUser,
      state: { status: "Pending", rawStatus: "due" },
    },
    canUpdate: true,
  };
  container = createMockElement();
  root = createRoot(container);
  await act(async () => root!.render(React.createElement(OneTimeTasksLayout, null, React.createElement(TaskDetail, { kind: "one", id: "A" }))));
  expect(descendants(container).some((node) => node.textContent === "Casey" || node.nodeValue === "Casey")).toBe(true);
  await clickButton("Edit task");
  const dialog = descendants(container).find((node) => node.getAttribute?.("role") === "dialog");
  const confirmationToggle = descendants(dialog).find((node) => node.getAttribute?.("role") === "switch" && node.getAttribute?.("aria-label") === "Require confirmation to complete");
  expect(confirmationToggle.getAttribute("aria-checked")).toBe("true");
  await act(async () => confirmationToggle.dispatchEvent(new Event("click", { bubbles: true, cancelable: true })));
  const form = descendants(dialog).find((node) => node.tagName === "FORM");
  await act(async () => { reactProps(form).onSubmit({ preventDefault: () => {} }); await Promise.resolve(); });
  expect(state.updateWrites[0]).toMatchObject({ confirmerMembershipId: null });
});

test("the awaiting confirmation view appears only with tasks:confirm", async () => {
  await mount("one", false);
  expect(state.selectAwaiting).toBeNull();
  await act(async () => root!.unmount());
  root = undefined;
  state.selectAwaiting = null;
  state.capabilities = ["tasks:confirm"];
  await mount("one", false);
  expect(state.selectAwaiting).toBeTypeOf("function");
});

test("the awaiting confirmation view confirms and sends back by request id", async () => {
  state.capabilities = ["tasks:confirm"];
  state.awaitingRows = [awaitingRow];
  await mount("one", false);
  await act(async () => state.selectAwaiting!());
  expect(descendants(container).some((node) => node.textContent === "Ship report" || node.nodeValue === "Ship report")).toBe(true);
  await clickButton("Confirm");
  expect(state.confirmWrites).toEqual([{ companyId: "company", requestId: "req1" }]);
  await clickButton("Send back");
  expect(button("Confirm send back")).toBeDefined();
  await clickButton("Confirm send back");
  expect(state.sendBackWrites).toEqual([{ companyId: "company", requestId: "req1" }]);
});

test("retired evidence from the current cycle is not reported as submitted", async () => {
  state.detail = {
    task: {
      _id: "A",
      title: "A",
      createdAt: 1,
      priority: "low",
      dueDate: Date.now() + 86_400_000,
      assigneeMembershipIds: ["member"],
      evidenceRequired: true,
      state: { status: "Pending", rawStatus: "due", currentCycleStart: 1000 },
    },
    canUpdate: false,
  };
  state.evidenceResults = [
    { _id: "e1", text: "Old schedule proof", files: [], cycleStart: 1000, createdAt: 1, createdBy: null, retiredAt: 2 },
  ];
  container = createMockElement();
  root = createRoot(container);
  await act(async () => root!.render(React.createElement(TaskDetail, { kind: "jd", id: "A" })));
  expect(descendants(container).some((node) => node.textContent === "No evidence has been submitted for the current cycle yet.")).toBe(true);
  expect(descendants(container).some((node) => node.textContent === "Current cycle")).toBe(false);
  expect(descendants(container).some((node) => node.textContent === "Previous schedule")).toBe(true);
});

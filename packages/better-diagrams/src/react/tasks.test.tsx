/**
 * @vitest-environment jsdom
 *
 * Task graphs on the canvas: the corner check (open, blocked or done), the
 * assignee tabs and picker, the People legend, the prerequisite/dependency
 * switch, dependency lines drawn only on hover, and the Task flow preset.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ArchitectureStudio } from "./ArchitectureStudio";
import { clearWelcomeSuppression } from "./WelcomeModal";
import { validateTemplate, type DiagramTemplate } from "../contract/schema";

vi.mock("./JsonCodeEditor", () => ({
  JsonCodeEditor: ({ value, ariaLabel }: { value: string; ariaLabel?: string }) => (
    <textarea aria-label={ariaLabel ?? "Diagram JSON"} value={value} readOnly />
  ),
}));

function mount(ui: React.ReactElement) {
  return render(ui, {
    container: Object.assign(document.body.appendChild(document.createElement("div")), {
      style: "width: 1200px; height: 800px",
    }),
  });
}

const doc = (partial: Record<string, unknown>): DiagramTemplate =>
  validateTemplate({ version: 1, nodes: [], edges: [], ...partial });

const node = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;
const card = (container: HTMLElement, id: string) => node(container, id).querySelector<HTMLElement>(".as-node")!;
const edge = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`.react-flow__edge[data-id="${id}"]`)!;
const dormant = (container: HTMLElement, id: string) => edge(container, id).classList.contains("as-edge--dormant");

/** design → build (prerequisite), and build waits on infra far away (dependency). */
const PLAN = doc({
  nodes: [
    { id: "design", label: "Design", kind: "task", x: 0, y: 0, assignees: ["Ana"], storyPoints: 2 },
    { id: "build", label: "Build", kind: "task", x: 300, y: 0, assignees: ["Ravi", "Ana"], storyPoints: 5 },
    { id: "infra", label: "Infra", kind: "task", x: 0, y: 400, assignees: ["Ravi"] },
    { id: "svc", label: "Service", kind: "service", x: 700, y: 0 },
  ],
  edges: [
    { id: "pre", source: "design", target: "build" },
    { id: "dep", source: "infra", target: "build", relation: "dependency", style: "dashed", color: "sky" },
    { id: "plain", source: "build", target: "svc" },
  ],
});

beforeEach(() => clearWelcomeSuppression());

describe("task cards", () => {
  it("toggle done from the corner check without selecting the card, one undo step each", async () => {
    const seen: DiagramTemplate[] = [];
    const { container } = mount(<ArchitectureStudio defaultValue={PLAN} onChange={(d) => seen.push(d)} />);
    await waitFor(() => expect(node(container, "design")).toBeTruthy());

    const check = within(node(container, "design")).getByRole("checkbox", { name: /Design/ });
    expect(check).toHaveAttribute("aria-checked", "false");
    fireEvent.click(check);

    await waitFor(() => expect(seen.at(-1)?.nodes.find((n) => n.id === "design")?.done).toBe(true));
    expect(card(container, "design").classList.contains("as-node--done")).toBe(true);
    expect(node(container, "design").classList.contains("selected")).toBe(false);

    fireEvent.keyDown(window, { key: "z", metaKey: true });
    await waitFor(() => expect(seen.at(-1)?.nodes.find((n) => n.id === "design")?.done).toBeUndefined());
  });

  it("show the check as a picture, not a control, to a reader", async () => {
    const { container } = mount(<ArchitectureStudio defaultValue={PLAN} readOnly />);
    await waitFor(() => expect(node(container, "design")).toBeTruthy());
    expect(within(node(container, "design")).queryByRole("checkbox")).toBeNull();
    expect(within(node(container, "design")).getByRole("img", { name: "Not done" })).toBeTruthy();
  });

  it("strike a blocked task's check through and refuse it, until what it waits on is done", async () => {
    const seen: DiagramTemplate[] = [];
    const { container } = mount(<ArchitectureStudio defaultValue={PLAN} onChange={(d) => seen.push(d)} />);
    await waitFor(() => expect(node(container, "build")).toBeTruthy());
    // No Ready or Blocked label on any card — the check says it.
    expect(within(container).queryByText("Blocked")).toBeNull();
    expect(within(container).queryByText("Ready")).toBeNull();
    const check = within(node(container, "build")).getByRole("checkbox");
    expect(check.classList.contains("as-task__check--blocked")).toBe(true);
    expect(check).toHaveAttribute("aria-disabled", "true");
    expect(check.title).toBe("Blocked — waiting on Design, Infra");
    expect(check.getAttribute("aria-label")).toBe("Build — Blocked — waiting on Design, Infra");
    expect(check.querySelector(".as-task__slash")).toBeTruthy();
    const open = within(node(container, "design")).getByRole("checkbox");
    expect(open.classList.contains("as-task__check--blocked")).toBe(false);
    expect(open.hasAttribute("aria-disabled")).toBe(false);

    fireEvent.click(check);
    expect(check).toHaveAttribute("aria-checked", "false");
    expect(seen.some((d) => d.nodes.find((n) => n.id === "build")?.done)).toBe(false);
    expect(node(container, "build").classList.contains("selected")).toBe(false);

    fireEvent.click(open);
    fireEvent.click(within(node(container, "infra")).getByRole("checkbox"));
    await waitFor(() => expect(within(node(container, "build")).getByRole("checkbox").classList.contains("as-task__check--blocked")).toBe(false));
    const freed = within(node(container, "build")).getByRole("checkbox");
    expect(freed.hasAttribute("aria-disabled")).toBe(false);
    fireEvent.click(freed);
    await waitFor(() => expect(seen.at(-1)?.nodes.find((n) => n.id === "build")?.done).toBe(true));
  });

  it("show a blocked task's check struck through to a reader too", async () => {
    const { container } = mount(<ArchitectureStudio defaultValue={PLAN} readOnly />);
    await waitFor(() => expect(node(container, "build")).toBeTruthy());
    expect(within(node(container, "build")).getByRole("img", { name: "Blocked — waiting on Design, Infra" })).toBeTruthy();
  });

  it("name a renamed blocker in the tooltip as it is now", async () => {
    const { container } = mount(<ArchitectureStudio defaultValue={PLAN} />);
    await waitFor(() => expect(node(container, "design")).toBeTruthy());
    fireEvent.click(node(container, "design"));
    fireEvent.change(await screen.findByRole("textbox", { name: "Node label" }), { target: { value: "Design v2" } });
    const blocked = within(node(container, "build")).getByRole("checkbox");
    await waitFor(() => {
      fireEvent.pointerEnter(blocked);
      expect(blocked.title).toBe("Blocked — waiting on Design v2, Infra");
    });
  });

  it("hang a tab per person under the card and print the estimate", async () => {
    const { container } = mount(<ArchitectureStudio defaultValue={PLAN} />);
    await waitFor(() => expect(node(container, "build")).toBeTruthy());
    const tabs = [...node(container, "build").querySelectorAll(".as-node__assignee")].map((t) => t.textContent);
    expect(tabs).toEqual(["Ravi", "Ana"]);
    expect(within(node(container, "build")).getByText("5 pts")).toBeTruthy();
    // A service with no task fields draws none of it.
    expect(within(node(container, "svc")).queryByRole("checkbox")).toBeNull();
  });
});

describe("dependency lines", () => {
  it("hide until either end is hovered or selected, while prerequisites always show", async () => {
    const { container } = mount(<ArchitectureStudio defaultValue={PLAN} />);
    await waitFor(() => expect(edge(container, "dep")).toBeTruthy());
    expect(dormant(container, "dep")).toBe(true);
    expect(dormant(container, "pre")).toBe(false);
    expect(dormant(container, "plain")).toBe(false);

    fireEvent.mouseEnter(node(container, "infra"));
    await waitFor(() => expect(dormant(container, "dep")).toBe(false));
    fireEvent.mouseLeave(node(container, "infra"));
    await waitFor(() => expect(dormant(container, "dep")).toBe(true));

    fireEvent.click(node(container, "build"));
    await waitFor(() => expect(dormant(container, "dep")).toBe(false));
    // The prerequisite never went anywhere.
    expect(dormant(container, "pre")).toBe(false);
  });

  it("switch between prerequisite and dependency in the line's inspector", async () => {
    const seen: DiagramTemplate[] = [];
    const { container } = mount(<ArchitectureStudio defaultValue={PLAN} onChange={(d) => seen.push(d)} />);
    await waitFor(() => expect(edge(container, "pre")).toBeTruthy());
    fireEvent.click(edge(container, "pre"));

    const link = await screen.findByRole("group", { name: "Link type" });
    expect(within(link).getByRole("button", { name: "Prerequisite" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(link).getByRole("button", { name: "Dependency (on hover)" }));
    await waitFor(() =>
      expect(seen.at(-1)?.edges.find((e) => e.id === "pre")).toMatchObject({ relation: "dependency", style: "dashed", color: "sky" }),
    );

    fireEvent.click(within(link).getByRole("button", { name: "Prerequisite" }));
    await waitFor(() => {
      const back = seen.at(-1)?.edges.find((e) => e.id === "pre");
      expect(back?.relation).toBeUndefined();
      expect(back).toMatchObject({ style: "solid", color: "slate" });
    });
  });
});

describe("people", () => {
  /** Ana → Ravi → Ravi → a service: lines Ana is and isn't part of. */
  const TEAM = doc({
    nodes: [
      { id: "a", label: "A", kind: "task", x: 0, y: 0, assignees: ["Ana"] },
      { id: "b", label: "B", kind: "task", x: 300, y: 0, assignees: ["Ravi"] },
      { id: "c", label: "C", kind: "task", x: 600, y: 0, assignees: ["Ravi"] },
      { id: "svc", label: "Svc", kind: "service", x: 900, y: 0 },
    ],
    edges: [
      { id: "ab", source: "a", target: "b" },
      { id: "bc", source: "b", target: "c" },
      { id: "csvc", source: "c", target: "svc" },
    ],
  });
  const muted = (container: HTMLElement, id: string) => card(container, id).classList.contains("as-node--dimmed");
  const outside = (container: HTMLElement, id: string) => edge(container, id).classList.contains("as-edge--outside");
  const person = async (name: string) =>
    within(await screen.findByRole("group", { name: "People" })).getByRole("button", { name: new RegExp(name) });

  it("are listed in the legend with the open work each holds", async () => {
    mount(<ArchitectureStudio defaultValue={PLAN} />);
    // Ana holds Design (2) and Build (5), both open.
    expect((await person("Ana")).textContent).toContain("7 pts");
  });

  it("focus on click: their cards stay, every other node and every line they aren't part of recedes", async () => {
    const { container } = mount(<ArchitectureStudio defaultValue={TEAM} />);
    fireEvent.click(await person("Ana"));
    await waitFor(() => expect(muted(container, "b")).toBe(true));
    expect(muted(container, "a")).toBe(false);
    expect(muted(container, "c")).toBe(true);
    expect(muted(container, "svc")).toBe(true);
    // a → b touches Ana's task, so it stays, whoever is at its other end.
    expect(outside(container, "ab")).toBe(false);
    expect(outside(container, "bc")).toBe(true);
    expect(outside(container, "csvc")).toBe(true);

    fireEvent.click(await person("Ana"));
    await waitFor(() => expect(muted(container, "b")).toBe(false));
    expect(outside(container, "bc")).toBe(false);
  });

  it("preview on hover: only other people's task cards recede — lines and other nodes stay", async () => {
    const { container } = mount(<ArchitectureStudio defaultValue={TEAM} />);
    fireEvent.mouseEnter(await person("Ravi"));
    await waitFor(() => expect(muted(container, "a")).toBe(true));
    expect(muted(container, "b")).toBe(false);
    expect(muted(container, "c")).toBe(false);
    expect(muted(container, "svc")).toBe(false);
    expect(outside(container, "ab")).toBe(false);

    fireEvent.mouseLeave(await person("Ravi"));
    await waitFor(() => expect(muted(container, "a")).toBe(false));
  });

  it("previews someone else over a focus, and the focus returns when the pointer leaves", async () => {
    const { container } = mount(<ArchitectureStudio defaultValue={TEAM} />);
    const ana = await person("Ana");
    fireEvent.mouseEnter(ana);
    fireEvent.click(ana);
    // Hovering the person in focus keeps the focus — lines included.
    await waitFor(() => expect(outside(container, "bc")).toBe(true));
    fireEvent.mouseLeave(ana);

    fireEvent.mouseEnter(await person("Ravi"));
    await waitFor(() => expect(muted(container, "a")).toBe(true));
    expect(muted(container, "b")).toBe(false);
    expect(muted(container, "svc")).toBe(false);
    expect(outside(container, "bc")).toBe(false);

    fireEvent.mouseLeave(await person("Ravi"));
    await waitFor(() => expect(muted(container, "b")).toBe(true));
    expect(muted(container, "a")).toBe(false);
    expect(outside(container, "bc")).toBe(true);
  });

  it("are offered to a task's picker from the whole document, and a new name can be added", async () => {
    const seen: DiagramTemplate[] = [];
    const { container } = mount(<ArchitectureStudio defaultValue={PLAN} onChange={(d) => seen.push(d)} />);
    await waitFor(() => expect(node(container, "infra")).toBeTruthy());
    fireEvent.click(node(container, "infra"));

    const picker = await screen.findByRole("group", { name: "Assignees" });
    // Ana is on other tasks only — still offered here.
    fireEvent.click(within(picker).getByRole("button", { name: "Ana" }));
    await waitFor(() => expect(seen.at(-1)?.nodes.find((n) => n.id === "infra")?.assignees).toEqual(["Ravi", "Ana"]));

    const add = within(picker).getByRole("textbox", { name: "Assignees — add" });
    fireEvent.change(add, { target: { value: "Mo" } });
    fireEvent.keyDown(add, { key: "Enter" });
    await waitFor(() =>
      expect(seen.at(-1)?.nodes.find((n) => n.id === "infra")?.assignees).toEqual(["Ravi", "Ana", "Mo"]),
    );
  });
});

describe("Task flow preset", () => {
  it("starts the plan with a task when inserted by hand", async () => {
    const user = userEvent.setup();
    const seen: DiagramTemplate[] = [];
    mount(<ArchitectureStudio defaultValue={doc({})} onChange={(d) => seen.push(d)} />);
    await user.click(screen.getByRole("button", { name: "Task flow" }));
    await user.click(screen.getByRole("button", { name: /Insert Task Manually/ }));
    await waitFor(() => expect(seen.at(-1)?.nodes.map((n) => n.kind)).toEqual(["task"]));
  });
});

describe("planning", () => {
  /** A sprint holding a chain spec → api → qa → launch, with a stage, a priority and a late date. */
  const SPRINT = doc({
    settings: { capacity: { Ana: 4 } },
    nodes: [
      { id: "s1", label: "Sprint 1", kind: "group", x: 0, y: 0, w: 1400, h: 400, capacity: 10 },
      { id: "spec", label: "Spec", kind: "task", parentId: "s1", x: 30, y: 60, storyPoints: 2, assignees: ["Ana"], done: true },
      { id: "api", label: "API", kind: "task", parentId: "s1", x: 330, y: 60, storyPoints: 5, assignees: ["Ana"], stage: "in-progress", priority: "p1" },
      { id: "ui", label: "UI", kind: "task", parentId: "s1", x: 330, y: 220, storyPoints: 3, assignees: ["Ravi"], date: "2020-01-01" },
      { id: "qa", label: "QA", kind: "task", parentId: "s1", x: 630, y: 60, storyPoints: 1 },
      { id: "launch", label: "Launch", kind: "milestone", parentId: "s1", x: 930, y: 60 },
    ],
    edges: [
      { id: "s-a", source: "spec", target: "api" },
      { id: "a-q", source: "api", target: "qa" },
      { id: "q-l", source: "qa", target: "launch" },
    ],
  });

  it("shows a task's priority, stage, whether it can move, and its due date going late", async () => {
    const { container } = mount(<ArchitectureStudio defaultValue={SPRINT} />);
    await waitFor(() => expect(node(container, "api")).toBeTruthy());
    expect(within(node(container, "api")).getByText("P1")).toBeTruthy();
    expect(within(node(container, "api")).getByText("In progress")).toBeTruthy();
    // UI waits on nothing: an open check, not struck through.
    expect(within(node(container, "ui")).getByRole("checkbox").classList.contains("as-task__check--blocked")).toBe(false);
    expect(within(node(container, "qa")).getByRole("checkbox").classList.contains("as-task__check--blocked")).toBe(true);
    const due = node(container, "ui").querySelector(".as-date")!;
    expect(due.getAttribute("title")).toMatch(/^Due .* — overdue$/);
    expect(due.classList.contains("as-date--overdue")).toBe(true);
  });

  it("marks a milestone reached once everything feeding it is done", async () => {
    const done = doc({ ...SPRINT, nodes: SPRINT.nodes.map((n) => (n.kind === "task" ? { ...n, done: true } : n)) });
    const { container } = mount(<ArchitectureStudio defaultValue={done} />);
    await waitFor(() => expect(within(node(container, "launch")).getByText("Reached")).toBeTruthy());
  });

  it("rolls a sprint's tasks up in its label, against its capacity", async () => {
    const { container } = mount(<ArchitectureStudio defaultValue={SPRINT} />);
    await waitFor(() => expect(node(container, "s1")).toBeTruthy());
    const rollup = node(container, "s1").querySelector(".as-rollup")!;
    expect(rollup.textContent).toBe("2/11 pts · cap 10");
    expect(rollup.classList.contains("as-rollup--over")).toBe(true);
  });

  it("sums the plan in the legend, and its counts filter the canvas", async () => {
    const { container } = mount(<ArchitectureStudio defaultValue={SPRINT} />);
    const plan = await screen.findByRole("group", { name: "Plan" });
    expect(plan.textContent).toContain("2/11 pts");
    fireEvent.click(within(plan).getByRole("button", { name: /1 blocked/ }));
    await waitFor(() => expect(card(container, "ui").classList.contains("as-node--dimmed")).toBe(true));
    expect(card(container, "qa").classList.contains("as-node--dimmed")).toBe(false);
    // Ana holds 5 open points against a capacity of 4.
    const ana = within(await screen.findByRole("group", { name: "People" })).getByRole("button", { name: /Ana/ });
    expect(ana.textContent).toContain("5/4 pts");
    expect(ana.querySelector(".as-legend__count--over")).toBeTruthy();
  });

  it("lights the critical path from the View menu", async () => {
    const user = userEvent.setup();
    const { container } = mount(<ArchitectureStudio defaultValue={SPRINT} />);
    await waitFor(() => expect(edge(container, "a-q")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: /^View/ }));
    await user.click(screen.getByRole("checkbox", { name: "Show critical path" }));
    const legend = await screen.findByRole("group", { name: "Critical path" });
    expect(legend.textContent).toContain("6 pts left");
    await waitFor(() => expect(edge(container, "a-q").classList.contains("as-path-edge")).toBe(true));
  });

  it("filters to one kind of task from the View menu", async () => {
    const user = userEvent.setup();
    const { container } = mount(<ArchitectureStudio defaultValue={SPRINT} />);
    await waitFor(() => expect(node(container, "ui")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: /^View/ }));
    await user.click(screen.getByRole("radio", { name: "Overdue" }));
    await waitFor(() => expect(card(container, "api").classList.contains("as-node--dimmed")).toBe(true));
    expect(card(container, "ui").classList.contains("as-node--dimmed")).toBe(false);
  });

  it("keeps the filter that's on in the legend, even once nothing is left in it", async () => {
    const user = userEvent.setup();
    const { container } = mount(<ArchitectureStudio defaultValue={SPRINT} />);
    const plan = await screen.findByRole("group", { name: "Plan" });
    await user.click(within(plan).getByRole("button", { name: /1 overdue/ }));
    await waitFor(() => expect(card(container, "api").classList.contains("as-node--dimmed")).toBe(true));
    // Finishing the one late task leaves nothing to show — and the way back.
    fireEvent.click(within(node(container, "ui")).getByRole("checkbox"));
    const cleared = await within(plan).findByRole("button", { name: /0 overdue/ });
    expect(cleared.getAttribute("aria-pressed")).toBe("true");
    await user.click(cleared);
    await waitFor(() => expect(card(container, "api").classList.contains("as-node--dimmed")).toBe(false));
    expect(within(plan).queryByRole("button", { name: /overdue/ })).toBeNull();
  });

  it("shows a View-menu filter in the legend too", async () => {
    const user = userEvent.setup();
    mount(<ArchitectureStudio defaultValue={SPRINT} />);
    const plan = await screen.findByRole("group", { name: "Plan" });
    expect(within(plan).queryByRole("button", { name: /in progress/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: /^View/ }));
    await user.click(screen.getByRole("radio", { name: "In progress" }));
    expect(within(plan).getByRole("button", { name: /1 in progress/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("weighs capacity only against points — an unestimated plan counts tasks alone", async () => {
    const unestimated = doc({
      settings: { capacity: { Ana: 4 } },
      nodes: [
        { id: "a", label: "A", kind: "task", x: 0, y: 0, assignees: ["Ana"] },
        { id: "b", label: "B", kind: "task", x: 300, y: 0, assignees: ["Ana"] },
      ],
      edges: [],
    });
    mount(<ArchitectureStudio defaultValue={unestimated} />);
    const ana = within(await screen.findByRole("group", { name: "People" })).getByRole("button", { name: /Ana/ });
    expect(ana.querySelector(".as-legend__count")!.textContent).toBe("2");
  });

  it("re-counts what's overdue at midnight, with no edit to prompt it", async () => {
    // The fake clock also ticks with real time, so waitFor's own timers run.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
    try {
      vi.setSystemTime(new Date(2026, 9, 2, 23, 58, 0));
      const dueToday = doc({ nodes: [{ id: "t", label: "T", kind: "task", x: 0, y: 0, date: "2026-10-02" }], edges: [] });
      const { container } = mount(<ArchitectureStudio defaultValue={dueToday} />);
      await waitFor(() => expect(node(container, "t")).toBeTruthy());
      const chip = () => node(container, "t").querySelector(".as-date")!;
      expect(chip().classList.contains("as-date--overdue")).toBe(false);
      act(() => vi.advanceTimersByTime(3 * 60_000));
      expect(chip().classList.contains("as-date--overdue")).toBe(true);
      expect(within(screen.getByRole("group", { name: "Plan" })).getByRole("button", { name: /1 overdue/ })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sets each person's capacity in the Team capacity dialog", async () => {
    const user = userEvent.setup();
    const seen: DiagramTemplate[] = [];
    mount(<ArchitectureStudio defaultValue={SPRINT} onChange={(d) => seen.push(d)} />);
    await user.click(await screen.findByRole("button", { name: /^View/ }));
    await user.click(screen.getByRole("menuitem", { name: /Team capacity/ }));
    const ravi = screen.getByRole("spinbutton", { name: "Ravi's capacity in story points" });
    await user.type(ravi, "6");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(seen.at(-1)?.settings?.capacity).toEqual({ Ana: 4, Ravi: 6 }));
  });

  it("sets a task's status and priority in the inspector", async () => {
    const seen: DiagramTemplate[] = [];
    const { container } = mount(<ArchitectureStudio defaultValue={SPRINT} onChange={(d) => seen.push(d)} />);
    await waitFor(() => expect(node(container, "qa")).toBeTruthy());
    fireEvent.click(node(container, "qa"));
    fireEvent.change(await screen.findByRole("combobox", { name: "Task status" }), { target: { value: "in-review" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Priority" }), { target: { value: "p0" } });
    await waitFor(() => expect(seen.at(-1)?.nodes.find((n) => n.id === "qa")).toMatchObject({ stage: "in-review", priority: "p0" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Task status" }), { target: { value: "done" } });
    await waitFor(() => {
      const qa = seen.at(-1)?.nodes.find((n) => n.id === "qa");
      expect(qa?.done).toBe(true);
      expect(qa?.stage).toBeUndefined();
    });
  });

  it("says what moved in the plan when comparing", async () => {
    const before = doc({ ...SPRINT, nodes: SPRINT.nodes.filter((n) => n.id !== "ui").map((n) => (n.id === "spec" ? { ...n, done: false } : n)) });
    mount(<ArchitectureStudio defaultValue={SPRINT} diffBase={before} />);
    const line = await screen.findByTitle("What moved in the plan since the baseline");
    expect(line.textContent).toBe("+1 task · 1 done · scope +3 pts");
  });
});

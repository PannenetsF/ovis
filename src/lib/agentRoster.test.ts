import { describe, expect, it } from "bun:test";
import type { Machine, MachineState } from "../../shared/machines.ts";
import type { AgentStatus, HerdrPane, SessionSnapshot } from "../../shared/protocol.ts";
import fixture from "../../site/demo/fixtures/machines.json";
import { agentRoster, groupAgentRows, splitAgentRows, type AgentRow } from "./agentRoster.ts";
import { sidebarPinKey } from "./sidebarPins.ts";

const template = fixture.machines[0]!.snapshot as SessionSnapshot;
const templatePane = template.panes.find((pane) => pane.agent) ?? template.panes[0]!;
const workspace = template.workspaces[0]!;

/** a PC whose agents are the named panes, in that order, each with its own status */
function machine(id: string, state: MachineState, panes: [id: string, status: AgentStatus, parent?: string, tokens?: Record<string, string>][]): Machine {
  const snapshot: SessionSnapshot = {
    ...template,
    panes: panes.map(([pane_id, agent_status, parent, tokens]): HerdrPane => ({ ...templatePane, pane_id, agent_status, workspace_id: workspace.workspace_id, agent: "claude", background_wait: undefined, tokens: tokens ?? {}, ...(parent ? { parent_pane_id: parent } : {}) })),
    agents: panes.map(([pane_id, agent_status], index) => ({ ...template.agents[0]!, pane_id, agent_status, agent: "claude", state_change_seq: index + 1 })),
  };
  return { id, name: id, kind: id === "local" ? "local" : "ssh", enabled: true, state, error: null, snapshot };
}

describe("agent roster", () => {
  it("keeps the pinned card first in pin order and each PC's rows in its own Activity order", () => {
    const machines = [machine("local", "connected", [["a", "done"], ["b", "blocked"], ["c", "working"]]), machine("remote", "connected", [["d", "idle"], ["e", "blocked"]])];
    const seqs = new Map<string, ReadonlyMap<string, number>>([["local", new Map([["a", 1], ["b", 2], ["c", 3]])], ["remote", new Map([["d", 9], ["e", 1]])]]);
    const split = agentRoster(machines, { byActivity: true, seqs: (id) => seqs.get(id) ?? new Map(), pinned: [sidebarPinKey("remote", "d"), sidebarPinKey("local", "c")] });
    const key = ({ machine, entry }: { machine: Machine; entry: { pane: HerdrPane } }) => `${machine.id}/${entry.pane.pane_id}`;
    expect(split.pinned.map(key)).toEqual(["remote/d", "local/c"]);
    // blocked first, then the latest change, within each PC; the PCs keep their order
    expect(split.rest.map(key)).toEqual(["local/b", "local/a", "remote/e"]);
  });

  it("draws each helper right under the agent that started it, after its earlier helpers, in either order", () => {
    // herdr-core's parent: c and d started from a, e from c; f names a pane that is no row
    const panes: [string, AgentStatus, string?][] = [["a", "working"], ["b", "idle"], ["c", "blocked", "a"], ["d", "working", "a"], ["e", "done", "c"], ["f", "blocked", "gone"]];
    const key = ({ entry }: { entry: { pane: HerdrPane } }) => entry.pane.pane_id;
    const seqs = new Map([["a", 1], ["b", 2], ["c", 3], ["d", 4], ["e", 5], ["f", 6]]);
    for (const byActivity of [false, true]) {
      const split = agentRoster([machine("local", "connected", panes)], { byActivity, seqs: () => seqs, pinned: [] });
      expect(split.rest.map(key)).toEqual(byActivity ? ["f", "a", "c", "e", "d", "b"] : ["a", "c", "e", "d", "b", "f"]);
    }
  });

  it("keeps rows that name each other as parents, and a row naming itself, in their own order", () => {
    const panes: [string, AgentStatus, string?][] = [["x", "idle", "y"], ["y", "idle", "x"], ["z", "idle", "z"]];
    const split = agentRoster([machine("local", "connected", panes)], { byActivity: false, seqs: () => new Map(), pinned: [] });
    expect(split.rest.map(({ entry }) => entry.pane.pane_id)).toEqual(["x", "y", "z"]);
  });

  describe("apart from background agents", () => {
    const background = { role: "background" };
    const parts = (machines: Machine[]) => {
      const { people, background: rest } = splitAgentRows(agentRoster(machines, { byActivity: false, seqs: () => new Map(), pinned: [] }).rest,
        ({ machine, entry }) => machine.state === "connected" ? entry.pane.agent_status : undefined);
      return { people: people.map(({ machine, entry }) => `${machine.id}/${entry.pane.pane_id}`), background: rest.map(({ machine, entry }) => `${machine.id}/${entry.pane.pane_id}`) };
    };

    it("moves panes tagged role=background, and the helpers they started, to the background part in their order", () => {
      const machines = [
        machine("local", "connected", [["a", "idle"], ["w1", "working", undefined, background], ["h", "working", "w1"], ["b", "working"], ["w2", "done", undefined, { role: " Background " }]]),
        machine("away", "disconnected", [["w3", "idle", undefined, background], ["c", "idle", undefined, { role: "lead" }]]),
      ];
      expect(parts(machines)).toEqual({ people: ["local/a", "local/b", "away/c"], background: ["local/w1", "local/h", "local/w2", "away/w3"] });
    });

    it("keeps a blocked background agent with the people's rows, so its question is never folded away", () => {
      const machines = [machine("local", "connected", [["a", "idle"], ["w1", "working", undefined, background], ["h", "blocked", "w1"], ["w2", "blocked", undefined, background]])];
      expect(parts(machines)).toEqual({ people: ["local/a", "local/h", "local/w2"], background: ["local/w1"] });
    });
    it("looks up a helper's agent among every row, so a helper of a pinned or filtered-out background agent stays background", () => {
      const all = agentRoster([machine("local", "connected", [["w1", "working", undefined, background], ["h", "working", "w1"], ["a", "idle"]])], { byActivity: false, seqs: () => new Map(), pinned: [sidebarPinKey("local", "w1")] });
      const { people, background: rest } = splitAgentRows(all.rest, ({ entry }) => entry.pane.agent_status, [...all.pinned, ...all.rest]);
      expect({ people: people.map(({ entry }) => entry.pane.pane_id), background: rest.map(({ entry }) => entry.pane.pane_id) }).toEqual({ people: ["a"], background: ["h"] });
    });

    it("lays out the background part anew, a helper whose agent stayed with the people standing as a root", () => {
      // c's agent b is blocked: c must not read as one of a's helpers
      const machines = [machine("local", "connected", [["a", "working", undefined, background], ["b", "blocked", "a"], ["c", "working", "b"], ["d", "working", "a"]])];
      expect(parts(machines)).toEqual({ people: ["local/b"], background: ["local/a", "local/d", "local/c"] });
    });

    it("lays out the people's rows anew too, a blocked helper of a background helper standing as a root", () => {
      // c's agent b went to the background part: d stays right under a, c follows as a root
      const machines = [machine("local", "connected", [["a", "idle"], ["b", "working", "a", background], ["c", "blocked", "b"], ["d", "working", "a"]])];
      expect(parts(machines)).toEqual({ people: ["local/a", "local/d", "local/c"], background: ["local/b"] });
    });
  });

  describe("apart from herdr-projects' threads", () => {
    const thread = { hp_role: "thread" };
    const parts = (machines: Machine[]) => {
      const split = splitAgentRows(agentRoster(machines, { byActivity: false, seqs: () => new Map(), pinned: [] }).rest,
        ({ machine, entry }) => machine.state === "connected" ? entry.pane.agent_status : undefined);
      const keys = (rows: AgentRow[]) => rows.map(({ machine, entry }) => `${machine.id}/${entry.pane.pane_id}`);
      return { people: keys(split.people), threads: keys(split.threads), background: keys(split.background), hidden: keys(split.hidden) };
    };

    it("moves hp_role=thread panes, and the helpers they started, to the threads part in their order", () => {
      // hp_role is matched in any case, with the spaces around it ignored, as role=background is
      const machines = [machine("local", "connected", [["a", "idle"], ["t1", "working", undefined, thread], ["h", "working", "t1"], ["b", "working"], ["t2", "done", undefined, { hp_role: " Thread " }]])];
      expect(parts(machines)).toEqual({ people: ["local/a", "local/b"], threads: ["local/t1", "local/h", "local/t2"], background: [], hidden: [] });
    });

    it("keeps a thread that needs the reader with the people's rows, as a background one is kept", () => {
      const machines = [machine("local", "connected", [["a", "idle"], ["t1", "blocked", undefined, thread], ["t2", "working", undefined, thread]])];
      expect(parts(machines)).toEqual({ people: ["local/a", "local/t1"], threads: ["local/t2"], background: [], hidden: [] });
    });

    it("reads role=background before hp_role, so a pane tagged both stands with the background agents", () => {
      const machines = [machine("local", "connected", [["a", "idle"], ["x", "working", undefined, { role: "background", hp_role: "thread" }]])];
      expect(parts(machines)).toEqual({ people: ["local/a"], threads: [], background: ["local/x"], hidden: [] });
    });

    it("takes a row whose own tokens name no role from the first tagged agent above it", () => {
      // a coordinator-tagged pane's helper is a person's row; a thread's helper is a thread
      const machines = [machine("local", "connected", [["c", "idle", undefined, { hp_role: "coordinator" }], ["h1", "working", "c"], ["t", "working", undefined, thread], ["h2", "working", "t"]])];
      expect(parts(machines)).toEqual({ people: ["local/c", "local/h1"], threads: ["local/t", "local/h2"], background: [], hidden: [] });
    });
  });

  describe("under herdr-projects' strict primary rule", () => {
    const thread = { hp_role: "thread" };
    const parts = (machines: Machine[]) => {
      const split = splitAgentRows(agentRoster(machines, { byActivity: false, seqs: () => new Map(), pinned: [] }).rest,
        ({ machine, entry }) => machine.state === "connected" ? entry.pane.agent_status : undefined);
      const keys = (rows: AgentRow[]) => rows.map(({ machine, entry }) => `${machine.id}/${entry.pane.pane_id}`);
      return { people: keys(split.people), threads: keys(split.threads), background: keys(split.background), hidden: keys(split.hidden) };
    };

    it("keeps coordinator and session, and hides every other role herdr-projects names", () => {
      const machines = [machine("local", "connected", [
        ["c", "idle", undefined, { hp_role: "coordinator" }],
        ["s", "working", undefined, { hp_role: " Session " }],
        ["o", "working", undefined, { hp_role: "other" }],
        ["g", "idle", undefined, { hp_role: "guest" }],
        ["n", "working", undefined, { hp_role: "something-new" }],
      ])];
      expect(parts(machines)).toEqual({ people: ["local/c", "local/s"], threads: [], background: [], hidden: ["local/o", "local/g", "local/n"] });
    });

    it("hides a helper of a pane that is itself hidden", () => {
      const machines = [machine("local", "connected", [["c", "idle", undefined, { hp_role: "coordinator" }], ["o", "working", undefined, { hp_role: "other" }], ["h", "working", "o"]])];
      expect(parts(machines)).toEqual({ people: ["local/c"], threads: [], background: [], hidden: ["local/o", "local/h"] });
    });

    it("leaves an untagged pane alone, since it was never herdr-projects' to file", () => {
      const machines = [machine("local", "connected", [["a", "idle"], ["b", "working"], ["o", "idle", undefined, { hp_role: "other" }]])];
      expect(parts(machines)).toEqual({ people: ["local/a", "local/b"], threads: [], background: [], hidden: ["local/o"] });
    });

    it("keeps a hidden pane that needs the reader with the people's rows, as the other parts do", () => {
      const machines = [machine("local", "connected", [["a", "idle", undefined, { hp_role: "coordinator" }], ["o", "blocked", undefined, { hp_role: "other" }]])];
      expect(parts(machines)).toEqual({ people: ["local/a", "local/o"], threads: [], background: [], hidden: [] });
    });

    it("reads role=background and hp_role=thread before hiding, so neither is dropped", () => {
      const machines = [machine("local", "connected", [["a", "idle", undefined, { hp_role: "coordinator" }], ["t", "working", undefined, thread], ["w", "working", undefined, { role: "background" }]])];
      expect(parts(machines)).toEqual({ people: ["local/a"], threads: ["local/t"], background: ["local/w"], hidden: [] });
    });
  });

  describe("in groups by state", () => {
    const key = ({ machine, entry }: AgentRow) => `${machine.id}/${entry.pane.pane_id}`;
    const grouped = (machines: Machine[], sort: "wait" | "recent" | "name", seqs: Record<string, Record<string, number>>, names: Record<string, string> = {}) =>
      groupAgentRows(agentRoster(machines, { byActivity: false, seqs: () => new Map(), pinned: [] }).rest, {
        sort,
        status: ({ machine, entry }) => machine.state === "connected" ? entry.pane.agent_status : undefined,
        name: ({ entry }) => names[entry.pane.pane_id] ?? entry.pane.pane_id,
        seqs: (id) => new Map(Object.entries(seqs[id] ?? {})),
      }).map(({ group, rows }) => [group, rows.map(key)]);

    it("lists needs-you, working, done, then idle, each PC's longest wait first; BG works, unknown and an away PC rest", () => {
      const machines = [
        machine("local", "connected", [["a", "blocked"], ["b", "working"], ["c", "blocked"], ["d", "done"], ["e", "idle"], ["f", "waiting" as AgentStatus], ["g", "mystery" as AgentStatus]]),
        machine("remote", "connected", [["h", "blocked"]]),
        machine("away", "disconnected", [["i", "blocked"]]),
      ];
      const seqs = { local: { a: 5, b: 1, c: 2, d: 3, e: 4, f: 6, g: 7 }, remote: { h: 1 } };
      expect(grouped(machines, "wait", seqs)).toEqual([
        ["blocked", ["local/c", "local/a", "remote/h"]],
        ["working", ["local/b", "local/f"]],
        ["done", ["local/d"]],
        ["idle", ["local/e", "local/g", "away/i"]],
      ]);
      expect(grouped(machines, "recent", seqs)[0]).toEqual(["blocked", ["local/a", "local/c", "remote/h"]]);
    });

    it("orders by name across PCs, numbers as numbers", () => {
      const machines = [machine("local", "connected", [["a", "idle"], ["b", "idle"]]), machine("remote", "connected", [["c", "idle"]])];
      expect(grouped(machines, "name", {}, { a: "task 10", b: "Beta", c: "task 9" })).toEqual([["idle", ["local/b", "remote/c", "local/a"]]]);
    });

    it("keeps a helper under its agent, in the group of the one of them that needs the reader most", () => {
      const machines = [machine("local", "connected", [["a", "working"], ["b", "blocked", "a"], ["c", "done"], ["d", "idle", "c"]])];
      expect(grouped(machines, "wait", { local: { a: 1, b: 2, c: 3, d: 4 } })).toEqual([
        ["blocked", ["local/a", "local/b"]],
        ["done", ["local/c", "local/d"]],
      ]);
    });
  });
});

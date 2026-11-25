import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, MiniMap, applyNodeChanges, getNodesBounds, useNodesInitialized, useReactFlow, type Connection, type Edge, type EdgeChange, type NodeChange, type IsValidConnection } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Group, Panel, Separator } from "react-resizable-panels";
import { compileGraph, engineDiagnostics, engineLimit, handleId, parseHandle, pinType, typesCompatible, type DataPinSpec, type Diagnostic, type GraphNode, type NodeSpec, type RuleGraph } from "@gamestudio/rules-core";
import { registry } from "../../lib/registry";
import { useProject } from "../../state/project";
import { useApp } from "../../state/app";
import { useFocus } from "../../state/focus";
import { Button, Empty, IconButton, Notice, TextInput } from "../../components/ui";
import { ErrorIcon, InfoIcon, RedoIcon, SearchIcon, UndoIcon, WarnIcon, OkIcon, GraphIcon } from "../../components/icons";
import { RuleNode, CATEGORY_COLOR, pinColor, type RuleFlowNode } from "./RuleNode";
import { GraphInspector, NodeInspector } from "./Inspector";
import { Simulator } from "./Simulator";
import { describeGraph } from "./describe";

const nodeTypes = { rule: RuleNode };
const NODE_MIME = "application/x-gamestudio-node";
const CATEGORY_ORDER = ["event", "guard", "action", "flow", "query", "variable", "logic", "math", "data", "config"];
const CATEGORY_LABEL: Record<string, string> = { event: "Events", guard: "Guards", action: "Actions", flow: "Flow", query: "Game state", variable: "Variables", logic: "Logic", math: "Math", data: "Values", config: "Settings" };

function uniqueNodeId(graph: RuleGraph, type: string): string {
  const base = type.split(".").pop()!.replace(/[^A-Za-z0-9]/g, "") || "node";
  for (let i = 1; ; i++) {
    const id = `${base}${i}`;
    if (!graph.nodes.some((n) => n.id === id)) return id;
  }
}

function pinOf(spec: NodeSpec, handle: string, side: "in" | "out") {
  const h = parseHandle(handle);
  if (!h) return null;
  return (side === "in" ? spec.inputs : spec.outputs).find((p) => p.id === h.pin && p.kind === h.kind) ?? null;
}

function Palette({ domain, engine, onAdd }: { domain: string; engine: string | undefined; onAdd: (type: string) => void }) {
  const [query, setQuery] = useState("");
  const specs = registry.forGraphDomain(domain);
  const q = query.trim().toLowerCase();
  const matches = specs.filter((s) => !q || s.title.toLowerCase().includes(q) || s.type.includes(q) || s.keywords?.some((k) => k.includes(q)));
  return (
    <div className="panel" aria-label="Node palette">
      <div className="panel__header">
        <span className="panel__title">Nodes</span>
      </div>
      <div className="palette-search">
        <div className="row" style={{ gap: 6 }}>
          <SearchIcon style={{ width: 14, height: 14, color: "var(--text-3)" }} />
          <input className="input" placeholder="Search nodes" aria-label="Search nodes" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </div>
      <div className="panel__body">
        {CATEGORY_ORDER.map((cat) => {
          const items = matches.filter((s) => s.category === cat);
          if (items.length === 0) return null;
          return (
            <div key={cat} className="palette-group">
              <div className="section-label" style={{ padding: "2px 12px 4px" }}>{CATEGORY_LABEL[cat]}</div>
              {items.map((s) => {
                // Nodes this project's game cannot run stay listed, greyed out, with the reason.
                const limit = engine ? engineLimit(s, engine) : null;
                return (
                <button
                  key={s.type}
                  type="button"
                  className="palette-item"
                  draggable={!limit}
                  disabled={Boolean(limit)}
                  data-tip={limit ? `${limit}. ${s.description}` : s.description}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(NODE_MIME, s.type);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDoubleClick={() => onAdd(s.type)}
                  onKeyDown={(e) => e.key === "Enter" && onAdd(s.type)}
                  aria-label={`${s.title}: drag onto the canvas or press Enter to add`}
                >
                  <span className="palette-item__swatch" style={{ ["--cat" as string]: CATEGORY_COLOR[s.category] }} />
                  <span className="truncate">{s.title}</span>
                  {s.domain !== "core" && <span className="badge" style={{ marginLeft: "auto" }}>{limit ? s.engines?.join(" ") : s.domain}</span>}
                </button>
                );
              })}
            </div>
          );
        })}
        {matches.length === 0 && <p className="xsmall muted" style={{ padding: 12 }}>No nodes match “{query}”.</p>}
      </div>
    </div>
  );
}

function Problems({ diagnostics, onSelect }: { diagnostics: Diagnostic[]; onSelect: (nodeId: string) => void }) {
  const shown = diagnostics.filter((d) => d.severity !== "info");
  if (shown.length === 0) return <div className="row small" style={{ padding: 12, color: "var(--green)" }}><OkIcon width={14} /> No problems. These rules compile.</div>;
  return (
    <div className="problems">
      {shown.map((d, i) => (
        <button key={i} type="button" className={`problem-row problem-row--${d.severity}`} onClick={() => d.nodeId && onSelect(d.nodeId)}>
          {d.severity === "error" ? <ErrorIcon /> : d.severity === "warning" ? <WarnIcon /> : <InfoIcon />}
          <span>{d.message}</span>
          {d.nodeId && <span className="mono xsmall faint" style={{ marginLeft: "auto" }}>{d.nodeId}</span>}
        </button>
      ))}
    </div>
  );
}

function DesignerCanvas({ path, graph }: { path: string; graph: RuleGraph }) {
  const updateDoc = useProject((s) => s.updateDoc);
  const engine = useProject((s) => s.manifest?.engine.id);
  const mode = useApp((s) => s.mode);
  const focus = useFocus((s) => s.request);
  const flow = useReactFlow();
  const past = useRef<RuleGraph[]>([]);
  const future = useRef<RuleGraph[]>([]);
  const [, bump] = useState(0);
  const [traced, setTraced] = useState<Set<string>>(new Set());
  const [bottomTab, setBottomTab] = useState<"problems" | "simulate" | "ir">("problems");
  const wrapper = useRef<HTMLDivElement>(null);
  // First view of a graph: fit it when that keeps labels readable, otherwise start at its left edge (where events are)
  // at a readable zoom. Plain fitView shrinks a 17-node graph in a narrow canvas until nothing can be read.
  const nodesReady = useNodesInitialized();
  const placedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!nodesReady || placedFor.current === path) return;
    placedFor.current = path;
    const el = wrapper.current;
    const all = flow.getNodes();
    if (!el || all.length === 0) return;
    const b = getNodesBounds(all);
    const pad = 36;
    const w = el.clientWidth;
    const h = el.clientHeight;
    const fit = Math.min((w - pad * 2) / Math.max(b.width, 1), (h - pad * 2) / Math.max(b.height, 1));
    const zoom = Math.min(1, Math.max(0.6, fit));
    const x = b.width * zoom <= w - pad * 2 ? (w - b.width * zoom) / 2 - b.x * zoom : pad - b.x * zoom;
    const y = b.height * zoom <= h - pad * 2 ? (h - b.height * zoom) / 2 - b.y * zoom : pad + 30 - b.y * zoom;
    void flow.setViewport({ x, y, zoom });
  }, [nodesReady, path, flow]);

  const commit = useCallback(
    (next: RuleGraph) => {
      past.current.push(graph);
      if (past.current.length > 100) past.current.shift();
      future.current = [];
      updateDoc(path, next);
      bump((x) => x + 1);
    },
    [graph, path, updateDoc],
  );
  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(graph);
    updateDoc(path, prev);
    bump((x) => x + 1);
  }, [graph, path, updateDoc]);
  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(graph);
    updateDoc(path, next);
    bump((x) => x + 1);
  }, [graph, path, updateDoc]);

  const compiled = useMemo(() => compileGraph(graph, registry), [graph]);
  // Compile problems, plus nodes this project's engine cannot run (saving refuses those too).
  const diagnostics = useMemo(() => [...compiled.diagnostics, ...(engine ? engineDiagnostics(graph, registry, engine) : [])], [compiled, graph, engine]);
  const byNode = useMemo(() => {
    const m = new Map<string, Diagnostic[]>();
    for (const d of diagnostics) if (d.nodeId) m.set(d.nodeId, [...(m.get(d.nodeId) ?? []), d]);
    return m;
  }, [diagnostics]);
  const connectedInputs = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const e of graph.edges) {
      const h = parseHandle(e.targetHandle);
      if (h?.kind === "data") m.set(e.target, [...(m.get(e.target) ?? []), h.pin]);
    }
    return m;
  }, [graph]);

  const [nodes, setNodes] = useState<RuleFlowNode[]>([]);
  const nodesRef = useRef<RuleFlowNode[]>([]);
  nodesRef.current = nodes;
  useEffect(() => {
    setNodes((prev) => {
      const old = new Map(prev.map((n) => [n.id, n]));
      return graph.nodes.flatMap((n) => {
        const spec = registry.get(n.type);
        if (!spec) return [];
        const o = old.get(n.id);
        return [{ id: n.id, type: "rule" as const, position: n.position, selected: o?.selected ?? false, ...(o?.measured ? { measured: o.measured } : {}), data: { node: n, spec, graph, diagnostics: byNode.get(n.id) ?? [], traced: traced.has(n.id), connectedInputs: connectedInputs.get(n.id) ?? [] } }];
      });
    });
  }, [graph, byNode, traced, connectedInputs]);

  const [selectedEdges, setSelectedEdges] = useState<Set<string>>(new Set());
  const edges: Edge[] = useMemo(
    () =>
      graph.edges.map((e) => {
        const h = parseHandle(e.sourceHandle);
        const src = graph.nodes.find((n) => n.id === e.source);
        const spec = src && registry.get(src.type);
        const pin = spec && h ? pinOf(spec, e.sourceHandle, "out") : null;
        const color = h?.kind === "exec" ? "var(--pin-exec)" : pin && spec && src ? pinColor(pinType(spec, src, graph, pin as DataPinSpec)) : "var(--pin-any)";
        return { id: e.id, source: e.source, sourceHandle: e.sourceHandle, target: e.target, targetHandle: e.targetHandle, selected: selectedEdges.has(e.id), style: { stroke: color, strokeWidth: h?.kind === "exec" ? 2.4 : 1.7, opacity: h?.kind === "exec" ? 0.9 : 0.75 } };
      }),
    [graph, selectedEdges],
  );

  const selectedNode = nodes.find((n) => n.selected)?.data.node ?? null;

  const onNodesChange = useCallback(
    (changes: NodeChange<RuleFlowNode>[]) => {
      const next = applyNodeChanges(changes, nodesRef.current);
      setNodes(next);
      const removed = changes.filter((c) => c.type === "remove").map((c) => c.id);
      const dragEnded = changes.some((c) => c.type === "position" && c.dragging === false);
      if (removed.length > 0) {
        commit({ ...graph, nodes: graph.nodes.filter((n) => !removed.includes(n.id)), edges: graph.edges.filter((e) => !removed.includes(e.source) && !removed.includes(e.target)) });
      } else if (dragEnded) {
        const pos = new Map(next.map((n) => [n.id, n.position]));
        const moved = graph.nodes.map((n) => {
          const p = pos.get(n.id);
          return p && (p.x !== n.position.x || p.y !== n.position.y) ? { ...n, position: { x: Math.round(p.x), y: Math.round(p.y) } } : n;
        });
        if (moved.some((n, i) => n !== graph.nodes[i])) commit({ ...graph, nodes: moved });
      }
    },
    [commit, graph],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const removed = changes.filter((c) => c.type === "remove").map((c) => c.id);
      if (removed.length) commit({ ...graph, edges: graph.edges.filter((e) => !removed.includes(e.id)) });
      const sel = changes.filter((c): c is Extract<EdgeChange, { type: "select" }> => c.type === "select");
      if (sel.length)
        setSelectedEdges((prev) => {
          const s = new Set(prev);
          for (const c of sel) {
            if (c.selected) s.add(c.id);
            else s.delete(c.id);
          }
          return s;
        });
    },
    [commit, graph],
  );

  const isValidConnection: IsValidConnection = useCallback(
    (c) => {
      if (!c.source || !c.target || !c.sourceHandle || !c.targetHandle || c.source === c.target) return false;
      const s = graph.nodes.find((n) => n.id === c.source);
      const t = graph.nodes.find((n) => n.id === c.target);
      const ss = s && registry.get(s.type);
      const ts = t && registry.get(t.type);
      if (!s || !t || !ss || !ts) return false;
      const sp = pinOf(ss, c.sourceHandle, "out");
      const tp = pinOf(ts, c.targetHandle, "in");
      if (!sp || !tp || sp.kind !== tp.kind) return false;
      if (sp.kind === "data") return typesCompatible(pinType(ss, s, graph, sp as DataPinSpec), pinType(ts, t, graph, tp as DataPinSpec));
      return true;
    },
    [graph],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (!isValidConnection(c)) return;
      const kind = parseHandle(c.sourceHandle!)!.kind;
      // Blueprint-style: a data input or an exec output holds one wire, so a new wire replaces the old one.
      const kept = graph.edges.filter((e) => (kind === "data" ? !(e.target === c.target && e.targetHandle === c.targetHandle) : !(e.source === c.source && e.sourceHandle === c.sourceHandle)));
      let n = graph.edges.length + 1;
      while (graph.edges.some((e) => e.id === `w${n}`)) n++;
      commit({ ...graph, edges: [...kept, { id: `w${n}`, source: c.source!, sourceHandle: c.sourceHandle!, target: c.target!, targetHandle: c.targetHandle! }] });
    },
    [commit, graph, isValidConnection],
  );

  const addNode = useCallback(
    (type: string, position?: { x: number; y: number }) => {
      const spec = registry.get(type);
      if (!spec) return;
      const limit = engine ? engineLimit(spec, engine) : null;
      if (limit) {
        useApp.getState().toast("info", `${spec.title}: ${limit.toLowerCase()}`);
        return;
      }
      if (spec.maxPerGraph !== undefined && graph.nodes.filter((n) => n.type === type).length >= spec.maxPerGraph) {
        useApp.getState().toast("info", `Only ${spec.maxPerGraph} '${spec.title}' per graph`);
        return;
      }
      let pos = position;
      if (!pos) {
        const r = wrapper.current?.getBoundingClientRect();
        pos = r ? flow.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 3 }) : { x: 0, y: 0 };
      }
      const id = uniqueNodeId(graph, type);
      commit({ ...graph, nodes: [...graph.nodes, { id, type, position: { x: Math.round(pos.x), y: Math.round(pos.y) }, params: {} }] });
      window.setTimeout(() => setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id }))), 0);
    },
    [commit, flow, graph, engine],
  );

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const type = e.dataTransfer.getData(NODE_MIME);
    if (type) addNode(type, flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
  };

  const selectNode = useCallback(
    (id: string) => {
      setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })));
      const n = graph.nodes.find((x) => x.id === id);
      if (n) flow.setCenter(n.position.x + 110, n.position.y + 40, { zoom: Math.max(flow.getZoom(), 0.9), duration: 300 });
    },
    [flow, graph],
  );

  useEffect(() => {
    if (focus && focus.path === path && focus.nodeId) selectNode(focus.nodeId);
  }, [focus]); // eslint-disable-line react-hooks/exhaustive-deps

  const showTrace = useCallback((ids: string[]) => {
    setTraced(new Set(ids));
    window.setTimeout(() => setTraced(new Set()), 2600);
  }, []);

  const updateNode = (id: string, patch: (n: GraphNode) => GraphNode) => commit({ ...graph, nodes: graph.nodes.map((n) => (n.id === id ? patch(n) : n)) });

  const duplicateSelected = () => {
    if (!selectedNode) return;
    const id = uniqueNodeId(graph, selectedNode.type);
    commit({ ...graph, nodes: [...graph.nodes, { ...structuredClone(selectedNode), id, position: { x: selectedNode.position.x + 40, y: selectedNode.position.y + 40 } }] });
  };

  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.filter((d) => d.severity === "warning").length;

  return (
    <div
      className="rule-editor"
      onKeyDown={(e) => {
        const target = e.target as HTMLElement;
        if (target.closest("input, textarea, select")) return;
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
          e.preventDefault();
          if (e.shiftKey) redo();
          else undo();
        } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
          e.preventDefault();
          duplicateSelected();
        }
      }}
    >
      <Group orientation="horizontal" style={{ height: "100%" }}>
        <Panel id="palette" defaultSize={230} minSize={170} maxSize={360} collapsible>
          <Palette domain={graph.domain} engine={engine} onAdd={(t) => addNode(t)} />
        </Panel>
        <Separator className="sep sep--v" />
        <Panel id="canvas" minSize={320}>
          <Group orientation="vertical" style={{ height: "100%" }}>
            <Panel id="flow" minSize={200}>
              <div className="rule-canvas" ref={wrapper} onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }} onDrop={onDrop} tabIndex={-1}>
                <div className="world-toolbar" style={{ left: 10, top: 10 }}>
                  <IconButton small label="Undo (⌘Z)" tip={past.current.length === 0 ? "Nothing to undo yet" : "Undo (⌘Z)"} disabled={past.current.length === 0} onClick={undo}><UndoIcon /></IconButton>
                  <IconButton small label="Redo (⇧⌘Z)" tip={future.current.length === 0 ? "Nothing to redo" : "Redo (⇧⌘Z)"} disabled={future.current.length === 0} onClick={redo}><RedoIcon /></IconButton>
                  <span className="row xsmall" style={{ padding: "0 8px", color: errors ? "#ffaaa3" : "var(--green)" }} data-testid="compile-status">
                    {errors ? <ErrorIcon width={13} /> : <OkIcon width={13} />}
                    {errors ? `${errors} error${errors === 1 ? "" : "s"}` : "Compiles"}
                    {warnings > 0 && <span className="muted">· {warnings} warning{warnings === 1 ? "" : "s"}</span>}
                  </span>
                </div>
                <ReactFlow<RuleFlowNode, Edge>
                  nodes={nodes}
                  edges={edges}
                  nodeTypes={nodeTypes}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  onConnect={onConnect}
                  isValidConnection={isValidConnection}
                  deleteKeyCode={["Backspace", "Delete"]}
                  minZoom={0.2}
                  maxZoom={1.8}
                  attributionPosition="top-right"
                  colorMode="dark"
                >
                  <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="#1d2c44" />
                  <Controls showInteractive={false} position="bottom-left" />
                  {mode !== "creator" && <MiniMap pannable zoomable position="bottom-right" nodeColor={(n) => CATEGORY_COLOR[(n as RuleFlowNode).data?.spec.category ?? "data"] ?? "#555"} maskColor="rgba(7,14,26,0.7)" />}
                </ReactFlow>
                {graph.nodes.length === 0 && (
                  <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
                    <Empty icon={<GraphIcon />} title="Empty rule graph">Drag an event such as On Start from the palette, then connect actions to its output.</Empty>
                  </div>
                )}
              </div>
            </Panel>
            <Separator className="sep sep--h" />
            <Panel id="bottom" defaultSize={170} minSize={36} collapsible>
              <div className="bottom-panel">
                <div className="tabs" role="tablist">
                  <button type="button" role="tab" className="tab" aria-selected={bottomTab === "problems"} onClick={() => setBottomTab("problems")}>
                    Problems {errors + warnings > 0 && <span className="tab__count">{errors + warnings}</span>}
                  </button>
                  <button type="button" role="tab" className="tab" aria-selected={bottomTab === "simulate"} onClick={() => setBottomTab("simulate")}>Simulate</button>
                  {mode === "developer" && <button type="button" role="tab" className="tab" aria-selected={bottomTab === "ir"} onClick={() => setBottomTab("ir")}>Compiled IR</button>}
                </div>
                <div className="panel__body">
                  {bottomTab === "problems" && <Problems diagnostics={diagnostics} onSelect={selectNode} />}
                  {bottomTab === "simulate" && <Simulator program={compiled.ok ? compiled.program ?? null : null} onTrace={showTrace} />}
                  {bottomTab === "ir" && <pre className="console">{compiled.program ? JSON.stringify(compiled.program, null, 2) : "No IR: the graph has errors."}</pre>}
                </div>
              </div>
            </Panel>
          </Group>
        </Panel>
        <Separator className="sep sep--v" />
        <Panel id="inspector" defaultSize={300} minSize={240} maxSize={480} collapsible>
          <div className="panel">
            <div className="panel__header">
              <span className="panel__title">{selectedNode ? "Node" : "Graph"}</span>
            </div>
            <div className="panel__body">
              {selectedNode && registry.get(selectedNode.type) ? (
                <NodeInspector
                  key={selectedNode.id}
                  node={selectedNode}
                  spec={registry.get(selectedNode.type)!}
                  graph={graph}
                  connectedInputs={connectedInputs.get(selectedNode.id) ?? []}
                  onParam={(id, v) => updateNode(selectedNode.id, (n) => ({ ...n, params: { ...n.params, [id]: v } }))}
                  onLabel={(label) => updateNode(selectedNode.id, (n) => { const { label: _old, ...rest } = n; return label.trim() ? { ...rest, label: label.trim() } : rest; })}
                  onDelete={() => commit({ ...graph, nodes: graph.nodes.filter((n) => n.id !== selectedNode.id), edges: graph.edges.filter((e) => e.source !== selectedNode.id && e.target !== selectedNode.id) })}
                />
              ) : (
                <GraphInspector graph={graph} onChange={commit} />
              )}
            </div>
          </div>
        </Panel>
      </Group>
    </div>
  );
}

const OWARE_SETTINGS: { node: string; param: string; label: string; help: string }[] = [
  { node: "oware.config.board", param: "seedsPerPit", label: "Seeds per pit", help: "Abapa uses 4 (48 seeds, 25 to win)." },
  { node: "oware.action.sow", param: "skipOrigin", label: "Skip the starting pit on laps", help: "Abapa: on." },
  { node: "oware.action.capture", param: "counts", label: "Capture when a pit holds", help: "Abapa: 2, 3." },
  { node: "oware.action.capture", param: "chain", label: "Chain captures backwards", help: "Abapa: on." },
  { node: "oware.action.capture", param: "grandSlam", label: "Grand slam", help: "Abapa: legal, but nothing is captured." },
  { node: "oware.guard.legal", param: "mustFeed", label: "Must feed an opponent with no seeds", help: "Abapa: on." },
  { node: "oware.guard.termination", param: "repetitionLimit", label: "End on repeated position (0 = off)", help: "A studio convention, not a traditional rule." },
];

const LUDO_SETTINGS: { node: string; param: string; label: string; help: string }[] = [
  { node: "ludo.guard.legal", param: "enterOn", label: "Rolls that bring a token out", help: "Classic: 6." },
  { node: "ludo.guard.sixes", param: "maxSixes", label: "6s in a row that lose the turn (0 = no limit)", help: "Classic: 3." },
  { node: "ludo.guard.legal", param: "blocks", label: "Two tokens of one colour form a block", help: "Classic here: off (a house rule in Nigeria and India)." },
  { node: "ludo.action.capture", param: "safeStarts", label: "Start squares are safe", help: "Classic here: on (a house rule)." },
  { node: "ludo.guard.legal", param: "exactFinish", label: "Exact count needed to reach home", help: "Classic: on." },
  { node: "ludo.config.setup", param: "tokens", label: "Tokens per player", help: "Classic: 4." },
];

function CreatorRules({ path, graph }: { path: string; graph: RuleGraph }) {
  const updateDoc = useProject((s) => s.updateDoc);
  const setMode = useApp((s) => s.setMode);
  const compiled = useMemo(() => compileGraph(graph, registry), [graph]);
  const handlers = useMemo(() => describeGraph(graph, registry), [graph]);
  const setParam = (nodeId: string, param: string, value: unknown) => updateDoc(path, { ...graph, nodes: graph.nodes.map((n) => (n.id === nodeId ? { ...n, params: { ...n.params, [param]: value } } : n)) });
  const owareRows = graph.domain === "oware" || graph.domain === "ludo" ? (graph.domain === "oware" ? OWARE_SETTINGS : LUDO_SETTINGS).map((s) => ({ ...s, target: graph.nodes.find((n) => n.type === s.node) })).filter((s) => s.target) : [];
  return (
    <div className="view__body view__body--padded">
      <div className="page stack" style={{ gap: 18, maxWidth: 860 }}>
        <div className="row">
          <div>
            <div className="view__title">{graph.name}</div>
            <div className="view__subtitle">{graph.description}</div>
          </div>
          <span className="spacer" />
          <Button size="small" icon={<GraphIcon />} onClick={() => setMode("designer")}>Open the node graph</Button>
        </div>
        {!compiled.ok && <Notice kind="error">These rules have problems: {compiled.diagnostics.filter((d) => d.severity === "error").map((d) => d.message).join("; ")}</Notice>}
        {owareRows.length > 0 && (
          <section className="card" style={{ padding: 16 }}>
            <div className="section-label" style={{ marginBottom: 10 }}>Variant settings</div>
            <div className="form-grid">
              {owareRows.map((row) => {
                const spec = registry.get(row.node)!.params.find((p) => p.id === row.param)!;
                const value = row.target!.params[row.param] ?? spec.default;
                const id = `creator-${row.node}-${row.param}`;
                return (
                  <div key={id} className="field">
                    <label className="field__label" htmlFor={id}>{row.label}</label>
                    {spec.kind === "boolean" ? (
                      <label className="switch"><input id={id} type="checkbox" role="switch" checked={value === true} onChange={(e) => setParam(row.target!.id, row.param, e.target.checked)} />{value === true ? "On" : "Off"}</label>
                    ) : spec.kind === "select" ? (
                      <select id={id} className="select" value={String(value)} onChange={(e) => setParam(row.target!.id, row.param, e.target.value)}>
                        {spec.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    ) : spec.kind === "numberList" ? (
                      <TextInput id={id} mono value={(value as number[]).join(", ")} onCommit={(s) => { const v = s.split(/[\s,]+/).filter(Boolean).map(Number); if (v.every(Number.isFinite)) setParam(row.target!.id, row.param, v); }} />
                    ) : (
                      <input id={id} className="input" type="number" value={Number(value)} onChange={(e) => setParam(row.target!.id, row.param, Number(e.target.value))} />
                    )}
                    <div className="field__help">{row.help}</div>
                  </div>
                );
              })}
            </div>
          </section>
        )}
        <section className="stack">
          <div className="section-label">What happens</div>
          {handlers.map((h) => (
            <div key={h.nodeId} className="card" style={{ padding: "12px 16px" }}>
              <div className="row" style={{ marginBottom: 8 }}>
                <span className="badge badge--accent">When</span>
                <strong>{h.event}</strong>
              </div>
              {h.steps.length === 0 && <div className="xsmall muted">Nothing is connected to this event yet.</div>}
              {h.steps.map((s, i) => (
                <div key={`${s.nodeId}-${i}`} className="row" style={{ paddingLeft: (s.depth - 1) * 18, gap: 8, minHeight: 30 }}>
                  {s.branch && <span className="badge badge--outline">{s.branch}</span>}
                  <span className="small">{s.text}</span>
                  {s.editable && (
                    <div style={{ flex: 1, minWidth: 180 }}>
                      <TextInput ariaLabel={`Text for ${s.text}`} value={s.editable.value} onCommit={(v) => setParam(s.nodeId, s.editable!.param, v)} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}

export function RuleEditor({ path }: { path: string }) {
  const doc = useProject((s) => s.docs[path]);
  const mode = useApp((s) => s.mode);
  if (!doc) return null;
  if (doc.error) return <div style={{ padding: 16 }}><Notice kind="error">{path} cannot be shown as a rule graph: {doc.error}. Switch to Developer mode to edit the file as text.</Notice></div>;
  const graph = doc.data as RuleGraph;
  if (!graph || !Array.isArray(graph.nodes)) return <div style={{ padding: 16 }}><Notice kind="error">{path} is not a rule graph.</Notice></div>;
  if (mode === "creator") return <CreatorRules path={path} graph={graph} />;
  return (
    <ReactFlowProvider>
      <DesignerCanvas path={path} graph={graph} />
    </ReactFlowProvider>
  );
}

export { handleId };

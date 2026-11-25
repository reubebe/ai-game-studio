import { useCallback, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { BLOCKING, TILE_LETTERS, TILES, paintTile, parseFarm, resizeMap, type Crop, type Farm, type TileLetter } from "@gamestudio/farm";
import { useProject } from "../../state/project";
import { Button, Field, IconButton, Notice, NumberInput, Switch, TextInput } from "../../components/ui";
import { PlusIcon, RedoIcon, TrashIcon, UndoIcon } from "../../components/icons";

/** Colours of each tile in the editor, close to how farm_map.gd draws them. */
const TILE_COLOR: Record<TileLetter, string> = { g: "#6aa84f", s: "#8d6e4a", p: "#d8c39a", w: "#3b82c4", t: "#2f6b3a", f: "#a3784a", h: "#efe3c8", m: "#e5484d" };
const TILE_LABEL: Record<TileLetter, string> = { g: "Grass", s: "Soil", p: "Path", w: "Water", t: "Tree", f: "Fence", h: "House", m: "Market stall" };
const TILE_TIP: Record<TileLetter, string> = {
  g: "Walkable grass",
  s: "Soil: the only tiles crops grow on",
  p: "A walkable path",
  w: "Water: blocks the way",
  t: "A tree: blocks the way",
  f: "A fence: blocks the way",
  h: "The house: E next to it sleeps until morning",
  m: "The market stall: E next to it sells the basket",
};
type Tool = TileLetter | "start";

function Tile({ x, y, t }: { x: number; y: number; t: TileLetter }) {
  const base = t === "t" || t === "f" ? TILE_COLOR.g : TILE_COLOR[t];
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect width={1.01} height={1.01} fill={base} />
      {t === "s" && [0.25, 0.5, 0.75].map((fy) => <line key={fy} x1={0.1} x2={0.9} y1={fy} y2={fy} stroke="rgba(0,0,0,0.18)" strokeWidth={0.04} />)}
      {t === "t" && <><rect x={0.42} y={0.55} width={0.16} height={0.38} fill="#6b4a2f" /><circle cx={0.5} cy={0.42} r={0.36} fill={TILE_COLOR.t} /></>}
      {t === "f" && <><rect x={0.12} y={0.25} width={0.12} height={0.6} fill="#8a6239" /><rect x={0.76} y={0.25} width={0.12} height={0.6} fill="#8a6239" /><rect y={0.4} width={1} height={0.1} fill={TILE_COLOR.f} /><rect y={0.66} width={1} height={0.1} fill={TILE_COLOR.f} /></>}
      {t === "w" && <path d="M0.2 0.4 q0.15 -0.12 0.3 0 t0.3 0" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth={0.05} />}
    </g>
  );
}

/** The tiles of one letter as one rectangle (the game draws the house and the stall over theirs, farm_map.gd). */
function area(rows: string[], letter: string): { x: number; y: number; w: number; h: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  rows.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch !== letter) return;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }));
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function House({ r }: { r: { x: number; y: number; w: number; h: number } }) {
  return (
    <g transform={`translate(${r.x} ${r.y})`} pointerEvents="none">
      <rect x={0.08} y={r.h * 0.38} width={r.w - 0.16} height={r.h * 0.6} fill="#efe3c8" />
      <polygon points={`-0.08,${r.h * 0.42} ${r.w / 2},0.04 ${r.w + 0.08},${r.h * 0.42}`} fill="#b5523b" />
      <rect x={r.w * 0.42} y={r.h * 0.6} width={r.w * 0.18} height={r.h * 0.38} fill="#6b4a2f" />
      <rect x={r.w * 0.14} y={r.h * 0.52} width={r.w * 0.18} height={r.h * 0.18} fill="#8ec5e8" />
    </g>
  );
}

function Stall({ r, colors }: { r: { x: number; y: number; w: number; h: number }; colors: string[] }) {
  const stripes = 6;
  return (
    <g transform={`translate(${r.x} ${r.y})`} pointerEvents="none">
      <rect x={0.04} y={r.h * 0.45} width={r.w - 0.08} height={r.h * 0.5} fill="#a3784a" />
      {Array.from({ length: stripes }, (_, i) => <rect key={i} x={(r.w * i) / stripes} y={0.08} width={r.w / stripes + 0.01} height={r.h * 0.3} fill={i % 2 === 0 ? "#e5484d" : "#f6f1e7"} />)}
      {colors.map((c, i) => <circle key={i} cx={(r.w * (i + 0.5)) / colors.length} cy={r.h * 0.45 + 0.2} r={0.14} fill={c} />)}
    </g>
  );
}

function CropsTable({ farm, onChange }: { farm: Farm; onChange: (crops: Crop[]) => void }) {
  const set = (i: number, patch: Partial<Crop>) => onChange(farm.crops.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const add = () => {
    let n = farm.crops.length + 1;
    while (farm.crops.some((c) => c.id === `crop_${n}`)) n++;
    onChange([...farm.crops, { id: `crop_${n}`, name: `Crop ${n}`, seedCost: 5, days: 3, yield: 2, price: 6, color: "#8bc34a", needsWater: true, regrow: 0 }]);
  };
  return (
    <div className="stack" style={{ gap: 6 }}>
      <table className="squad crops" aria-label="Crops">
        <thead>
          <tr>
            <th scope="col">Crop</th>
            <th scope="col" data-tip="Coins for one seed">Seed</th>
            <th scope="col" data-tip="Days of growth (watered days, when it needs water)">Days</th>
            <th scope="col" data-tip="How many come off one tile">Yield</th>
            <th scope="col" data-tip="What the market pays for one">Price</th>
            <th scope="col" />
          </tr>
        </thead>
        <tbody>
          {farm.crops.map((c, i) => (
            <tr key={c.id}>
              <td>
                <div className="row" style={{ gap: 4 }}>
                  <input type="color" className="crop-swatch" aria-label={`${c.name} colour`} value={c.color} onChange={(e) => set(i, { color: e.target.value })} />
                  <TextInput ariaLabel={`${c.id} name`} value={c.name} maxLength={24} onCommit={(name) => name.trim() && set(i, { name: name.trim() })} />
                </div>
              </td>
              <td><NumberInput ariaLabel={`${c.name} seed cost`} value={c.seedCost} min={0} max={10000} onCommit={(v) => set(i, { seedCost: Math.round(v) })} /></td>
              <td><NumberInput ariaLabel={`${c.name} days`} value={c.days} min={1} max={30} onCommit={(v) => set(i, { days: Math.round(v) })} /></td>
              <td><NumberInput ariaLabel={`${c.name} yield`} value={c.yield} min={1} max={20} onCommit={(v) => set(i, { yield: Math.round(v) })} /></td>
              <td><NumberInput ariaLabel={`${c.name} price`} value={c.price} min={0} max={10000} onCommit={(v) => set(i, { price: Math.round(v) })} /></td>
              <td>
                <IconButton label={`Remove ${c.name}`} tip={farm.crops.length > 1 ? `Remove ${c.name}` : "A farm needs at least one crop"} disabled={farm.crops.length <= 1} onClick={() => onChange(farm.crops.filter((_, j) => j !== i))}><TrashIcon /></IconButton>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="squad crops crop-growth" aria-label="Watering and regrowth">
        <thead>
          <tr>
            <th scope="col">Crop</th>
            <th scope="col" data-tip="Grows only on days it was watered or rained on">Needs water</th>
            <th scope="col" data-tip="Days to grow again after a harvest (0: the tile is bare again)">Grows again after (days)</th>
          </tr>
        </thead>
        <tbody>
          {farm.crops.map((c, i) => (
            <tr key={c.id}>
              <td className="small">{c.name}</td>
              <td><Switch checked={c.needsWater} label={<span className="sr-only">{c.name} needs water</span>} onChange={(needsWater) => set(i, { needsWater })} /></td>
              <td><NumberInput ariaLabel={`${c.name} regrow days`} value={c.regrow} min={0} max={30} onCommit={(v) => set(i, { regrow: Math.round(v) })} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div><Button size="small" icon={<PlusIcon />} disabled={farm.crops.length >= 8} tip={farm.crops.length >= 8 ? "A farm holds up to 8 crops" : "Add a crop to grow and sell"} onClick={add}>Add crop</Button></div>
      <p className="xsmall muted" style={{ margin: 0 }}>Rules name crops by id: {farm.crops.map((c) => c.id).join(", ")}.</p>
    </div>
  );
}

export function FarmEditor({ path }: { path: string }) {
  const doc = useProject((s) => s.docs[path]);
  const updateDoc = useProject((s) => s.updateDoc);
  const farm = doc?.data as Farm | undefined;
  const validation = useMemo(() => (farm ? parseFarm(farm) : null), [farm]);
  const past = useRef<Farm[]>([]);
  const future = useRef<Farm[]>([]);
  const [, bump] = useState(0);
  const [tool, setTool] = useState<Tool>("s");
  // A paint stroke draws on a draft and becomes one undo step when the button is released.
  const [draft, setDraft] = useState<Farm | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const commit = useCallback(
    (next: Farm) => {
      if (!farm) return;
      past.current.push(farm);
      if (past.current.length > 100) past.current.shift();
      future.current = [];
      updateDoc(path, next);
      bump((x) => x + 1);
    },
    [farm, path, updateDoc],
  );
  if (!farm || !validation) return <div style={{ padding: 16 }}><Notice kind="warn">The farm settings could not be read.</Notice></div>;
  const shown = draft ?? farm;
  const undo = () => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(farm);
    updateDoc(path, prev);
    bump((x) => x + 1);
  };
  const redo = () => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(farm);
    updateDoc(path, next);
    bump((x) => x + 1);
  };
  const cellAt = (e: ReactPointerEvent) => {
    const r = svg.current!.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * shown.map.width);
    const y = Math.floor(((e.clientY - r.top) / r.height) * shown.map.height);
    return x >= 0 && y >= 0 && x < shown.map.width && y < shown.map.height ? { x, y } : null;
  };
  const apply = (base: Farm, x: number, y: number): Farm => (tool === "start" ? { ...base, map: { ...base.map, spawn: { x, y } } } : paintTile(base, x, y, tool));
  const down = (e: ReactPointerEvent) => {
    const c = cellAt(e);
    if (!c) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDraft(apply(farm, c.x, c.y));
  };
  const move = (e: ReactPointerEvent) => {
    if (!draft || tool === "start") return;
    const c = cellAt(e);
    if (c && draft.map.rows[c.y]?.[c.x] !== tool) setDraft(apply(draft, c.x, c.y));
  };
  const up = () => {
    if (draft) commit(draft);
    setDraft(null);
  };
  const set = (patch: Partial<Farm>) => commit({ ...farm, ...patch });
  const counts = Object.fromEntries(TILE_LETTERS.map((t) => [t, shown.map.rows.join("").split(t).length - 1])) as Record<TileLetter, number>;
  return (
    <div className="match-editor farm-editor">
      <div className="match-editor__form inspector" aria-label="Farm settings">
        <div className="row" style={{ gap: 6, justifyContent: "space-between" }}>
          <div className="section-label">Farm</div>
          <div className="row" style={{ gap: 2 }}>
            <IconButton label="Undo" tip={past.current.length ? "Undo" : "Nothing to undo"} disabled={!past.current.length} onClick={undo}><UndoIcon /></IconButton>
            <IconButton label="Redo" tip={future.current.length ? "Redo" : "Nothing to redo"} disabled={!future.current.length} onClick={redo}><RedoIcon /></IconButton>
          </div>
        </div>
        <TextInput ariaLabel="Farm name" value={farm.name} maxLength={80} onCommit={(name) => name.trim() && set({ name: name.trim() })} />
        <div className="field-row">
          <Field label="Farmer's name" htmlFor="f-farmer"><TextInput id="f-farmer" value={farm.farmer.name} maxLength={24} onCommit={(name) => name.trim() && set({ farmer: { ...farm.farmer, name: name.trim() } })} /></Field>
          <Field label="Shirt" htmlFor="f-shirt"><input id="f-shirt" type="color" className="input" style={{ padding: 2 }} value={farm.farmer.shirt} onChange={(e) => set({ farmer: { ...farm.farmer, shirt: e.target.value } })} /></Field>
        </div>
        <div className="field-row">
          <Field label="Money is called" htmlFor="f-currency"><TextInput id="f-currency" value={farm.currency} maxLength={12} onCommit={(currency) => currency.trim() && set({ currency: currency.trim() })} /></Field>
          <Field label="Starting money" htmlFor="f-money"><NumberInput id="f-money" value={farm.startMoney} min={0} max={1000000} onCommit={(v) => set({ startMoney: Math.round(v) })} /></Field>
        </div>
        <div className="field-row">
          <Field label="Day length (s)" htmlFor="f-day" help="Sleeping ends a day early."><NumberInput id="f-day" value={farm.dayLength} min={20} max={900} step={5} onCommit={(dayLength) => set({ dayLength })} /></Field>
          <Field label="Rain chance (%)" htmlFor="f-rain" help="Rain waters every crop."><NumberInput id="f-rain" value={Math.round(farm.rainChance * 100)} min={0} max={100} step={5} onCommit={(v) => set({ rainChance: Math.round(v) / 100 })} /></Field>
        </div>
        <div className="section-label">Crops</div>
        <CropsTable farm={farm} onChange={(crops) => set({ crops })} />
        <div className="section-label">Map size</div>
        <div className="field-row">
          <Field label="Width (tiles)" htmlFor="f-w"><NumberInput id="f-w" value={farm.map.width} min={8} max={40} onCommit={(w) => commit(resizeMap(farm, Math.round(w), farm.map.height))} /></Field>
          <Field label="Height (tiles)" htmlFor="f-h"><NumberInput id="f-h" value={farm.map.height} min={6} max={30} onCommit={(h) => commit(resizeMap(farm, farm.map.width, Math.round(h)))} /></Field>
        </div>
        {!validation.ok && <Notice kind="error">{validation.errors.join("; ")}</Notice>}
      </div>
      <div className="match-editor__preview farm-editor__map">
        <div className="farm-tools" role="group" aria-label="Paint">
          {TILE_LETTERS.map((t) => (
            <button key={t} type="button" className="farm-tool" aria-pressed={tool === t} data-tip={TILE_TIP[t]} onClick={() => setTool(t)}>
              <span className="farm-tool__swatch" style={{ background: TILE_COLOR[t] }} />
              {TILE_LABEL[t]}
              <span className="muted xsmall">{counts[t]}</span>
            </button>
          ))}
          <button type="button" className="farm-tool" aria-pressed={tool === "start"} data-tip="Where the farmer wakes each morning (a walkable tile)" onClick={() => setTool("start")}>
            <span className="farm-tool__swatch farm-tool__start" />
            Farmer's start
          </button>
        </div>
        <svg
          ref={svg}
          className="farm-map"
          viewBox={`0 0 ${shown.map.width} ${shown.map.height}`}
          role="application"
          aria-label={`Farm map, ${shown.map.width} by ${shown.map.height} tiles: click or drag to paint ${tool === "start" ? "the farmer's start" : TILE_LABEL[tool].toLowerCase()}`}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
        >
          {shown.map.rows.map((row, y) => [...row].map((ch, x) => <Tile key={`${x},${y}`} x={x} y={y} t={(ch in TILES ? ch : "g") as TileLetter} />))}
          {(() => {
            const house = area(shown.map.rows, "h");
            const stall = area(shown.map.rows, "m");
            return <>{house && <House r={house} />}{stall && <Stall r={stall} colors={shown.crops.map((c) => c.color)} />}</>;
          })()}
          <g transform={`translate(${shown.map.spawn.x + 0.5} ${shown.map.spawn.y + 0.5})`} pointerEvents="none">
            <circle r={0.34} fill={shown.farmer.shirt} stroke="#ffffff" strokeWidth={0.06} />
            <circle r={0.2} cy={-0.05} fill="#e9cf7a" />
          </g>
        </svg>
        <div className="xsmall muted">
          {shown.name}: {counts.s} soil tiles{BLOCKING.includes(shown.map.rows[shown.map.spawn.y]?.[shown.map.spawn.x] as TileLetter) ? " · the farmer's start is blocked" : ""}. Click or drag on the map to paint.
        </div>
      </div>
    </div>
  );
}

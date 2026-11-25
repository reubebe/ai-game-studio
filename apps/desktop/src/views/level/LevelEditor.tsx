import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { AudioSettings } from "../world/AudioSettings";
import { LEVEL_OBJECT_DEFAULTS, LEVEL_OBJECT_TYPES, nextLevelObjectId, objectBox, parseLevel, PLATFORMER_SOUNDS, PLATFORM_STYLES, SPRITE_STATES, type Level, type LevelObject, type LevelObjectType, type Sprite } from "@gamestudio/platformer";
import { useProject } from "../../state/project";
import { backend } from "../../lib/backend";
import { Button, Field, IconButton, Notice, NumberInput, Segmented, Switch, TextInput } from "../../components/ui";
import { CopyIcon, FlagIcon, FocusIcon, GateIcon, GemIcon, LayersIcon, RedoIcon, SearchIcon, SignIcon, TrashIcon, UndoIcon, ZapIcon, ZoomInIcon, ZoomOutIcon, BirdIcon, TargetIcon } from "../../components/icons";

const TYPE_META: Record<LevelObjectType, { label: string; icon: ReactNode; prefix: string }> = {
  platform: { label: "Platform", icon: <LayersIcon />, prefix: "platform" },
  coin: { label: "Coin", icon: <GemIcon />, prefix: "coin" },
  spike: { label: "Spikes", icon: <ZapIcon />, prefix: "spikes" },
  checkpoint: { label: "Checkpoint flag", icon: <FlagIcon />, prefix: "checkpoint" },
  goal: { label: "Goal flag", icon: <TargetIcon />, prefix: "goal" },
  enemy: { label: "Beetle (patrols)", icon: <BirdIcon />, prefix: "beetle" },
  door: { label: "Door (rules open it)", icon: <GateIcon />, prefix: "door" },
  sign: { label: "Sign", icon: <SignIcon />, prefix: "sign" },
};
const STYLE_FILL: Record<string, [string, string]> = { grass: ["#7a4e2d", "#5cb84a"], stone: ["#7d8290", "#a3a9b5"], wood: ["#9c6b3d", "#c08a52"] };
const OBJ_MIME = "application/x-gamestudio-level-object";
const fix = (n: number) => Math.round(n * 100) / 100;
const snapTo = (n: number, step: number) => Math.round(n / step) * step;

/** One object drawn in level units with y pointing down (the SVG's y is minus the level's y). */
function Shape({ o, selected, pictureUrl }: { o: LevelObject; selected: boolean; pictureUrl?: ((asset: string) => string | null) | undefined }) {
  const b = objectBox(o);
  const outline = selected ? <rect x={b.x - 0.15} y={-(b.y + b.height) - 0.15} width={b.width + 0.3} height={b.height + 0.3} fill="none" stroke="var(--mode-accent)" strokeWidth={0.12} strokeDasharray="0.4 0.25" /> : null;
  let body: ReactNode;
  switch (o.type) {
    case "platform": {
      const [fill, top] = STYLE_FILL[o.style] ?? STYLE_FILL["grass"]!;
      const url = o.texture ? pictureUrl?.(o.texture) : null;
      if (o.texture && url) {
        // The picture repeats every `tile` tiles from the platform's top left, as level_builder.gd draws it.
        const span = o.tile ?? 1;
        const pid = `pic-${o.id}`;
        body = (
          <>
            <defs>
              <pattern id={pid} patternUnits="userSpaceOnUse" x={o.x} y={-(o.y + o.height)} width={span} height={span}>
                <image href={url} width={span} height={span} preserveAspectRatio="none" />
              </pattern>
            </defs>
            <rect x={o.x} y={-(o.y + o.height)} width={o.width} height={o.height} fill={`url(#${pid})`} />
          </>
        );
        break;
      }
      body = <><rect x={o.x} y={-(o.y + o.height)} width={o.width} height={o.height} fill={fill} /><rect x={o.x} y={-(o.y + o.height)} width={o.width} height={Math.min(0.3, o.height)} fill={top} />{o.style === "wood" && <line x1={o.x} x2={o.x + o.width} y1={-o.y} y2={-o.y} stroke="#6e4a28" strokeWidth={0.08} strokeDasharray="0.3 0.2" />}</>;
      break;
    }
    case "coin":
      body = <><circle cx={o.x} cy={-o.y} r={0.36} fill="#ffd23f" stroke="#b8860b" strokeWidth={0.08} /></>;
      break;
    case "spike": {
      const n = Math.max(1, Math.round(o.width * 2));
      body = <polygon points={Array.from({ length: n }, (_, i) => `${o.x + (i * o.width) / n},${-o.y} ${o.x + ((i + 0.5) * o.width) / n},${-o.y - 0.55}`).join(" ") + ` ${o.x + o.width},${-o.y}`} fill="#d9dde6" stroke="#8a8f99" strokeWidth={0.04} />;
      break;
    }
    case "checkpoint":
    case "goal":
      body = <><rect x={o.x - 0.06} y={-o.y - 3} width={0.12} height={3} fill="#e8e2d0" /><polygon points={`${o.x + 0.06},${-o.y - 3} ${o.x + (o.type === "goal" ? 1.6 : 1.05)},${-o.y - 2.62} ${o.x + 0.06},${-o.y - 2.2}`} fill={o.type === "goal" ? "#ff5d73" : "#3ddc97"} /></>;
      break;
    case "enemy":
      body = <><line x1={o.x} x2={o.x + o.range} y1={-o.y - 0.15} y2={-o.y - 0.15} stroke="#a48cf5" strokeWidth={0.08} strokeDasharray="0.25 0.2" /><path d={`M ${o.x - 0.45} ${-o.y} a 0.45 0.45 0 0 1 0.9 0 z`} fill="#6a3fb5" /><circle cx={o.x + 0.3} cy={-o.y - 0.3} r={0.1} fill="#fff" /></>;
      break;
    case "door":
      body = <rect x={o.x - 0.5} y={-o.y - o.height} width={1} height={o.height} fill="#5b3a29" stroke="#ffd23f" strokeWidth={0.06} />;
      break;
    case "sign":
      body = <><rect x={o.x - 0.06} y={-o.y - 1.4} width={0.12} height={1.4} fill="#6e4a28" /><rect x={o.x - 0.6} y={-o.y - 1.45} width={1.2} height={0.7} fill="#c08a52" /></>;
      break;
  }
  return <>{body}{outline}</>;
}

/** The pixel size of a picture, once it has loaded (null before, or when it cannot be shown). */
function useImageSize(url: string | null): { w: number; h: number } | null {
  const [size, setSize] = useState<{ url: string; w: number; h: number } | null>(null);
  useEffect(() => {
    if (!url) return;
    const img = new Image();
    img.onload = () => setSize({ url, w: img.naturalWidth, h: img.naturalHeight });
    img.src = url;
    return () => {
      img.onload = null;
    };
  }, [url]);
  return size && size.url === url ? { w: size.w, h: size.h } : null;
}

/** One frame of a sprite sheet, drawn in level units (tiles) with its feet at (x, y). */
function SpriteFrame({ url, size, sprite, frame, x, y }: { url: string; size: { w: number; h: number }; sprite: Sprite; frame: number; x: number; y: number }) {
  const fw = size.w / sprite.columns;
  const fh = size.h / sprite.rows;
  const h = sprite.height;
  const w = (h * fw) / fh;
  const col = frame % sprite.columns;
  const row = Math.floor(frame / sprite.columns);
  // The level starts facing right; a sheet drawn facing left is flipped, as in the game.
  const flip = sprite.facing === "left";
  return (
    <g transform={flip ? `translate(${2 * x} 0) scale(-1 1)` : undefined}>
      <svg x={x - w / 2} y={-y - h} width={w} height={h} viewBox={`${col * fw} ${row * fh} ${fw} ${fh}`} preserveAspectRatio="none" overflow="hidden">
        <image href={url} width={size.w} height={size.h} style={{ imageRendering: sprite.pixelArt ? "pixelated" : "auto" }} />
      </svg>
    </g>
  );
}

/** The sheet with its frames numbered, to see which number is which pose. */
function SheetPreview({ url, size, sprite }: { url: string; size: { w: number; h: number }; sprite: Sprite }) {
  const fw = size.w / sprite.columns;
  const fh = size.h / sprite.rows;
  const cells = Array.from({ length: sprite.columns * sprite.rows }, (_, i) => i);
  const font = Math.max(6, Math.min(fw, fh) * 0.22);
  return (
    <svg viewBox={`0 0 ${size.w} ${size.h}`} style={{ width: "100%", maxHeight: 140, background: "repeating-conic-gradient(#2a2f3a 0% 25%, #222630 0% 50%) 50% / 16px 16px", borderRadius: 6 }} aria-label={`Sprite sheet, ${sprite.columns} by ${sprite.rows} frames`}>
      <image href={url} width={size.w} height={size.h} style={{ imageRendering: sprite.pixelArt ? "pixelated" : "auto" }} />
      {cells.map((i) => (
        <g key={i}>
          <rect x={(i % sprite.columns) * fw} y={Math.floor(i / sprite.columns) * fh} width={fw} height={fh} fill="none" stroke="rgba(122,167,255,0.7)" strokeWidth={Math.max(0.5, fw / 100)} />
          <text x={(i % sprite.columns) * fw + font * 0.4} y={Math.floor(i / sprite.columns) * fh + font} fontSize={font} fill="#fff" stroke="#000" strokeWidth={font / 10} paintOrder="stroke">{i}</text>
        </g>
      ))}
    </svg>
  );
}

const frameText = (list: number[]) => list.join(", ");
const parseFrames = (text: string): number[] | null => {
  const parts = text.split(/[\s,]+/).filter(Boolean);
  if (!parts.every((p) => /^\d+$/.test(p))) return null;
  return parts.map(Number).slice(0, 64);
};

export function LevelEditor({ path }: { path: string }) {
  const doc = useProject((s) => s.docs[path]);
  const updateDoc = useProject((s) => s.updateDoc);
  const level = doc?.data as Level | undefined;
  const validation = useMemo(() => (level ? parseLevel(level) : null), [level]);
  const root = useProject((s) => s.root);
  const manifest = useProject((s) => s.manifest);
  const files = useProject((s) => s.files);
  // Sprite sheets live in the Godot project's assets folder (res://assets/...).
  const engineDir = manifest?.engine.id === "godot" ? manifest.engine.projectDir : null;
  const sheets = useMemo(() => (engineDir ? files.filter((f) => f.kind === "file" && f.path.startsWith(`${engineDir}/assets/`) && /\.(png|webp)$/i.test(f.path)).map((f) => f.path.slice(engineDir.length + 1)).sort() : []), [files, engineDir]);
  const pictures = useMemo(() => (engineDir ? files.filter((f) => f.kind === "file" && f.path.startsWith(`${engineDir}/assets/`) && /\.(png|jpe?g|webp)$/i.test(f.path)).map((f) => f.path.slice(engineDir.length + 1)).sort() : []), [files, engineDir]);
  const audioFiles = useMemo(() => (engineDir ? files.filter((f) => f.kind === "file" && f.path.startsWith(`${engineDir}/assets/`) && /\.(ogg|wav|mp3)$/i.test(f.path)).map((f) => f.path.slice(engineDir.length + 1)).sort() : []), [files, engineDir]);
  const assetUrl = useMemo(() => (root && engineDir && backend.kind !== "browser" ? (asset: string) => backend.assetUrl(root, `${engineDir}/${asset}`) : undefined), [root, engineDir]);
  const sprite = level?.player.sprite;
  const spriteUrl = sprite && root && engineDir && backend.kind !== "browser" ? backend.assetUrl(root, `${engineDir}/${sprite.asset}`) : null;
  const spriteSize = useImageSize(spriteUrl);
  const svgRef = useRef<SVGSVGElement>(null);
  const past = useRef<Level[]>([]);
  const future = useRef<Level[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [snap, setSnap] = useState(true);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<{ cx: number; cy: number; zoom: number } | null>(null);
  const [drag, setDrag] = useState<{ kind: "object" | "spawn" | "pan"; id?: string; startX: number; startY: number; origX: number; origY: number; preview?: { x: number; y: number } } | null>(null);
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ w: 900, h: 500 });
  const [, bump] = useState(0);

  const commit = useCallback(
    (next: Level) => {
      if (!level) return;
      past.current.push(level);
      if (past.current.length > 100) past.current.shift();
      future.current = [];
      updateDoc(path, next);
      bump((x) => x + 1);
    },
    [level, path, updateDoc],
  );

  useEffect(() => {
    if (!viewport) return;
    const measure = () => setBox({ w: Math.max(200, viewport.clientWidth), h: Math.max(200, viewport.clientHeight) });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(viewport);
    return () => ro.disconnect();
  }, [viewport]);

  // Trackpad pinches reach WebKit as gesture events; they zoom here, toward the pointer.
  const zoomRef = useRef<(factor: number, clientX: number, clientY: number) => void>(() => {});
  useEffect(() => {
    if (!viewport) return;
    let last = 1;
    const onGesture = (e: Event) => {
      e.preventDefault();
      if (e.type === "gestureend") return;
      const g = e as Event & { scale?: unknown; clientX?: unknown; clientY?: unknown };
      const scale = typeof g.scale === "number" && g.scale > 0 ? g.scale : 1;
      if (e.type === "gesturestart") last = 1;
      const r = viewport.getBoundingClientRect();
      zoomRef.current(scale / last, typeof g.clientX === "number" ? g.clientX : r.left + r.width / 2, typeof g.clientY === "number" ? g.clientY : r.top + r.height / 2);
      last = scale;
    };
    for (const t of ["gesturestart", "gesturechange", "gestureend"]) viewport.addEventListener(t, onGesture);
    return () => {
      for (const t of ["gesturestart", "gesturechange", "gestureend"]) viewport.removeEventListener(t, onGesture);
    };
  }, [viewport]);

  if (!doc) return null;
  if (doc.error || !level || !Array.isArray(level.objects)) return <div style={{ padding: 16 }}><Notice kind="error">{path} cannot be shown as a level{doc.error ? `: ${doc.error}` : ""}.</Notice></div>;

  const W = level.size.width;
  const H = level.size.height;
  // Fit the level's height by default; long levels scroll sideways.
  const fitZoom = 1;
  const v = view ?? { cx: Math.min(W / 2, (H + 2) * (box.w / box.h) / 2), cy: H / 2, zoom: fitZoom };
  const vh = (H + 2) / v.zoom;
  const vw = vh * (box.w / box.h);
  const viewBox = `${v.cx - vw / 2} ${-v.cy - vh / 2} ${vw} ${vh}`;

  const toLevel = (clientX: number, clientY: number) => {
    const m = svgRef.current?.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const p = new DOMPoint(clientX, clientY).matrixTransform(m.inverse());
    return { x: p.x, y: -p.y };
  };
  const step = (o: { type: string } | null) => (o?.type === "platform" || o?.type === "spike" ? 1 : 0.5);
  const place = (x: number, y: number, s: number) => ({ x: fix(Math.max(0, Math.min(W, snap ? snapTo(x, s) : x))), y: fix(Math.max(0, Math.min(H, snap ? snapTo(y, s) : y))) });
  const patchObject = (id: string, patch: Partial<LevelObject>) => commit({ ...level, objects: level.objects.map((o) => (o.id === id ? ({ ...o, ...patch } as LevelObject) : o)) });
  const addObject = (type: LevelObjectType, x: number, y: number) => {
    const id = nextLevelObjectId(level, TYPE_META[type].prefix);
    const p = place(x, y, type === "platform" || type === "spike" ? 1 : 0.5);
    commit({ ...level, objects: [...level.objects, LEVEL_OBJECT_DEFAULTS[type](id, p.x, p.y)] });
    setSelected(id);
  };
  const removeObject = (id: string) => {
    commit({ ...level, objects: level.objects.filter((o) => o.id !== id) });
    setSelected(null);
  };
  const duplicate = (id: string) => {
    const o = level.objects.find((x) => x.id === id);
    if (!o) return;
    const copyId = nextLevelObjectId(level, TYPE_META[o.type].prefix);
    const p = place(o.x + 2, o.y, step(o));
    commit({ ...level, objects: [...level.objects, { ...o, id: copyId, x: p.x, y: p.y } as LevelObject] });
    setSelected(copyId);
  };
  const undo = () => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(level);
    updateDoc(path, prev);
    bump((x) => x + 1);
  };
  const redo = () => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(level);
    updateDoc(path, next);
    bump((x) => x + 1);
  };
  const zoomAt = (factor: number, clientX: number, clientY: number) => {
    const at = toLevel(clientX, clientY);
    const zoom = Math.min(6, Math.max(0.25, v.zoom * factor));
    const k = v.zoom / zoom;
    setView({ cx: at.x + (v.cx - at.x) * k, cy: at.y + (v.cy - at.y) * k, zoom });
  };
  zoomRef.current = zoomAt;
  const centreOn = (o: LevelObject) => setView({ ...v, cx: o.x, cy: Math.max(o.y, vh / 2 - 1) });

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    const target = (e.target as Element).closest("[data-obj]") as SVGGElement | null;
    const pt = toLevel(e.clientX, e.clientY);
    e.currentTarget.setPointerCapture(e.pointerId);
    if (target?.dataset["obj"] === "__spawn") {
      setDrag({ kind: "spawn", startX: pt.x, startY: pt.y, origX: level.player.spawn.x, origY: level.player.spawn.y });
    } else if (target?.dataset["obj"]) {
      const o = level.objects.find((x) => x.id === target.dataset["obj"]);
      if (!o) return;
      setSelected(o.id);
      setDrag({ kind: "object", id: o.id, startX: pt.x, startY: pt.y, origX: o.x, origY: o.y });
    } else {
      setSelected(null);
      setDrag({ kind: "pan", startX: e.clientX, startY: e.clientY, origX: v.cx, origY: v.cy });
    }
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag) return;
    if (drag.kind === "pan") {
      const scale = vw / box.w;
      setView({ ...v, cx: drag.origX - (e.clientX - drag.startX) * scale, cy: drag.origY + (e.clientY - drag.startY) * scale });
      return;
    }
    const pt = toLevel(e.clientX, e.clientY);
    const o = drag.kind === "object" ? level.objects.find((x) => x.id === drag.id) ?? null : null;
    setDrag({ ...drag, preview: place(drag.origX + pt.x - drag.startX, drag.origY + pt.y - drag.startY, step(o)) });
  };
  const onPointerUp = () => {
    if (drag?.preview && (drag.preview.x !== drag.origX || drag.preview.y !== drag.origY)) {
      if (drag.kind === "spawn") commit({ ...level, player: { ...level.player, spawn: { x: drag.preview.x, y: drag.preview.y } } });
      else if (drag.id) patchObject(drag.id, { x: drag.preview.x, y: drag.preview.y });
    }
    setDrag(null);
  };

  const shown = (o: LevelObject): LevelObject => (drag?.kind === "object" && drag.id === o.id && drag.preview ? ({ ...o, ...drag.preview } as LevelObject) : o);
  const spawn = drag?.kind === "spawn" && drag.preview ? drag.preview : level.player.spawn;
  const selectedObject = level.objects.find((o) => o.id === selected) ?? null;
  const filtered = level.objects.filter((o) => !query || o.id.includes(query.toLowerCase()) || o.type.includes(query.toLowerCase()));
  // Platforms first so everything else draws on top of them.
  const ordered = [...level.objects].sort((a, b) => (a.type === "platform" ? 0 : 1) - (b.type === "platform" ? 0 : 1));

  return (
    <div
      className="world-editor"
      style={{ height: "100%" }}
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).closest("input, textarea, select")) return;
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
          e.preventDefault();
          if (e.shiftKey) redo();
          else undo();
        } else if (selected && (e.key === "Delete" || e.key === "Backspace")) {
          e.preventDefault();
          removeObject(selected);
        } else if (selected && e.key.startsWith("Arrow")) {
          e.preventDefault();
          const o = level.objects.find((x) => x.id === selected)!;
          const d = e.shiftKey ? 5 : step(o);
          patchObject(selected, place(o.x + (e.key === "ArrowLeft" ? -d : e.key === "ArrowRight" ? d : 0), o.y + (e.key === "ArrowUp" ? d : e.key === "ArrowDown" ? -d : 0), step(o)));
        }
      }}
    >
      <Group orientation="horizontal" style={{ height: "100%" }}>
        <Panel id="level-left" defaultSize={220} minSize={180} maxSize={360} collapsible>
          <div className="panel">
            <div className="panel__header"><span className="panel__title">Add objects</span></div>
            <div style={{ padding: "6px 0", borderBottom: "1px solid var(--line)" }}>
              {LEVEL_OBJECT_TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  className="world-palette-item"
                  draggable
                  data-tip="Drag into the level, or press to add in the middle of the view"
                  onDragStart={(e) => { e.dataTransfer.setData(OBJ_MIME, t); e.dataTransfer.effectAllowed = "copy"; }}
                  onClick={() => addObject(t, v.cx, t === "platform" ? Math.max(0, v.cy - 1) : v.cy)}
                  aria-label={`Add ${TYPE_META[t].label}`}
                >
                  {TYPE_META[t].icon}
                  {TYPE_META[t].label}
                </button>
              ))}
            </div>
            <div className="panel__header"><span className="panel__title">Objects ({level.objects.length})</span></div>
            <div className="palette-search">
              <div className="row" style={{ gap: 6 }}>
                <SearchIcon style={{ width: 14, height: 14, color: "var(--text-3)" }} />
                <input className="input" placeholder="Filter" aria-label="Filter objects" value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
            </div>
            <div className="panel__body">
              {filtered.map((o) => (
                <button key={o.id} type="button" className="tree-item" aria-selected={o.id === selected} onClick={() => { setSelected(o.id); centreOn(o); }}>
                  {TYPE_META[o.type].icon}
                  <span className="tree-item__name mono">{o.id}</span>
                  <span className="faint xsmall" style={{ marginLeft: "auto" }}>{fix(o.x)}, {fix(o.y)}</span>
                </button>
              ))}
            </div>
          </div>
        </Panel>
        <Separator className="sep sep--v" />
        <Panel id="level-view" minSize={300}>
          <div ref={setViewport} style={{ position: "relative", height: "100%", overflow: "hidden" }} tabIndex={0} onPointerDownCapture={(e) => e.currentTarget.focus({ preventScroll: true })} aria-label="Level, side view. Arrow keys move the selected object, Delete removes it.">
            <div className="world-toolbar">
              <IconButton label="Undo" tip={past.current.length ? "Undo (Cmd+Z)" : "Nothing to undo"} disabled={!past.current.length} onClick={undo}><UndoIcon /></IconButton>
              <IconButton label="Redo" tip={future.current.length ? "Redo (Shift+Cmd+Z)" : "Nothing to redo"} disabled={!future.current.length} onClick={redo}><RedoIcon /></IconButton>
              <span className="world-toolbar__sep" />
              <IconButton label="Zoom in" tip="Zoom in (or pinch, or Ctrl+scroll)" onClick={() => setView({ ...v, zoom: Math.min(6, v.zoom * 1.25) })}><ZoomInIcon /></IconButton>
              <IconButton label="Zoom out" tip="Zoom out" onClick={() => setView({ ...v, zoom: Math.max(0.25, v.zoom / 1.25) })}><ZoomOutIcon /></IconButton>
              <IconButton label="Show the start" tip="Back to the start of the level" onClick={() => setView(null)}><FocusIcon /></IconButton>
              <span className="world-toolbar__sep" />
              <Switch checked={snap} onChange={setSnap} label="Snap" />
            </div>
            <svg
              ref={svgRef}
              data-testid="level-canvas"
              viewBox={viewBox}
              preserveAspectRatio="xMidYMid meet"
              style={{ width: "100%", height: "100%", display: "block", touchAction: "none", background: "var(--bg-0)" }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => setDrag(null)}
              onWheel={(e) => {
                if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
                else {
                  const scale = vw / box.w;
                  setView({ ...v, cx: v.cx + (e.deltaX || e.deltaY) * scale, cy: v.cy - (e.deltaX ? e.deltaY * scale : 0) });
                }
              }}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes(OBJ_MIME)) {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "copy";
                }
              }}
              onDrop={(e) => {
                const t = e.dataTransfer.getData(OBJ_MIME) as LevelObjectType;
                if (!LEVEL_OBJECT_TYPES.includes(t)) return;
                e.preventDefault();
                const at = toLevel(e.clientX, e.clientY);
                addObject(t, at.x, at.y);
              }}
            >
              <defs>
                <linearGradient id="level-sky" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor={level.background.skyTop} />
                  <stop offset="1" stopColor={level.background.skyBottom} />
                </linearGradient>
                <pattern id="level-grid" width="1" height="1" patternUnits="userSpaceOnUse">
                  <path d="M 1 0 L 0 0 0 1" fill="none" stroke="rgba(255,255,255,0.09)" strokeWidth={0.03} />
                </pattern>
              </defs>
              <rect x={0} y={-H} width={W} height={H} fill="url(#level-sky)" />
              <rect x={0} y={-H} width={W} height={H} fill="url(#level-grid)" />
              <rect x={0} y={-H} width={W} height={H} fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth={0.08} />
              {ordered.map((o) => (
                <g key={o.id} data-obj={o.id} className="world-obj">
                  <Shape o={shown(o)} selected={o.id === selected} pictureUrl={assetUrl} />
                </g>
              ))}
              <g data-obj="__spawn" className="world-obj">
                {sprite && spriteUrl && spriteSize ? (
                  <>
                    <rect x={spawn.x - 0.5} y={-spawn.y - sprite.height} width={1} height={sprite.height} fill="transparent" />
                    <SpriteFrame url={spriteUrl} size={spriteSize} sprite={sprite} frame={sprite.idle[0] ?? 0} x={spawn.x} y={spawn.y} />
                  </>
                ) : (
                  <rect x={spawn.x - 0.35} y={-spawn.y - 1.4} width={0.7} height={1.4} rx={0.12} fill="#ff7b54" stroke="#fff" strokeWidth={0.06} />
                )}
                <text x={spawn.x} y={-spawn.y - 1.6} fontSize={0.5} textAnchor="middle" fill="#fff">Start</text>
              </g>
            </svg>
            <div className="world-legend">
              <span>1 square = 1 tile (32 px in the game)</span>
              <span>Drag objects to move them · drag empty space to scroll · pinch or Ctrl+scroll to zoom</span>
            </div>
          </div>
        </Panel>
        <Separator className="sep sep--v" />
        <Panel id="level-inspector" defaultSize={300} minSize={240} maxSize={460} collapsible>
          <div className="panel">
            <div className="panel__header"><span className="panel__title">{selectedObject ? "Object" : "Level settings"}</span></div>
            <div className="panel__body" style={{ padding: 12 }}>
              <div className="stack">
                {validation && !validation.ok && <Notice kind="warn">{validation.errors.slice(0, 4).join(" · ")}</Notice>}
                {selectedObject ? <Inspector o={selectedObject} patch={(p) => patchObject(selectedObject.id, p)} pictures={pictures} /> : <LevelSettings level={level} commit={commit} sheets={sheets} spriteUrl={spriteUrl} spriteSize={spriteSize} audioFiles={audioFiles} assetUrl={assetUrl} godot={Boolean(engineDir)} />}
                {selectedObject && (
                  <div className="row row--wrap">
                    <Button size="small" icon={<CopyIcon />} onClick={() => duplicate(selectedObject.id)}>Duplicate</Button>
                    <Button size="small" variant="danger" icon={<TrashIcon />} onClick={() => removeObject(selectedObject.id)}>Delete</Button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </Panel>
      </Group>
    </div>
  );
}

function Num({ label, value, onCommit, step = 0.5, min, max }: { label: string; value: number; onCommit: (n: number) => void; step?: number; min?: number; max?: number }) {
  return <Field label={label}><NumberInput ariaLabel={label} value={value} step={step} min={min} max={max} onCommit={onCommit} /></Field>;
}

function Inspector({ o, patch, pictures }: { o: LevelObject; patch: (p: Partial<LevelObject>) => void; pictures: string[] }) {
  return (
    <>
      <div className="small muted mono">{o.id} · {o.type}</div>
      <div className="row" style={{ gap: 8 }}>
        <Num label="x (tiles)" value={o.x} onCommit={(x) => patch({ x })} min={0} />
        <Num label="y (tiles)" value={o.y} onCommit={(y) => patch({ y })} min={0} />
      </div>
      {o.type === "platform" && (
        <>
          <div className="row" style={{ gap: 8 }}>
            <Num label="Width" value={o.width} step={1} min={1} onCommit={(width) => patch({ width })} />
            <Num label="Height" value={o.height} step={0.5} min={0.5} onCommit={(height) => patch({ height })} />
          </div>
          <Field label="Style" help="Wooden ledges can be jumped through from below.">
            <Segmented ariaLabel="Platform style" value={o.style} onChange={(style) => patch({ style })} options={PLATFORM_STYLES.map((s) => ({ value: s, label: s[0]!.toUpperCase() + s.slice(1) }))} />
          </Field>
          <Field label="Picture" help={pictures.length ? "A picture repeated over the platform instead of the style's drawing. The style still decides whether it can be jumped through." : "Import a picture (.png, .jpg) in Assets, or a texture from the free library, to tile it over platforms."}>
            <select className="select" aria-label="Platform picture" disabled={!pictures.length && !o.texture} value={o.texture ?? ""} onChange={(e) => patch((e.target.value ? { texture: e.target.value, tile: o.tile ?? 1 } : { texture: undefined, tile: undefined }) as Partial<LevelObject>)}>
              <option value="">None (the style's drawing)</option>
              {o.texture && !pictures.includes(o.texture) && <option value={o.texture}>{o.texture} (missing)</option>}
              {pictures.map((t) => <option key={t} value={t}>{t.replace(/^assets\//, "")}</option>)}
            </select>
          </Field>
          {o.texture && <Num label="Repeat every (tiles)" value={o.tile ?? 1} step={0.25} min={0.25} max={16} onCommit={(tile) => patch({ tile } as Partial<LevelObject>)} />}
        </>
      )}
      {o.type === "spike" && <Num label="Width" value={o.width} step={1} min={1} onCommit={(width) => patch({ width })} />}
      {o.type === "door" && <Num label="Height" value={o.height} step={1} min={1} onCommit={(height) => patch({ height })} />}
      {o.type === "enemy" && (
        <div className="row" style={{ gap: 8 }}>
          <Num label="Patrol (tiles)" value={o.range} step={1} min={0} onCommit={(range) => patch({ range })} />
          <Num label="Speed" value={o.speed} step={0.5} min={0.5} onCommit={(speed) => patch({ speed })} />
        </div>
      )}
      {o.type === "coin" && <Field label="Kind" help="Rules count coins by kind."><TextInput ariaLabel="Kind" value={o.kind} mono maxLength={32} onCommit={(kind) => patch({ kind })} /></Field>}
      {(o.type === "coin" || o.type === "checkpoint" || o.type === "goal") && <Field label="Label"><TextInput ariaLabel="Label" value={o.label} maxLength={60} onCommit={(label) => patch({ label })} /></Field>}
      {o.type === "sign" && <Field label="Text"><TextInput ariaLabel="Sign text" value={o.text} maxLength={200} onCommit={(text) => patch({ text })} /></Field>}
    </>
  );
}

function LevelSettings({ level, commit, sheets, spriteUrl, spriteSize, audioFiles, assetUrl, godot }: { level: Level; commit: (l: Level) => void; sheets: string[]; spriteUrl: string | null; spriteSize: { w: number; h: number } | null; audioFiles: string[]; assetUrl: ((a: string) => string | null) | undefined; godot: boolean }) {
  const player = (p: Partial<Level["player"]>) => commit({ ...level, player: { ...level.player, ...p } });
  const sprite = level.player.sprite;
  const setSprite = (next: Sprite | undefined) => {
    const { sprite: _old, ...rest } = level.player;
    commit({ ...level, player: next ? { ...rest, sprite: next } : rest });
  };
  return (
    <>
      <Field label="Name"><TextInput ariaLabel="Level name" value={level.name} maxLength={80} onCommit={(name) => commit({ ...level, name })} /></Field>
      <div className="row" style={{ gap: 8 }}>
        <Num label="Width (tiles)" value={level.size.width} step={10} min={20} max={1000} onCommit={(width) => commit({ ...level, size: { ...level.size, width } })} />
        <Num label="Height (tiles)" value={level.size.height} step={2} min={10} max={120} onCommit={(height) => commit({ ...level, size: { ...level.size, height } })} />
      </div>
      <div className="section-label">Player</div>
      <div className="row" style={{ gap: 8 }}>
        <Num label="Speed (tiles/s)" value={level.player.speed} step={0.5} min={2} max={30} onCommit={(speed) => player({ speed })} />
        <Num label="Jump (tiles)" value={level.player.jumpHeight} step={0.5} min={1} max={12} onCommit={(jumpHeight) => player({ jumpHeight })} />
      </div>
      <Num label="Gravity (tiles/s²)" value={level.player.gravity} step={5} min={10} max={200} onCommit={(gravity) => player({ gravity })} />
      <Field label="Player sprite" help={sheets.length ? "A sprite sheet (.png) of equal frames; the player plays its idle, run and jump frames. Without one, the player is the drawn runner." : "Import a sprite sheet (.png, equal frames in a grid) in Assets to draw the player from it."}>
        <select className="select" aria-label="Player sprite" disabled={!sheets.length && !sprite} value={sprite?.asset ?? ""} onChange={(e) => setSprite(e.target.value ? { asset: e.target.value, columns: 4, rows: 1, idle: [0], run: [1, 2], jump: [3], fps: 10, height: 1.5, facing: "right", pixelArt: true } : undefined)}>
          <option value="">None (the drawn runner)</option>
          {sprite && !sheets.includes(sprite.asset) && <option value={sprite.asset}>{sprite.asset} (missing)</option>}
          {sheets.map((t) => <option key={t} value={t}>{t.replace(/^assets\//, "")}</option>)}
        </select>
      </Field>
      {sprite && (
        <>
          {spriteUrl && spriteSize && <SheetPreview url={spriteUrl} size={spriteSize} sprite={sprite} />}
          <div className="row" style={{ gap: 8 }}>
            <Num label="Columns" value={sprite.columns} step={1} min={1} max={64} onCommit={(columns) => setSprite({ ...sprite, columns })} />
            <Num label="Rows" value={sprite.rows} step={1} min={1} max={64} onCommit={(rows) => setSprite({ ...sprite, rows })} />
          </div>
          {SPRITE_STATES.map((state) => (
            <Field key={state} label={`${state[0]!.toUpperCase()}${state.slice(1)} frames`} help={state === "idle" ? "Frame numbers, for example 0 or 0, 1." : state === "run" ? "For example 1, 2, 3, 4. Empty: the idle frames." : "Empty: keeps the current frames in the air."}>
              <TextInput ariaLabel={`${state} frames`} mono value={frameText(sprite[state])} maxLength={200} onCommit={(t) => {
                const frames = parseFrames(t);
                if (frames && (state !== "idle" || frames.length > 0)) setSprite({ ...sprite, [state]: frames });
              }} />
            </Field>
          ))}
          <div className="row" style={{ gap: 8 }}>
            <Num label="Frames a second" value={sprite.fps} step={1} min={1} max={30} onCommit={(fps) => setSprite({ ...sprite, fps })} />
            <Num label="Height (tiles)" value={sprite.height} step={0.25} min={0.5} max={8} onCommit={(height) => setSprite({ ...sprite, height })} />
          </div>
          <Field label="The frames face">
            <Segmented ariaLabel="The frames face" value={sprite.facing} onChange={(facing) => setSprite({ ...sprite, facing })} options={[{ value: "right", label: "Right" }, { value: "left", label: "Left" }]} />
          </Field>
          <Switch checked={sprite.pixelArt} onChange={(pixelArt) => setSprite({ ...sprite, pixelArt })} label="Pixel art (sharp, unsmoothed pixels)" />
        </>
      )}
      <div className="section-label">Background</div>
      {(["skyTop", "skyBottom", "hills"] as const).map((k) => (
        <Field key={k} label={k === "skyTop" ? "Sky (top)" : k === "skyBottom" ? "Sky (horizon)" : "Hills"}>
          <input type="color" aria-label={k} value={level.background[k]} onChange={(e) => commit({ ...level, background: { ...level.background, [k]: e.target.value } })} />
        </Field>
      ))}
      <AudioSettings
        audio={level.audio}
        cues={PLATFORMER_SOUNDS}
        files={audioFiles}
        assetUrl={assetUrl}
        godot={godot}
        onChange={(audio) => {
          const { audio: _old, ...rest } = level;
          commit(audio ? { ...rest, audio: audio as Level["audio"] } : rest);
        }}
      />
    </>
  );
}

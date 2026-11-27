import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { MODEL_EXTENSIONS, OBJECT_DEFAULTS, OBJECT_TYPES, SKY_EXTENSIONS, TEXTURE_EXTENSIONS, nextObjectId, parseWorld, type World, type WorldObject, type WorldObjectType } from "@gamestudio/explore";
import { useProject } from "../../state/project";
import { backend, errorMessage, type LibraryCharacter } from "../../lib/backend";
import { addLibraryCharacter, libraryCharacters, suggestedCharacter } from "../assets/characters";
import { useFocus } from "../../state/focus";
import { Button, Field, IconButton, Notice, NumberInput, Segmented, Switch, TextInput } from "../../components/ui";
import { PauseIcon, PlayIcon, CopyIcon, CubeIcon, FocusIcon, FogIcon, FootprintsIcon, GateIcon, GemIcon, GridIcon, NpcIcon, RedoIcon, RockIcon, SearchIcon, SignIcon, SnapIcon, TorchIcon, TrashIcon, TreeIcon, UndoIcon, WaterIcon, ZoneIcon, ZoomInIcon, ZoomOutIcon, MapIcon, EnemyIcon, BlockIcon } from "../../components/icons";
import { normalizeRotation } from "./angles";
import { guessMaterial } from "./textures";
import { loadModelFile, useModelInfo } from "./modelFiles";
import { suggestedHeight, pickClip } from "./level3d";
import { AUDIO_EXTENSIONS, CHARACTER_STATES, SOUNDS, TEXTURED_TYPES, guessClips, matchingMaps, type Character, type ObjectMaterial } from "@gamestudio/explore";
import { AudioSettings } from "./AudioSettings";
import type { CameraState, World3DApi } from "./World3D";

const TYPE_META: Record<WorldObjectType, { label: string; icon: ReactNode; prefix: string }> = {
  tree: { label: "Tree", icon: <TreeIcon />, prefix: "tree" },
  rock: { label: "Rock", icon: <RockIcon />, prefix: "rock" },
  collectible: { label: "Collectible crystal", icon: <GemIcon />, prefix: "crystal" },
  npc: { label: "Character", icon: <NpcIcon />, prefix: "npc" },
  enemy: { label: "Enemy", icon: <EnemyIcon />, prefix: "enemy" },
  crate: { label: "Pushable block", icon: <BlockIcon />, prefix: "block" },
  gate: { label: "Gate", icon: <GateIcon />, prefix: "gate" },
  zone: { label: "Zone (trigger)", icon: <ZoneIcon />, prefix: "zone" },
  water: { label: "Water", icon: <WaterIcon />, prefix: "water" },
  sign: { label: "Sign", icon: <SignIcon />, prefix: "sign" },
  torch: { label: "Torch", icon: <TorchIcon />, prefix: "torch" },
  model: { label: "3D model", icon: <CubeIcon />, prefix: "model" },
};
const hasExt = (p: string, exts: readonly string[]) => exts.some((e) => p.toLowerCase().endsWith(`.${e}`));
const OBJ_MIME = "application/x-gamestudio-object";
const round = (n: number, step: number) => Math.round(n / step) * step;
const fix = (n: number) => Math.round(n * 100) / 100;

// three.js is large, so the 3D view is fetched the first time someone opens it.
const World3D = lazy(() => import("./World3D"));
type ViewMode = "map" | "3d";
/** Each level's 3D camera, kept while the app runs so switching views or tabs does not lose it. */
const cameras = new Map<string, CameraState>();
const VIEW_KEY = "gamestudio.world.view";
function readViewMode(): ViewMode {
  try {
    // The 3D view first: it shows the level as the game does, which is what someone new expects. The map stays one click away.
    return localStorage.getItem(VIEW_KEY) === "map" ? "map" : "3d";
  } catch {
    return "3d";
  }
}
function saveViewMode(m: ViewMode) {
  try {
    localStorage.setItem(VIEW_KEY, m);
  } catch {
    // Private windows can refuse storage; the choice then lasts until the editor closes.
  }
}

function ObjectShape({ o, selected }: { o: WorldObject; selected: boolean }) {
  const s = o.scale;
  const ring = selected ? <circle r={Math.max(1.6, ("radius" in o ? o.radius : 1.2) * (o.type === "zone" || o.type === "water" ? 1 : s)) + 0.6} fill="none" stroke="var(--mode-accent)" strokeWidth={0.35} strokeDasharray="1 0.6" /> : null;
  let body: ReactNode;
  switch (o.type) {
    case "tree": {
      const r = (o.variant === "baobab" ? 2.4 : o.variant === "tall" ? 1.4 : 1.6) * s;
      body = <><circle r={r} fill={o.variant === "baobab" ? "#4f8a3a" : "#2f7d4a"} stroke="#1f4f30" strokeWidth={0.25} /><circle r={0.35 * s} fill="#7a5634" /></>;
      break;
    }
    case "rock":
      body = <polygon points={[[-0.9, -0.3], [-0.3, -0.85], [0.6, -0.7], [0.95, 0.1], [0.4, 0.8], [-0.6, 0.7]].map(([x, z]) => `${x! * s},${z! * s}`).join(" ")} fill="#8a8f96" stroke="#5c6168" strokeWidth={0.2} />;
      break;
    case "collectible":
      body = <><circle r={1.4} fill="rgba(242,184,75,0.18)" /><polygon points="0,-0.95 0.65,0 0,0.95 -0.65,0" fill="#f2b84b" stroke="#ffd98a" strokeWidth={0.15} /></>;
      break;
    case "npc":
      body = <><circle r={0.75 * s} fill={o.color} stroke="#f5dcc0" strokeWidth={0.18} /><circle r={0.3 * s} cy={-0.1} fill="#6b4a32" /></>;
      break;
    case "enemy":
      // Seen from above: shell, head to the north, yellow eyes; when selected, the distance it sees the player from.
      body = (
        <>
          {selected && o.sight > 0 && <circle r={o.sight} fill="rgba(229,72,77,0.06)" stroke="#e5484d" strokeWidth={0.14} strokeDasharray="0.7 0.5" />}
          <circle r={0.6 * s} fill={o.color} stroke="#2b2233" strokeWidth={0.18} />
          <circle cy={-0.55 * s} r={0.27 * s} fill="#2b2233" />
          <circle cx={-0.11 * s} cy={-0.7 * s} r={0.08 * s} fill="#ffd23f" />
          <circle cx={0.11 * s} cy={-0.7 * s} r={0.08 * s} fill="#ffd23f" />
        </>
      );
      break;
    case "crate": {
      const stone = o.variant === "stone";
      body = <><rect x={-0.6 * s} y={-0.6 * s} width={1.2 * s} height={1.2 * s} rx={0.08} fill={stone ? "#8d8a80" : "#9a6b3c"} stroke={stone ? "#6f6c63" : "#6b4a2a"} strokeWidth={0.2} /><rect x={-0.35 * s} y={-0.35 * s} width={0.7 * s} height={0.7 * s} fill="none" stroke={stone ? "#6f6c63" : "#6b4a2a"} strokeWidth={0.12} /></>;
      break;
    }
    case "gate": {
      const w = o.width * s;
      body = <><rect x={-w / 2} y={-0.25} width={w} height={0.5} fill="#6b4a2a" /><rect x={-w / 2 - 0.9} y={-0.45} width={0.9} height={0.9} fill="#b9a27a" /><rect x={w / 2} y={-0.45} width={0.9} height={0.9} fill="#b9a27a" /></>;
      break;
    }
    case "zone":
      body = <><circle r={o.radius * s} fill="rgba(60,201,180,0.08)" stroke="#3cc9b4" strokeWidth={0.22} strokeDasharray="0.8 0.5" /></>;
      break;
    case "water":
      body = <circle r={o.radius * s} fill="rgba(47,127,184,0.55)" stroke="#5aa6dc" strokeWidth={0.2} />;
      break;
    case "sign":
      body = <><rect x={-0.75 * s} y={-0.15} width={1.5 * s} height={0.3} fill="#8a6239" /><circle r={0.12} fill="#5a4030" /></>;
      break;
    case "torch":
      body = <><circle r={1.6} fill="rgba(255,155,61,0.12)" /><circle r={0.3} fill="#ff9b3d" /></>;
      break;
    case "model":
      body = <><rect x={-0.9 * s} y={-0.9 * s} width={1.8 * s} height={1.8 * s} rx={0.2} fill="rgba(122,167,255,0.25)" stroke="#7aa7ff" strokeWidth={0.2} /><path d={`M${-0.5 * s},${0.3 * s} L0,${-0.5 * s} L${0.5 * s},${0.3 * s} Z`} fill="#7aa7ff" /></>;
      break;
  }
  return <g>{ring}{body}</g>;
}

/** An animation of a model: a list once its file is read, otherwise (browser preview, still loading) a name to type. */
function ClipSelect({ id, value, clips, onChange, none }: { id: string; value: string | undefined; clips: string[] | null; onChange: (v: string | undefined) => void; none: string }) {
  if (!clips) return <TextInput id={id} mono value={value ?? ""} maxLength={100} placeholder={none} onCommit={(v) => onChange(v.trim() || undefined)} />;
  return (
    <select id={id} className="select" value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)}>
      <option value="">{none}</option>
      {value && !clips.includes(value) && <option value={value}>{value} (not in this file)</option>}
      {clips.map((c) => <option key={c} value={c}>{c}</option>)}
    </select>
  );
}

/** Reads a newly chosen model to suggest a height and animations; falls back to defaults when it cannot be read. */
async function readModel(asset: string, assetUrl: ((a: string) => string | null) | undefined): Promise<{ clips: string[]; height: number } | null> {
  if (!assetUrl) return null;
  try {
    const m = await loadModelFile(asset, assetUrl);
    const { Box3 } = await import("three");
    m.scene.updateMatrixWorld(true);
    const box = new Box3().setFromObject(m.scene);
    return { clips: m.clips.map((c) => c.name), height: suggestedHeight(box.isEmpty() ? 1.8 : box.max.y - box.min.y) };
  } catch {
    return null;
  }
}

function ObjectInspector({ o, models, textures, assetUrl, onChange, onDelete, onDuplicate }: { o: WorldObject; models: string[]; textures: string[]; assetUrl: ((a: string) => string | null) | undefined; onChange: (patch: Partial<WorldObject>) => void; onDelete: () => void; onDuplicate: () => void }) {
  const material: ObjectMaterial | undefined = "material" in o ? o.material : undefined;
  const setMaterial = (m: ObjectMaterial | undefined) => onChange({ material: m } as Partial<WorldObject>);
  const fileOf = o.type === "npc" || o.type === "enemy" || o.type === "crate" || o.type === "gate" ? o.model : o.type === "model" ? o.asset : undefined;
  const { info, error } = useModelInfo(fileOf, assetUrl);
  return (
    <div className="inspector">
      <div className="stack" style={{ gap: 4 }}>
        <div className="section-label">{TYPE_META[o.type].label}</div>
        <div className="inspector__title mono">{o.id}</div>
      </div>
      <div className="field-row">
        <Field label="X (east)" htmlFor="obj-x"><NumberInput id="obj-x" value={o.x} onCommit={(x) => onChange({ x })} /></Field>
        <Field label="Z (south)" htmlFor="obj-z"><NumberInput id="obj-z" value={o.z} onCommit={(z) => onChange({ z })} /></Field>
      </div>
      <div className="field-row">
        <Field label="Rotation (°)" htmlFor="obj-rot"><NumberInput id="obj-rot" value={o.rotation} min={-360} max={360} onCommit={(rotation) => onChange({ rotation })} /></Field>
        <Field label="Scale" htmlFor="obj-scale"><NumberInput id="obj-scale" value={o.scale} min={o.type === "model" ? 0.01 : 0.2} max={o.type === "model" ? 100 : 5} step={0.1} onCommit={(scale) => onChange({ scale })} /></Field>
      </div>
      {o.type === "tree" && (
        <Field label="Variant" htmlFor="obj-variant">
          <select id="obj-variant" className="select" value={o.variant} onChange={(e) => onChange({ variant: e.target.value as "round" })}>
            <option value="round">Round</option>
            <option value="tall">Tall</option>
            <option value="baobab">Baobab</option>
          </select>
        </Field>
      )}
      {o.type === "collectible" && (
        <>
          <Field label="Kind" htmlFor="obj-kind" help="Rules count collectibles by kind."><TextInput id="obj-kind" mono value={o.kind} onCommit={(kind) => /^[a-z][a-z0-9_]{0,31}$/.test(kind) && onChange({ kind })} /></Field>
          <Field label="Label" htmlFor="obj-label"><TextInput id="obj-label" value={o.label} maxLength={60} onCommit={(label) => onChange({ label })} /></Field>
        </>
      )}
      {o.type === "npc" && (
        <>
          <Field label="Name" htmlFor="obj-name" help="Rules see this character as its id."><TextInput id="obj-name" value={o.name} maxLength={60} onCommit={(name) => name.trim() && onChange({ name })} /></Field>
          {!o.model && <Field label="Colour" htmlFor="obj-color"><input id="obj-color" type="color" className="input" style={{ padding: 2 }} value={o.color} onChange={(e) => onChange({ color: e.target.value })} /></Field>}
          <Field label="Character model" htmlFor="obj-npc-model" help={models.length ? "An imported character (.glb or .gltf), facing south at rotation 0. Free ones: Assets, Free library, Characters." : "Import a character in Assets (or add one from the free library's Characters) to use it here."}>
            <select
              id="obj-npc-model"
              className="select"
              disabled={!models.length && !o.model}
              value={o.model ?? ""}
              onChange={async (e) => {
                const asset = e.target.value;
                if (!asset) return onChange({ model: undefined, animation: undefined, height: undefined } as Partial<WorldObject>);
                const read = await readModel(asset, assetUrl);
                onChange({ model: asset, height: read?.height ?? 1.8, animation: read ? pickClip(read.clips, undefined, "idle") : undefined } as Partial<WorldObject>);
              }}
            >
              <option value="">None (drawn figure)</option>
              {o.model && !models.includes(o.model) && <option value={o.model}>{o.model} (missing)</option>}
              {models.map((m) => <option key={m} value={m}>{m.replace(/^assets\//, "")}</option>)}
            </select>
          </Field>
          {o.model && (
            <div className="field-row">
              <Field label="Height (m)" htmlFor="obj-npc-height"><NumberInput id="obj-npc-height" value={o.height ?? 1.8} min={0.3} max={10} step={0.1} onCommit={(height) => onChange({ height } as Partial<WorldObject>)} /></Field>
              <Field label="Animation" htmlFor="obj-npc-anim"><ClipSelect id="obj-npc-anim" value={o.animation} clips={info?.clips ?? null} none="Idle (guessed)" onChange={(animation) => onChange({ animation } as Partial<WorldObject>)} /></Field>
            </div>
          )}
          {o.model && error && <Notice kind="warn">{error}</Notice>}
          <Switch
            checked={Boolean(o.ai)}
            label="Answers players with AI (in Game Studio)"
            onChange={(on) => onChange({ ai: on ? { persona: "", knows: "" } : undefined } as Partial<WorldObject>)}
          />
          {o.ai && (
            <>
              <Field label="Who they are" htmlFor="obj-npc-persona" help="How they talk and what they are like. Players type questions after pressing E; the answer comes from the AI chosen in Settings, only while the game plays inside Game Studio. Exported games show the rules' written lines.">
                <textarea id="obj-npc-persona" className="textarea" rows={3} maxLength={600} key={`p-${o.id}-${o.ai.persona}`} defaultValue={o.ai.persona} onBlur={(e) => e.target.value !== o.ai?.persona && onChange({ ai: { ...o.ai!, persona: e.target.value.trim() } } as Partial<WorldObject>)} />
              </Field>
              <Field label="What they know" htmlFor="obj-npc-knows" help="Facts they can tell the player: where things are, what to do next. They say so when asked about anything else.">
                <textarea id="obj-npc-knows" className="textarea" rows={4} maxLength={1200} key={`k-${o.id}-${o.ai.knows}`} defaultValue={o.ai.knows} onBlur={(e) => e.target.value !== o.ai?.knows && onChange({ ai: { ...o.ai!, knows: e.target.value.trim() } } as Partial<WorldObject>)} />
              </Field>
            </>
          )}
        </>
      )}
      {o.type === "enemy" && (
        <>
          <Field label="Name" htmlFor="obj-ename"><TextInput id="obj-ename" value={o.name} maxLength={60} onCommit={(name) => name.trim() && onChange({ name } as Partial<WorldObject>)} /></Field>
          <Field label="Kind" htmlFor="obj-ekind" help="Rules count enemies by kind (Enemies Defeated, Enemies In Level)."><TextInput id="obj-ekind" mono value={o.kind} onCommit={(kind) => /^[a-z][a-z0-9_]{0,31}$/.test(kind) && onChange({ kind } as Partial<WorldObject>)} /></Field>
          <div className="field-row">
            <Field label="Health (hits)" htmlFor="obj-ehealth"><NumberInput id="obj-ehealth" value={o.health} min={1} max={20} step={1} onCommit={(health) => onChange({ health: Math.round(health) } as Partial<WorldObject>)} /></Field>
            <Field label="Damage (hearts)" htmlFor="obj-edamage"><NumberInput id="obj-edamage" value={o.damage} min={1} max={10} step={1} onCommit={(damage) => onChange({ damage: Math.round(damage) } as Partial<WorldObject>)} /></Field>
          </div>
          <div className="field-row">
            <Field label="Speed (m/s)" htmlFor="obj-espeed" help="0 stands guard."><NumberInput id="obj-espeed" value={o.speed} min={0} max={12} step={0.5} onCommit={(speed) => onChange({ speed } as Partial<WorldObject>)} /></Field>
            <Field label="Sight (m)" htmlFor="obj-esight" help="Chases the player this close."><NumberInput id="obj-esight" value={o.sight} min={0} max={40} step={0.5} onCommit={(sight) => onChange({ sight } as Partial<WorldObject>)} /></Field>
            <Field label="Roam (m)" htmlFor="obj-eroam" help="Wanders this far from its spot."><NumberInput id="obj-eroam" value={o.roam} min={0} max={30} step={0.5} onCommit={(roam) => onChange({ roam } as Partial<WorldObject>)} /></Field>
          </div>
          {!o.model && <Field label="Colour" htmlFor="obj-ecolor"><input id="obj-ecolor" type="color" className="input" style={{ padding: 2 }} value={o.color} onChange={(e) => onChange({ color: e.target.value } as Partial<WorldObject>)} /></Field>}
          <Field label="Character model" htmlFor="obj-enemy-model" help={models.length ? "An imported character (.glb or .gltf) instead of the beetle; it walks and stands with its own animations." : "Import a character in Assets (or add one from the free library's Characters) to use it here."}>
            <select
              id="obj-enemy-model"
              className="select"
              disabled={!models.length && !o.model}
              value={o.model ?? ""}
              onChange={async (e) => {
                const asset = e.target.value;
                if (!asset) return onChange({ model: undefined, height: undefined } as Partial<WorldObject>);
                const read = await readModel(asset, assetUrl);
                onChange({ model: asset, height: read?.height ?? 1.8 } as Partial<WorldObject>);
              }}
            >
              <option value="">None (thorn beetle)</option>
              {o.model && !models.includes(o.model) && <option value={o.model}>{o.model} (missing)</option>}
              {models.map((m) => <option key={m} value={m}>{m.replace(/^assets\//, "")}</option>)}
            </select>
          </Field>
          {o.model && <Field label="Height (m)" htmlFor="obj-enemy-height"><NumberInput id="obj-enemy-height" value={o.height ?? 1.8} min={0.3} max={10} step={0.1} onCommit={(height) => onChange({ height } as Partial<WorldObject>)} /></Field>}
          {o.model && error && <Notice kind="warn">{error}</Notice>}
        </>
      )}
      {o.type === "crate" && (
        <>
          <Field label="Look" htmlFor="obj-crate-variant" help="The player pushes it by walking into it; rules hear when it is pushed into a zone.">
            <select id="obj-crate-variant" className="select" value={o.variant} disabled={Boolean(o.model)} onChange={(e) => onChange({ variant: e.target.value as "wood" } as Partial<WorldObject>)}>
              <option value="wood">Wooden crate</option>
              <option value="stone">Stone block</option>
            </select>
          </Field>
          <Field label="Model" htmlFor="obj-crate-model" help={models.length ? "An imported model (.glb or .gltf) drawn in its place, fitted to the 1.2 m block; it still pushes as a block." : "Import a model in Assets to use it here."}>
            <select id="obj-crate-model" className="select" disabled={!models.length && !o.model} value={o.model ?? ""} onChange={(e) => onChange({ model: e.target.value || undefined } as Partial<WorldObject>)}>
              <option value="">None (the look above)</option>
              {o.model && !models.includes(o.model) && <option value={o.model}>{o.model} (missing)</option>}
              {models.map((m) => <option key={m} value={m}>{m.replace(/^assets\//, "")}</option>)}
            </select>
          </Field>
          {o.model && error && <Notice kind="warn">{error}</Notice>}
        </>
      )}
      {o.type === "gate" && (
        <>
          <Field label="Width (m)" htmlFor="obj-width"><NumberInput id="obj-width" value={o.width} min={2} max={12} onCommit={(width) => onChange({ width })} /></Field>
          <Field label="Model" htmlFor="obj-gate-model" help={models.length ? "An imported gate drawn in its place, scaled so its door (parts named ...Door...) is the gate's width; the door sinks when the gate opens." : "Import a model in Assets to use it here."}>
            <select id="obj-gate-model" className="select" disabled={!models.length && !o.model} value={o.model ?? ""} onChange={(e) => onChange({ model: e.target.value || undefined } as Partial<WorldObject>)}>
              <option value="">None (stone pillars)</option>
              {o.model && !models.includes(o.model) && <option value={o.model}>{o.model} (missing)</option>}
              {models.map((m) => <option key={m} value={m}>{m.replace(/^assets\//, "")}</option>)}
            </select>
          </Field>
          {o.model && error && <Notice kind="warn">{error}</Notice>}
        </>
      )}
      {(o.type === "zone" || o.type === "water") && <Field label="Radius (m)" htmlFor="obj-radius"><NumberInput id="obj-radius" value={o.radius} min={0.5} max={40} onCommit={(radius) => onChange({ radius })} /></Field>}
      {o.type === "zone" && (
        <>
          <Field label="Label" htmlFor="obj-zlabel"><TextInput id="obj-zlabel" value={o.label} maxLength={60} onCommit={(label) => onChange({ label })} /></Field>
          <Switch checked={o.visible} label="Show the ring in the game" onChange={(visible) => onChange({ visible })} />
        </>
      )}
      {o.type === "model" && (
        <>
          <Field label="Model file" htmlFor="obj-asset" help="A .glb or .gltf in the project's assets folder. Import more in Assets.">
            <select id="obj-asset" className="select" value={o.asset} onChange={(e) => onChange({ asset: e.target.value })}>
              {!models.includes(o.asset) && <option value={o.asset}>{o.asset || "Choose a model"}{o.asset ? " (missing)" : ""}</option>}
              {models.map((m) => <option key={m} value={m}>{m.replace(/^assets\//, "")}</option>)}
            </select>
          </Field>
          <Switch checked={o.collide} label="The player bumps into it" onChange={(collide) => onChange({ collide })} />
          <Field label="Animation" htmlFor="obj-model-anim" help={info && info.clips.length === 0 ? "This model has no animations." : "Loops in the game and the 3D view."}>
            <ClipSelect id="obj-model-anim" value={o.animation} clips={info?.clips ?? null} none="None (still)" onChange={(animation) => onChange({ animation } as Partial<WorldObject>)} />
          </Field>
          {error && <Notice kind="warn">{error}</Notice>}
        </>
      )}
      {o.type === "sign" && (
        <Field label="Text" htmlFor="obj-text">
          <textarea id="obj-text" className="textarea" rows={3} maxLength={200} key={o.text} defaultValue={o.text} onBlur={(e) => e.target.value.trim() && e.target.value !== o.text && onChange({ text: e.target.value })} />
        </Field>
      )}
      {(TEXTURED_TYPES as readonly string[]).includes(o.type) && (
        <>
          <Field label="Texture" htmlFor="obj-texture" help={textures.length ? "A texture set projected over the object's plain parts (glowing parts keep their colour). Normal and roughness maps with matching names are used too." : "Import a texture in Assets, or get one from the free library's Textures, to use it here."}>
            <select id="obj-texture" className="select" disabled={!textures.length && !material} value={material?.albedo ?? ""} onChange={(e) => setMaterial(e.target.value ? { albedo: e.target.value, ...matchingMaps(e.target.value, textures), tile: material?.tile ?? 1, tint: material?.tint ?? false } : undefined)}>
              <option value="">None (plain colours)</option>
              {material && !textures.includes(material.albedo) && <option value={material.albedo}>{material.albedo} (missing)</option>}
              {textures.map((t) => <option key={t} value={t}>{t.replace(/^assets\//, "")}</option>)}
            </select>
          </Field>
          {material && (
            <>
              <Field label="Repeat every (m)" htmlFor="obj-tex-tile"><NumberInput id="obj-tex-tile" value={material.tile} min={0.1} max={20} step={0.1} onCommit={(tile) => setMaterial({ ...material, tile })} /></Field>
              <Switch checked={material.tint} label="Keep the object's colours over the texture" onChange={(tint) => setMaterial({ ...material, tint })} />
              {material.normal || material.roughness ? <p className="xsmall muted" style={{ margin: 0 }}>With {[material.normal && "a normal map", material.roughness && "a roughness map"].filter(Boolean).join(" and ")} (used in the game; the 3D view shows the colour map).</p> : null}
            </>
          )}
        </>
      )}
      <div className="row">
        <Button size="small" icon={<CopyIcon />} onClick={onDuplicate}>Duplicate</Button>
        <Button size="small" variant="danger" icon={<TrashIcon />} onClick={onDelete}>Delete</Button>
      </div>
    </div>
  );
}

/**
 * Play as a free character in one step (desktop app, Godot projects, while the player is the capsule):
 * downloads it from the library, records it in Assets with its licence, and makes it the player. The
 * suggestion follows the level's style: a realistic person, the anime Godette, or the robot.
 */
function PlayAs({ style, models, onAdded }: { style: string | undefined; models: string[]; onAdded: (asset: string) => Promise<void> }) {
  const root = useProject((s) => s.root);
  const manifest = useProject((s) => s.manifest);
  const refresh = useProject((s) => s.refresh);
  const [list, setList] = useState<LibraryCharacter[] | null>(null);
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    libraryCharacters().then(
      (l) => live && setList(l),
      (e) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, []);
  if (!root || !manifest || manifest.engine.id !== "godot") return null;
  const engineDir = manifest.engine.projectDir;
  const indexPath = manifest.assetsIndex;
  if (!list) return error ? <Notice kind="warn">{error}</Notice> : null;
  const picked = list.find((c) => c.id === (choice || suggestedCharacter(style))) ?? list[0];
  if (!picked) return null;
  const size = picked.bytes >= 1_000_000 ? `${Math.round(picked.bytes / 1_000_000)} MB` : `${Math.round(picked.bytes / 1024)} KB`;
  // The library saves a character's model as assets/characters/<id>/<model>: one already there is used as it is.
  const saved = `assets/characters/${picked.id}/${picked.main}`;
  const have = models.includes(saved);
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const asset = have ? saved : await addLibraryCharacter(root, engineDir, indexPath, picked);
      if (!have) await refresh();
      await onAdded(asset);
    } catch (e) {
      setError(`${picked.name}: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Field label="Play as a free character" htmlFor="p-play-as" help={have ? `Already in Assets (${picked.license}): plays as it.` : `Downloads it from the free library (${size}${picked.needsGodot ? ", then Godot converts it" : ""}), records it in Assets with its licence (${picked.license}), and plays as it.`}>
        <div className="row" style={{ gap: 6 }}>
          <select id="p-play-as" className="select" value={picked.id} disabled={busy} onChange={(e) => setChoice(e.target.value)}>
            {list.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <Button size="small" variant="primary" busy={busy} onClick={() => void add()}>Play as it</Button>
        </div>
      </Field>
      {error && <Notice kind="error">{error}</Notice>}
    </>
  );
}

function WorldSettings({ world, textures, skies, models, audioFiles, assetUrl, godot, onChange }: { world: World; textures: string[]; skies: string[]; models: string[]; audioFiles: string[]; assetUrl: ((a: string) => string | null) | undefined; godot: boolean; onChange: (w: World) => void }) {
  const env = world.environment;
  const p = world.player;
  const c = p.character;
  const { info, error } = useModelInfo(c?.asset, assetUrl);
  // Choosing a character can wait on a download or on reading the model: apply it to the level as it is then.
  const latest = useRef(world);
  latest.current = world;
  const setCharacter = (next: Character | undefined) => {
    const now = latest.current;
    const { character: _old, ...rest } = now.player;
    onChange({ ...now, player: next ? { ...rest, character: next } : rest });
  };
  const chooseCharacter = async (asset: string) => {
    if (!asset) return setCharacter(undefined);
    const read = await readModel(asset, assetUrl);
    const clips = read ? guessClips(read.clips) : {};
    setCharacter({ asset, height: read?.height ?? 1.8, turn: 180, ...clips });
  };
  const setEnv = (patch: Partial<World["environment"]>) => onChange({ ...world, environment: { ...env, ...patch } });
  const setPlayer = (patch: Partial<World["player"]>) => onChange({ ...world, player: { ...p, ...patch } });
  return (
    <div className="inspector">
      <div className="stack" style={{ gap: 4 }}>
        <div className="section-label">Level</div>
        <TextInput ariaLabel="Level name" value={world.name} maxLength={80} onCommit={(name) => name.trim() && onChange({ ...world, name })} />
      </div>
      <div className="field-row">
        <Field label="Width (m)" htmlFor="w-width"><NumberInput id="w-width" value={world.size.width} min={20} max={400} onCommit={(width) => onChange({ ...world, size: { ...world.size, width } })} /></Field>
        <Field label="Depth (m)" htmlFor="w-depth"><NumberInput id="w-depth" value={world.size.depth} min={20} max={400} onCommit={(depth) => onChange({ ...world, size: { ...world.size, depth } })} /></Field>
      </div>
      <div className="section-label">Player</div>
      <div className="field-row">
        <Field label="Walk speed" htmlFor="p-speed"><NumberInput id="p-speed" value={p.speed} min={1} max={20} onCommit={(speed) => setPlayer({ speed })} /></Field>
        <Field label="Sprint ×" htmlFor="p-sprint"><NumberInput id="p-sprint" value={p.sprintMultiplier} min={1} max={3} step={0.1} onCommit={(sprintMultiplier) => setPlayer({ sprintMultiplier })} /></Field>
        <Field label="Jump" htmlFor="p-jump"><NumberInput id="p-jump" value={p.jumpVelocity} min={0} max={20} onCommit={(jumpVelocity) => setPlayer({ jumpVelocity })} /></Field>
        <Field label="Camera distance" htmlFor="p-cam"><NumberInput id="p-cam" value={p.cameraDistance} min={2} max={20} onCommit={(cameraDistance) => setPlayer({ cameraDistance })} /></Field>
      </div>
      <Field label="Hearts" htmlFor="p-health" help={!godot ? "Hearts are used in Godot projects; the Unity and Unreal games have no health." : "How many hearts the player starts with. Enemies and the Hurt Player rule take them; with none left the player starts again at the spawn point."}>
        <NumberInput id="p-health" value={p.health ?? 3} min={1} max={20} step={1} disabled={!godot} onCommit={(health) => setPlayer({ health: Math.round(health) })} />
      </Field>
      <Field
        label="Character"
        htmlFor="p-character"
        help={!godot ? "Imported characters are used in Godot projects; Unity and Unreal set up characters in their own editors." : models.length ? "An imported, animated character instead of the capsule. Free ones: Assets, Free library, Characters." : "Import a character (.glb or .gltf) in Assets, or add one from the free library's Characters, to play as it."}
      >
        <select id="p-character" className="select" disabled={!godot || (!models.length && !c)} value={c?.asset ?? ""} onChange={(e) => void chooseCharacter(e.target.value)}>
          <option value="">None (the capsule)</option>
          {c && !models.includes(c.asset) && <option value={c.asset}>{c.asset} (missing)</option>}
          {models.map((m) => <option key={m} value={m}>{m.replace(/^assets\//, "")}</option>)}
        </select>
      </Field>
      {godot && !c && backend.kind !== "browser" && <PlayAs style={env.style} models={models} onAdded={chooseCharacter} />}
      {c && (
        <>
          <div className="field-row">
            <Field label="Height (m)" htmlFor="p-char-height"><NumberInput id="p-char-height" value={c.height} min={0.3} max={10} step={0.1} onCommit={(height) => setCharacter({ ...c, height })} /></Field>
            <Field label="Turn (°)" htmlFor="p-char-turn" help="Most characters face the camera as made; 180 turns them to face where the player walks."><NumberInput id="p-char-turn" value={c.turn} min={-360} max={360} step={15} onCommit={(turn) => setCharacter({ ...c, turn })} /></Field>
          </div>
          <div className="field-row">
            {CHARACTER_STATES.map((state) => (
              <Field key={state} label={`${state[0]!.toUpperCase()}${state.slice(1)} animation`} htmlFor={`p-char-${state}`}>
                <ClipSelect
                  id={`p-char-${state}`}
                  value={c[state]}
                  clips={info?.clips ?? null}
                  none={state === "jump" ? "None (keep moving)" : state === "run" ? "Same as walk" : state === "walk" ? "Same as run" : "First idle-like"}
                  onChange={(v) => {
                    const { [state]: _drop, ...rest } = c;
                    setCharacter(v ? { ...rest, [state]: v } : rest);
                  }}
                />
              </Field>
            ))}
          </div>
          {error && <Notice kind="warn">{error}</Notice>}
          {info && info.clips.length === 0 && <Notice kind="warn">This model has no animations, so the character stands still.</Notice>}
        </>
      )}
      <div className="section-label">Environment</div>
      <div className="field-row">
        <Field label="Sky (top)" htmlFor="e-top"><input id="e-top" type="color" className="input" style={{ padding: 2 }} value={env.skyTop} onChange={(e) => setEnv({ skyTop: e.target.value })} /></Field>
        <Field label="Sky (horizon)" htmlFor="e-hor"><input id="e-hor" type="color" className="input" style={{ padding: 2 }} value={env.skyHorizon} onChange={(e) => setEnv({ skyHorizon: e.target.value })} /></Field>
        <Field label="Ground" htmlFor="e-ground"><input id="e-ground" type="color" className="input" style={{ padding: 2 }} value={env.ground} onChange={(e) => setEnv({ ground: e.target.value })} /></Field>
        <Field label="Fog density" htmlFor="e-fog"><NumberInput id="e-fog" value={env.fogDensity} min={0} max={0.1} step={0.002} onCommit={(fogDensity) => setEnv({ fogDensity })} /></Field>
        <Field label="Sun height (°)" htmlFor="e-elev"><NumberInput id="e-elev" value={env.sunElevation} min={5} max={90} onCommit={(sunElevation) => setEnv({ sunElevation })} /></Field>
        <Field label="Sun heading (°)" htmlFor="e-head"><NumberInput id="e-head" value={env.sunHeading} min={0} max={360} onCommit={(sunHeading) => setEnv({ sunHeading })} /></Field>
        <Field label="Sunlight" htmlFor="e-sun" help="The sunlight's colour: warm for an evening, white at midday."><input id="e-sun" type="color" className="input" style={{ padding: 2 }} value={env.sunColor ?? "#ffffff"} onChange={(e) => setEnv({ sunColor: e.target.value })} /></Field>
      </div>
      <div className="section-label">Graphics</div>
      <Field label="Style" htmlFor="e-style" help={godot ? "Anime: toon shading (a crisp line between light and shade), ink outlines and crisp clouds. Realistic: detailed trees and rocks, a filmic colour curve made for photographs, and on desktop builds light that bounces, reflections and soft shadows; best with a photographed sky and a person to play as." : "Styles are drawn by the Godot game; Unity and Unreal set their look in their own editors."}>
        <select id="e-style" className="select" disabled={!godot} value={env.style ?? "standard"} onChange={(e) => setEnv({ style: e.target.value as "standard" | "anime" | "realistic" })}>
          <option value="standard">Standard</option>
          <option value="anime">Anime</option>
          <option value="realistic">Realistic</option>
        </select>
      </Field>
      <div className="field-row">
        <Field label="Sky" htmlFor="e-sky" help={!godot ? "Photographed skies are drawn by the Godot game." : skies.length || env.skyImage ? "A photographed sky lights the level and fills the background, in place of the sky colours and clouds. Set the sun's height and heading to match the photo's sun." : "Get a photographed sky in Assets, Free library, Skies, to use it here."}>
          <select id="e-sky" className="select" disabled={!godot || (!skies.length && !env.skyImage)} value={env.skyImage ?? ""} onChange={(e) => setEnv({ skyImage: e.target.value || undefined })}>
            <option value="">Colours and clouds</option>
            {skies.map((t) => <option key={t} value={t}>{t.replace(/^assets\//, "")}</option>)}
          </select>
        </Field>
        {env.skyImage && (
          <Field label="Sky brightness" htmlFor="e-skyb" help="1 is as photographed.">
            <NumberInput id="e-skyb" value={env.skyBrightness ?? 1} min={0.1} max={4} step={0.1} disabled={!godot} onCommit={(skyBrightness) => setEnv({ skyBrightness })} />
          </Field>
        )}
      </div>
      <div className="field-row">
        <Field label="Clouds" htmlFor="e-clouds" help={!godot ? "Clouds are drawn by the Godot game; Unity and Unreal set their sky in their own editors." : env.skyImage ? "The photographed sky brings its own clouds." : "0 is a clear sky, 1 overcast."}>
          <NumberInput id="e-clouds" value={env.clouds ?? 0} min={0} max={1} step={0.05} disabled={!godot || Boolean(env.skyImage)} onCommit={(clouds) => setEnv({ clouds })} />
        </Field>
        <Field label="Ground patches" htmlFor="e-gvar" help={godot ? "Patches of drier and lusher ground: 0 is one even colour." : "Ground patches are drawn by the Godot game."}>
          <NumberInput id="e-gvar" value={env.groundVariation ?? 0} min={0} max={1} step={0.05} disabled={!godot} onCommit={(groundVariation) => setEnv({ groundVariation })} />
        </Field>
        <Field label="Grass" htmlFor="e-grass" help={godot ? "Tufts of grass over the ground, thicker where it is lush: 0 is none, 1 thick. Water and zones stay clear." : "Grass is drawn by the Godot game."}>
          <NumberInput id="e-grass" value={env.grass ?? 0} min={0} max={1} step={0.05} disabled={!godot} onCommit={(grass) => setEnv({ grass })} />
        </Field>
      </div>
      <Field label="Render quality" help="High adds ambient occlusion, glow, soft shadows and anti-aliasing to desktop builds. Play here (web) always uses the standard look.">
        <Segmented ariaLabel="Render quality" value={env.quality ?? "standard"} onChange={(quality) => setEnv({ quality })} options={[{ value: "standard", label: "Standard" }, { value: "high", label: "High" }]} />
      </Field>
      <Field label="Ground texture" htmlFor="e-gtex" help={textures.length ? "Colour image repeated over the ground. Free textures: Assets, Free library." : "Import a texture in Assets (or get one from the free library) to use it here."}>
        <select id="e-gtex" className="select" disabled={!textures.length} value={env.groundMaterial?.albedo ?? ""} onChange={(e) => setEnv({ groundMaterial: e.target.value ? guessMaterial(e.target.value, textures, env.groundMaterial?.tile ?? 4) : undefined })}>
          <option value="">None (plain colour)</option>
          {textures.map((t) => <option key={t} value={t}>{t.replace(/^assets\//, "")}</option>)}
        </select>
      </Field>
      {env.groundMaterial && (
        <>
          <Field label="Normal map" htmlFor="e-gnor">
            <select id="e-gnor" className="select" value={env.groundMaterial.normal ?? ""} onChange={(e) => setEnv({ groundMaterial: { ...env.groundMaterial!, normal: e.target.value || undefined } })}>
              <option value="">None</option>
              {textures.map((t) => <option key={t} value={t}>{t.replace(/^assets\//, "")}</option>)}
            </select>
          </Field>
          <Field label="Roughness map" htmlFor="e-grough">
            <select id="e-grough" className="select" value={env.groundMaterial.roughness ?? ""} onChange={(e) => setEnv({ groundMaterial: { ...env.groundMaterial!, roughness: e.target.value || undefined } })}>
              <option value="">None</option>
              {textures.map((t) => <option key={t} value={t}>{t.replace(/^assets\//, "")}</option>)}
            </select>
          </Field>
          <Field label="Repeat every (m)" htmlFor="e-gtile"><NumberInput id="e-gtile" value={env.groundMaterial.tile} min={0.5} max={50} step={0.5} onCommit={(tile) => setEnv({ groundMaterial: { ...env.groundMaterial!, tile } })} /></Field>
        </>
      )}
      <AudioSettings
        audio={world.audio}
        cues={SOUNDS}
        files={audioFiles}
        assetUrl={assetUrl}
        godot={godot}
        onChange={(audio) => {
          const { audio: _old, ...rest } = world;
          onChange(audio ? { ...rest, audio: audio as World["audio"] } : rest);
        }}
      />
      <p className="xsmall muted" style={{ lineHeight: 1.5 }}>Changes reach the Godot game when you save. Select an object on the map to edit it.</p>
    </div>
  );
}

export function WorldEditor({ path }: { path: string }) {
  const doc = useProject((s) => s.docs[path]);
  const updateDoc = useProject((s) => s.updateDoc);
  const focus = useFocus((s) => s.request);
  const world = doc?.data as World | undefined;
  const root = useProject((s) => s.root);
  const manifest = useProject((s) => s.manifest);
  const files = useProject((s) => s.files);
  // Imported models and textures live in the engine project's assets folder (res://assets/... in Godot).
  const engineDir = manifest?.engine.id === "godot" ? manifest.engine.projectDir : null;
  const assetFiles = useMemo(() => (engineDir ? files.filter((f) => f.kind === "file" && f.path.startsWith(`${engineDir}/assets/`)).map((f) => f.path.slice(engineDir.length + 1)) : []), [files, engineDir]);
  const models = useMemo(() => assetFiles.filter((p) => hasExt(p, MODEL_EXTENSIONS)).sort(), [assetFiles]);
  const textures = useMemo(() => assetFiles.filter((p) => hasExt(p, TEXTURE_EXTENSIONS)).sort(), [assetFiles]);
  const skies = useMemo(() => assetFiles.filter((p) => hasExt(p, SKY_EXTENSIONS)).sort(), [assetFiles]);
  const audioFiles = useMemo(() => assetFiles.filter((p) => hasExt(p, AUDIO_EXTENSIONS)).sort(), [assetFiles]);
  const [modelChoice, setModelChoice] = useState("");
  const placeModel = models.includes(modelChoice) ? modelChoice : models[0] ?? "";
  const assetUrl = useMemo(() => (root && engineDir && backend.kind !== "browser" ? (asset: string) => backend.assetUrl(root, `${engineDir}/${asset}`) : undefined), [root, engineDir]);
  const hasAnimated = Boolean(world && (world.player.character || world.objects.some((o) => (o.type === "npc" && o.model) || (o.type === "model" && o.animation))));
  const validation = useMemo(() => (world ? parseWorld(world) : null), [world]);
  const svgRef = useRef<SVGSVGElement>(null);
  const past = useRef<World[]>([]);
  const future = useRef<World[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [snap, setSnap] = useState(true);
  const [grid, setGrid] = useState(true);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<{ cx: number; cz: number; zoom: number }>({ cx: 0, cz: 0, zoom: 1 });
  const [drag, setDrag] = useState<{ kind: "object" | "spawn" | "pan"; id?: string; startX: number; startZ: number; origX: number; origZ: number; preview?: { x: number; z: number } } | null>(null);
  const [mode, setModeState] = useState<ViewMode>(readViewMode);
  const [fog, setFog] = useState(false);
  const [animateOn, setAnimateOn] = useState(true);
  const api3d = useRef<World3DApi | null>(null);
  const [, bump] = useState(0);
  const setMode = (m: ViewMode) => {
    setModeState(m);
    saveViewMode(m);
  };

  useEffect(() => {
    if (focus?.path === path && focus.objectId) {
      setSelected(focus.objectId);
      const o = (doc?.data as World | undefined)?.objects?.find((x) => x.id === focus.objectId);
      if (o) api3d.current?.focus(o.x, o.z);
    }
    // Only a new focus request moves the camera, not every edit of the document.
  }, [focus, path]);

  const commit = useCallback(
    (next: World) => {
      if (!world) return;
      past.current.push(world);
      if (past.current.length > 100) past.current.shift();
      future.current = [];
      updateDoc(path, next);
      bump((x) => x + 1);
    },
    [path, updateDoc, world],
  );

  // A trackpad pinch reaches WebKit pages on macOS as gesture events with a running scale, not as wheel
  // events. The map zooms with it here; the 3D view handles its own (level3d-view.ts).
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const pinch = useRef<{ mode: ViewMode; zoomAt: (factor: number, clientX: number, clientY: number) => void }>({ mode, zoomAt: () => {} });
  useEffect(() => {
    if (!viewport) return;
    let last = 1;
    const onGesture = (e: Event) => {
      if (pinch.current.mode !== "map") return;
      e.preventDefault();
      if (e.type === "gestureend") return;
      const g = e as Event & { scale?: unknown; clientX?: unknown; clientY?: unknown };
      const scale = typeof g.scale === "number" && g.scale > 0 ? g.scale : 1;
      if (e.type === "gesturestart") last = 1;
      const r = viewport.getBoundingClientRect();
      const x = typeof g.clientX === "number" && Number.isFinite(g.clientX) ? g.clientX : r.left + r.width / 2;
      const y = typeof g.clientY === "number" && Number.isFinite(g.clientY) ? g.clientY : r.top + r.height / 2;
      pinch.current.zoomAt(scale / last, x, y);
      last = scale;
    };
    const types = ["gesturestart", "gesturechange", "gestureend"];
    for (const t of types) viewport.addEventListener(t, onGesture);
    return () => {
      for (const t of types) viewport.removeEventListener(t, onGesture);
    };
  }, [viewport]);

  if (!doc) return null;
  if (doc.error || !world || !Array.isArray(world.objects)) return <div style={{ padding: 16 }}><Notice kind="error">{path} cannot be shown as a world layout{doc.error ? `: ${doc.error}` : ""}.</Notice></div>;

  const W = world.size.width;
  const D = world.size.depth;
  const pad = 6;
  const vw = (W + pad * 2) / view.zoom;
  const vh = (D + pad * 2) / view.zoom;
  const viewBox = `${view.cx - vw / 2} ${view.cz - vh / 2} ${vw} ${vh}`;

  const toWorld = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    const m = svg?.getScreenCTM();
    if (!svg || !m) return { x: 0, z: 0 };
    const p = new DOMPoint(clientX, clientY).matrixTransform(m.inverse());
    return { x: p.x, z: p.y };
  };
  const clampX = (x: number) => Math.max(-W / 2, Math.min(W / 2, x));
  const clampZ = (z: number) => Math.max(-D / 2, Math.min(D / 2, z));
  const place = (x: number, z: number) => ({ x: fix(clampX(snap ? round(x, 1) : x)), z: fix(clampZ(snap ? round(z, 1) : z)) });

  const patchObject = (id: string, patch: Partial<WorldObject>) => commit({ ...world, objects: world.objects.map((o) => (o.id === id ? ({ ...o, ...patch } as WorldObject) : o)) });
  const addObject = (type: WorldObjectType, x: number, z: number) => {
    const id = nextObjectId(world, TYPE_META[type].prefix);
    const p = place(x, z);
    const o = OBJECT_DEFAULTS[type](id, p.x, p.z);
    if (o.type === "model") {
      if (!placeModel) return;
      o.asset = placeModel;
    }
    if ((o.type === "enemy" || o.type === "crate") && !engineDir) return;
    commit({ ...world, objects: [...world.objects, o] });
    setSelected(id);
  };
  const removeObject = (id: string) => {
    commit({ ...world, objects: world.objects.filter((o) => o.id !== id) });
    setSelected(null);
  };
  const turn = (id: string, degrees: number) => {
    const o = world.objects.find((x) => x.id === id);
    if (o) patchObject(id, { rotation: normalizeRotation(o.rotation + degrees) });
  };
  /** Brings an object to the middle of whichever view is showing. */
  const centreOn = (o: WorldObject) => {
    setView((v) => ({ ...v, cx: o.x, cz: o.z }));
    api3d.current?.focus(o.x, o.z);
  };
  const centre = () => (mode === "3d" && api3d.current ? api3d.current.center() : { x: view.cx, z: view.cz });
  const zoomBy = (factor: number) => {
    if (mode === "3d") api3d.current?.zoom(1 / factor);
    else setView((v) => ({ ...v, zoom: Math.min(8, Math.max(0.5, v.zoom * factor)) }));
  };
  const fitAll = () => {
    if (mode === "3d") api3d.current?.fit();
    else setView({ cx: 0, cz: 0, zoom: 1 });
  };
  const duplicate = (id: string) => {
    const o = world.objects.find((x) => x.id === id);
    if (!o) return;
    const copyId = nextObjectId(world, TYPE_META[o.type].prefix);
    const p = place(o.x + 2, o.z + 2);
    commit({ ...world, objects: [...world.objects, { ...o, id: copyId, x: p.x, z: p.z }] });
    setSelected(copyId);
  };
  const undo = () => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(world);
    updateDoc(path, prev);
    bump((x) => x + 1);
  };
  const redo = () => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(world);
    updateDoc(path, next);
    bump((x) => x + 1);
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    const target = (e.target as Element).closest("[data-obj]") as SVGGElement | null;
    const pt = toWorld(e.clientX, e.clientY);
    (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
    if (target?.dataset["obj"] === "__spawn") {
      setDrag({ kind: "spawn", startX: pt.x, startZ: pt.z, origX: world.player.spawn.x, origZ: world.player.spawn.z });
    } else if (target) {
      const id = target.dataset["obj"]!;
      const o = world.objects.find((x) => x.id === id)!;
      setSelected(id);
      setDrag({ kind: "object", id, startX: pt.x, startZ: pt.z, origX: o.x, origZ: o.z });
    } else {
      setSelected(null);
      setDrag({ kind: "pan", startX: e.clientX, startZ: e.clientY, origX: view.cx, origZ: view.cz });
    }
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag) return;
    if (drag.kind === "pan") {
      const r = svgRef.current!.getBoundingClientRect();
      const unitsPerPx = vw / r.width;
      setView((v) => ({ ...v, cx: drag.origX - (e.clientX - drag.startX) * unitsPerPx, cz: drag.origZ - (e.clientY - drag.startZ) * unitsPerPx }));
      return;
    }
    const pt = toWorld(e.clientX, e.clientY);
    setDrag({ ...drag, preview: place(drag.origX + pt.x - drag.startX, drag.origZ + pt.z - drag.startZ) });
  };
  const onPointerUp = () => {
    if (drag?.preview) {
      if (drag.kind === "object" && drag.id && (drag.preview.x !== drag.origX || drag.preview.z !== drag.origZ)) patchObject(drag.id, drag.preview);
      if (drag.kind === "spawn") commit({ ...world, player: { ...world.player, spawn: drag.preview } });
    }
    setDrag(null);
  };
  /** Zooms the map by factor, keeping the spot under (clientX, clientY) where it is. */
  const zoomMapAt = (factor: number, clientX: number, clientY: number) => {
    const p = toWorld(clientX, clientY);
    setView((v) => {
      const zoom = Math.min(8, Math.max(0.5, v.zoom * factor));
      const k = v.zoom / zoom;
      return { zoom, cx: p.x + (v.cx - p.x) * k, cz: p.z + (v.cz - p.z) * k };
    });
  };
  pinch.current = { mode, zoomAt: zoomMapAt };
  const onWheel = (e: React.WheelEvent) => zoomMapAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);

  const shown = world.objects.map((o) => (drag?.kind === "object" && drag.id === o.id && drag.preview ? ({ ...o, ...drag.preview } as WorldObject) : o));
  const spawn = drag?.kind === "spawn" && drag.preview ? drag.preview : world.player.spawn;
  const order: WorldObjectType[] = ["water", "zone", "gate", "rock", "tree", "sign", "torch", "collectible", "npc"];
  const sorted = [...shown].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  const selectedObject = world.objects.find((o) => o.id === selected) ?? null;
  const filtered = world.objects.filter((o) => !query || o.id.includes(query.toLowerCase()) || o.type.includes(query.toLowerCase()));

  return (
    <div
      style={{ height: "100%" }}
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).closest("input, textarea, select")) return;
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
          e.preventDefault();
          if (e.shiftKey) redo();
          else undo();
        } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d" && selected) {
          e.preventDefault();
          duplicate(selected);
        } else if ((e.key === "Delete" || e.key === "Backspace") && selected) {
          e.preventDefault();
          removeObject(selected);
        } else if (selected && !e.metaKey && !e.ctrlKey && !e.altKey && (e.key.toLowerCase() === "q" || e.key.toLowerCase() === "e")) {
          e.preventDefault();
          const step = e.shiftKey ? 1 : 15;
          turn(selected, e.key.toLowerCase() === "q" ? -step : step);
        } else if (selected && !e.metaKey && !e.ctrlKey && e.key.toLowerCase() === "f") {
          e.preventDefault();
          const o = world.objects.find((x) => x.id === selected);
          if (o) centreOn(o);
        } else if (e.key === "Escape" && selected) {
          e.preventDefault();
          setSelected(null);
        } else if (selected && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
          e.preventDefault();
          const o = world.objects.find((x) => x.id === selected)!;
          const step = e.shiftKey ? 5 : 1;
          const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
          const dz = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
          patchObject(selected, { x: fix(clampX(o.x + dx)), z: fix(clampZ(o.z + dz)) });
        }
      }}
    >
      <Group orientation="horizontal" style={{ height: "100%" }}>
        <Panel id="world-left" defaultSize={230} minSize={180} maxSize={360} collapsible>
          <div className="panel">
            <div className="panel__header"><span className="panel__title">Add objects</span></div>
            <div style={{ padding: "6px 0", borderBottom: "1px solid var(--line)" }}>
              {OBJECT_TYPES.map((t) => t === "model" ? (
                <div key={t} style={{ borderTop: "1px solid var(--line)", marginTop: 4, paddingTop: 4 }}>
                  <button
                    type="button"
                    className="world-palette-item"
                    draggable={Boolean(placeModel)}
                    disabled={!placeModel}
                    data-tip={!engineDir ? "Imported models are placed in Godot projects. Unity and Unreal import models in their own editors." : placeModel ? `Drag to place ${placeModel.split("/").pop()}, or press to add it at the centre` : "Import a .glb or .gltf in Assets, or get a free model from the library there"}
                    onDragStart={(e) => { e.dataTransfer.setData(OBJ_MIME, t); e.dataTransfer.effectAllowed = "copy"; }}
                    onClick={() => {
                      const c = centre();
                      addObject(t, c.x, c.z);
                    }}
                    aria-label={`Add ${TYPE_META[t].label}`}
                  >
                    {TYPE_META[t].icon}
                    {TYPE_META[t].label}
                  </button>
                  {models.length > 1 && (
                    <select className="select" style={{ margin: "2px 10px 6px", width: "calc(100% - 20px)" }} aria-label="Model to place" value={placeModel} onChange={(e) => setModelChoice(e.target.value)}>
                      {models.map((m) => <option key={m} value={m}>{m.split("/").pop()}</option>)}
                    </select>
                  )}
                </div>
              ) : (
                <button
                  key={t}
                  type="button"
                  className="world-palette-item"
                  draggable={!((t === "enemy" || t === "crate") && !engineDir)}
                  disabled={(t === "enemy" || t === "crate") && !engineDir}
                  data-tip={(t === "enemy" || t === "crate") && !engineDir ? `${t === "enemy" ? "Enemies" : "Pushable blocks"} work in Godot projects. The Unity and Unreal valleys keep collectibles, characters, gates and zones.` : mode === "3d" ? "Drag into the 3D view, or press to add where the camera looks" : "Drag onto the map, or press to add at the centre"}
                  onDragStart={(e) => { e.dataTransfer.setData(OBJ_MIME, t); e.dataTransfer.effectAllowed = "copy"; }}
                  onClick={() => {
                    const c = centre();
                    addObject(t, c.x, c.z);
                  }}
                  aria-label={`Add ${TYPE_META[t].label}`}
                >
                  {TYPE_META[t].icon}
                  {TYPE_META[t].label}
                </button>
              ))}
            </div>
            <div className="panel__header"><span className="panel__title">Objects ({world.objects.length})</span></div>
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
                  <span className="faint xsmall" style={{ marginLeft: "auto" }}>{fix(o.x)}, {fix(o.z)}</span>
                </button>
              ))}
            </div>
          </div>
        </Panel>
        <Separator className="sep sep--v" />
        <Panel id="world-map" minSize={300}>
          <div
            ref={setViewport}
            style={{ position: "relative", height: "100%" }}
            tabIndex={0}
            onPointerDownCapture={(e) => e.currentTarget.focus({ preventScroll: true })}
            aria-label={`${mode === "3d" ? "3D view" : "World map"}. Arrow keys move the selected object, Q and E turn it, F centres it, Delete removes it.`}
          >
            <div className="world-toolbar">
              <Segmented
                ariaLabel="View"
                value={mode}
                onChange={setMode}
                options={[
                  { value: "map", label: <><MapIcon width={13} height={13} />Map</>, tip: "Top-down map" },
                  { value: "3d", label: <><CubeIcon width={13} height={13} />3D</>, tip: "The level in 3D, with the game's shapes and light" },
                ]}
              />
              <span className="world-toolbar__sep" />
              <IconButton small label="Undo (⌘Z)" tip={past.current.length === 0 ? "Nothing to undo yet" : "Undo (⌘Z)"} disabled={past.current.length === 0} onClick={undo}><UndoIcon /></IconButton>
              <IconButton small label="Redo (⇧⌘Z)" tip={future.current.length === 0 ? "Nothing to redo" : "Redo (⇧⌘Z)"} disabled={future.current.length === 0} onClick={redo}><RedoIcon /></IconButton>
              <span className="world-toolbar__sep" />
              <IconButton small label="Zoom in" onClick={() => zoomBy(1.25)}><ZoomInIcon /></IconButton>
              <IconButton small label="Zoom out" onClick={() => zoomBy(1 / 1.25)}><ZoomOutIcon /></IconButton>
              <IconButton small label={mode === "3d" ? "Show the whole level" : "Fit the whole map"} onClick={fitAll}><MapIcon /></IconButton>
              <IconButton small label="Centre on the selected object (F)" tip={selectedObject ? "Centre on the selected object (F)" : "Select an object first"} disabled={!selectedObject} onClick={() => selectedObject && centreOn(selectedObject)}><FocusIcon /></IconButton>
              <span className="world-toolbar__sep" />
              <IconButton small label={snap ? "Snapping to 1 m and 15° (on)" : "Snapping off"} aria-pressed={snap} onClick={() => setSnap((s) => !s)} style={snap ? { color: "var(--mode-accent)" } : undefined}><SnapIcon /></IconButton>
              <IconButton small label={grid ? "Hide grid" : "Show grid"} aria-pressed={grid} onClick={() => setGrid((g) => !g)} style={grid ? { color: "var(--mode-accent)" } : undefined}><GridIcon /></IconButton>
              {mode === "3d" && (
                <IconButton small label={fog ? "Hide the fog (on)" : "Preview the level's fog"} aria-pressed={fog} onClick={() => setFog((f) => !f)} style={fog ? { color: "var(--mode-accent)" } : undefined}><FogIcon /></IconButton>
              )}
              {mode === "3d" && (
                <IconButton
                  small
                  label={animateOn ? "Pause animations (playing)" : "Play animations"}
                  tip={hasAnimated ? (animateOn ? "Pause the characters' and models' animations" : "Play the characters' and models' animations") : "Nothing in this level is animated: give the player a character, or a villager or model an animation"}
                  aria-pressed={animateOn}
                  disabled={!hasAnimated}
                  onClick={() => setAnimateOn((a) => !a)}
                  style={animateOn && hasAnimated ? { color: "var(--mode-accent)" } : undefined}
                >
                  {animateOn ? <PauseIcon /> : <PlayIcon />}
                </IconButton>
              )}
            </div>
            {mode === "3d" ? (
              <Suspense fallback={<div className="level3d__notice"><span className="small muted">Loading the 3D view…</span></div>}>
                <World3D
                  world={world}
                  selected={selected}
                  grid={grid}
                  fog={fog}
                  snap={snap}
                  place={place}
                  objectMime={OBJ_MIME}
                  api={api3d}
                  camera={cameras.get(path) ?? null}
                  onCameraSave={(c) => cameras.set(path, c)}
                  onSelect={setSelected}
                  onMove={(id, x, z) => world.objects.some((o) => o.id === id) && patchObject(id, { x, z })}
                  onRotate={(id, rotation) => world.objects.some((o) => o.id === id) && patchObject(id, { rotation })}
                  onMoveSpawn={(x, z) => commit({ ...world, player: { ...world.player, spawn: { x, z } } })}
                  onDropObject={addObject}
                  onUseMap={() => setMode("map")}
                  assetUrl={assetUrl}
                  animate={animateOn}
                />
              </Suspense>
            ) : (
            <div
              className={`world-map ${drag?.kind === "pan" ? "world-map--panning" : ""}`}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
              onDrop={(e) => {
                e.preventDefault();
                const t = e.dataTransfer.getData(OBJ_MIME) as WorldObjectType;
                if (OBJECT_TYPES.includes(t)) {
                  const p = toWorld(e.clientX, e.clientY);
                  addObject(t, p.x, p.z);
                }
              }}
            >
              <svg ref={svgRef} viewBox={viewBox} preserveAspectRatio="xMidYMid meet" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onWheel={onWheel} data-testid="world-map" role="application" aria-label="Top-down map of the level">
                <defs>
                  <pattern id="grid10" width="10" height="10" patternUnits="userSpaceOnUse" x={-W / 2} y={-D / 2}>
                    <path d="M 10 0 L 0 0 0 10" fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="0.12" />
                  </pattern>
                </defs>
                <rect x={-W / 2} y={-D / 2} width={W} height={D} fill={world.environment.ground} opacity={0.42} stroke="rgba(255,255,255,0.18)" strokeWidth={0.25} />
                {grid && <rect x={-W / 2} y={-D / 2} width={W} height={D} fill="url(#grid10)" pointerEvents="none" />}
                <text x={0} y={-D / 2 - 1.6} fontSize={1.6} textAnchor="middle" fill="var(--text-3)" pointerEvents="none">North</text>
                {sorted.map((o) => (
                  <g key={o.id} data-obj={o.id} className="world-obj" transform={`translate(${o.x} ${o.z}) rotate(${o.rotation})`}>
                    <ObjectShape o={o} selected={o.id === selected} />
                    {(view.zoom >= 1.6 || o.id === selected) && <text y={(o.type === "zone" || o.type === "water" ? o.radius : 2.2) + 1.3} fontSize={1.1} textAnchor="middle" fill="var(--text-2)" transform={`rotate(${-o.rotation})`} pointerEvents="none">{o.id}</text>}
                  </g>
                ))}
                <g data-obj="__spawn" className="world-obj" transform={`translate(${spawn.x} ${spawn.z})`}>
                  <circle r={1.3} fill="rgba(56,201,180,0.2)" stroke="var(--accent)" strokeWidth={0.2} />
                  <polygon points="0,-1 0.75,0.7 0,0.3 -0.75,0.7" fill="var(--accent)" />
                </g>
              </svg>
            </div>
            )}
            <div className="world-legend">
              {mode === "3d" ? (
                <>{W} × {D} m · drag to move · drag the ring to turn (Q, E) · drag the ground to orbit · right-drag to pan · scroll to zoom</>
              ) : (
                <>{W} × {D} m · drag to move · drag empty space to pan · scroll to zoom · Q, E turn · <FootprintsIcon width={11} style={{ verticalAlign: -1 }} /> player start</>
              )}
            </div>
          </div>
        </Panel>
        <Separator className="sep sep--v" />
        <Panel id="world-inspector" defaultSize={300} minSize={240} maxSize={460} collapsible>
          <div className="panel">
            <div className="panel__header"><span className="panel__title">{selectedObject ? "Object" : "Level settings"}</span></div>
            <div className="panel__body">
              {validation && !validation.ok && (
                <div style={{ padding: "12px 12px 0" }}>
                  <Notice kind="error">{validation.errors.slice(0, 4).join(" · ")}</Notice>
                </div>
              )}
              {selectedObject ? (
                <ObjectInspector key={selectedObject.id} o={selectedObject} models={models} textures={textures} assetUrl={assetUrl} onChange={(p) => patchObject(selectedObject.id, p)} onDelete={() => removeObject(selectedObject.id)} onDuplicate={() => duplicate(selectedObject.id)} />
              ) : (
                <WorldSettings world={world} textures={textures} skies={skies} models={models} audioFiles={audioFiles} assetUrl={assetUrl} godot={Boolean(engineDir)} onChange={commit} />
              )}
            </div>
          </div>
        </Panel>
      </Group>
    </div>
  );
}

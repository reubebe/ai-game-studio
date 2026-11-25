import { engineDiagnostics, handleId, parseHandle, validateGraph, type NodeRegistry, type RuleGraph, type Diagnostic } from "@gamestudio/rules-core";
import { GODOT_ONLY_ENVIRONMENT, OBJECT_DEFAULTS, TEXTURED_TYPES, matchingMaps, parseWorld, type ObjectMaterial, type World, type WorldObject } from "@gamestudio/explore";
import { parseCatalog, type Catalog } from "@gamestudio/rpg";
import { parseLesson, type Lesson } from "@gamestudio/learn";
import { LEVEL_OBJECT_DEFAULTS, parseLevel, reachWarnings, type Level, type LevelObject } from "@gamestudio/platformer";
import { CONTROLS, DIFFICULTIES, parseMatch, SQUAD_SIZE, type Match } from "@gamestudio/football";
import { parseFarm, paintTile, resizeMap, TILES, type Farm, type TileLetter } from "@gamestudio/farm";
import type { ProjectManifest } from "@gamestudio/project";
import type { Operation, OperationKind, Proposal } from "./operations";

/** Parsed project documents an assistant may read and (through operations) change. */
export interface ProjectDocs {
  manifest: ProjectManifest;
  rules: Record<string, { path: string; graph: RuleGraph }>;
  world?: { path: string; world: World };
  /** A 2D platformer level. */
  level?: { path: string; level: Level };
  /** A football match's settings. */
  match?: { path: string; match: Match };
  /** A farm simulation's settings and map. */
  farm?: { path: string; farm: Farm };
  /** Model and texture files in the engine project's assets folder (paths as levels refer to them: assets/...), and the animations of models the studio has read. */
  assets?: { models: string[]; textures: string[]; audio?: string[]; skies?: string[]; clips?: Record<string, string[]> };
  catalog?: { path: string; catalog: Catalog };
  lessons: Record<string, { path: string; lesson: Lesson }>;
}

export interface ChangeLine {
  doc: string;
  op: number;
  text: string;
}

export interface ApplyResult {
  ok: boolean;
  docs: ProjectDocs;
  changes: ChangeLine[];
  touched: string[];
  errors: { op: number; message: string }[];
  diagnostics: { doc: string; severity: Diagnostic["severity"]; message: string }[];
}

class OpError extends Error {}

/**
 * Small models often send "4" for 4 or "[2,3,4]" for a list. Convert a value to the setting's
 * declared kind only when the conversion is unambiguous; validation still checks the result.
 */
export function coerceToKind(kind: string, value: unknown): unknown {
  if (typeof value !== "string") {
    if (kind === "numberList" && typeof value === "number") return [value];
    return value;
  }
  const text = value.trim();
  if (kind === "number" && /^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if (kind === "boolean" && (text === "true" || text === "false")) return text === "true";
  if (kind === "numberList") {
    const inner = text.replace(/^\[|\]$/g, "").trim();
    if (inner === "") return [];
    const parts = inner.split(/\s*,\s*/);
    if (parts.every((x) => /^-?\d+(\.\d+)?$/.test(x))) return parts.map(Number);
  }
  return value;
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, ""));

function setWorldField(o: WorldObject, name: string, value: unknown): void {
  const rec = o as unknown as Record<string, unknown>;
  const numeric = ["rotation", "scale", "radius", "width", "height", "health", "damage", "speed", "sight", "roam"];
  const textual = ["label", "name", "text", "kind", "variant", "color", "asset", "model", "animation"];
  const flags = ["visible", "collide"];
  if (numeric.includes(name)) value = coerceToKind("number", value);
  if (flags.includes(name)) value = coerceToKind("boolean", value);
  if (numeric.includes(name)) {
    if (typeof value !== "number") throw new OpError(`'${name}' needs a number`);
  } else if (textual.includes(name)) {
    if (typeof value !== "string") throw new OpError(`'${name}' needs text`);
  } else if (flags.includes(name)) {
    if (typeof value !== "boolean") throw new OpError(`'${name}' needs true or false`);
  } else {
    throw new OpError(`Objects have no setting called '${name}'`);
  }
  const allowedForType: Record<string, string[]> = {
    tree: ["variant"], rock: [], collectible: ["kind", "label"], npc: ["name", "color", "model", "animation", "height"], gate: ["width", "model"],
    zone: ["radius", "label", "visible"], water: ["radius"], sign: ["text"], torch: [], model: ["asset", "collide", "animation"],
    enemy: ["name", "kind", "health", "damage", "speed", "sight", "roam", "color", "model", "height"], crate: ["variant", "model"],
  };
  if (["health", "damage"].includes(name) && typeof value === "number") value = Math.round(value);
  if (!["rotation", "scale"].includes(name) && !(allowedForType[o.type] ?? []).includes(name)) {
    throw new OpError(`A ${o.type} has no '${name}' setting`);
  }
  rec[name] = value;
}

function setLevelField(o: LevelObject, name: string, value: unknown, pictures?: string[]): void {
  const rec = o as unknown as Record<string, unknown>;
  if (name === "texture" && o.type === "platform") {
    if (typeof value !== "string") throw new OpError("texture needs a picture file, or '' for the style's drawing");
    if (value === "") {
      delete rec["texture"];
      delete rec["tile"];
      return;
    }
    if (!pictures) throw new OpError("Platform pictures are used in Godot projects");
    if (!pictures.includes(value) || !/\.(png|jpe?g|webp)$/i.test(value)) throw new OpError(`There is no picture '${value}'. Pictures: ${pictures.filter((p) => /\.(png|jpe?g|webp)$/i.test(p)).join(", ") || "none (import one in Assets)"}`);
    rec["texture"] = value;
    rec["tile"] = rec["tile"] ?? 1;
    return;
  }
  const numeric = ["width", "height", "range", "speed", "tile"];
  if (numeric.includes(name)) {
    value = coerceToKind("number", value);
    if (typeof value !== "number") throw new OpError(`'${name}' needs a number`);
  } else if (typeof value !== "string") {
    throw new OpError(`'${name}' needs text`);
  }
  const allowedForType: Record<string, string[]> = {
    platform: ["width", "height", "style", "texture", "tile"], coin: ["kind", "label"], spike: ["width"], checkpoint: ["label"], goal: ["label"],
    enemy: ["range", "speed"], door: ["height"], sign: ["text"],
  };
  if (!(allowedForType[o.type] ?? []).includes(name)) throw new OpError(`A ${o.type} has no '${name}' setting`);
  rec[name] = value;
}

function inferPin(registry: NodeRegistry, graph: RuleGraph, nodeId: string, pin: string, side: "in" | "out"): string {
  if (parseHandle(pin)) return pin;
  const node = graph.nodes.find((n) => n.id === nodeId);
  const spec = node && registry.get(node.type);
  if (!spec) throw new OpError(`Node '${nodeId}' does not exist in this graph`);
  const pins = side === "out" ? spec.outputs : spec.inputs;
  const match = pins.find((p) => p.id === pin);
  if (!match) throw new OpError(`${spec.title} has no ${side === "out" ? "output" : "input"} called '${pin}'`);
  return handleId(match.kind, match.id);
}

/** The exact animation name in a model for `wanted` (ignoring case and punctuation), when the model's animations are known. */
function checkClip(docs: ProjectDocs, asset: string, wanted: string): string {
  const clips = docs.assets?.clips?.[asset];
  if (!clips) return wanted;
  const plain = (n: string) => n.toLowerCase().replace(/[^a-z0-9]/g, "");
  const hit = clips.find((c) => c === wanted) ?? clips.find((c) => plain(c) === plain(wanted));
  if (!hit) throw new OpError(`${asset} has no animation '${wanted}'. Its animations: ${clips.join(", ") || "none"}`);
  return hit;
}

function checkModel(docs: ProjectDocs, asset: string): void {
  if (!docs.assets) throw new OpError("Imported models and characters are used in Godot projects; this project's engine sets them up in its own editor");
  if (!docs.assets.models.includes(asset)) throw new OpError(`There is no model '${asset}'. Models: ${docs.assets.models.join(", ") || "none (import one in Assets, or add a character from the free library)"}`);
}

type Audio = { music?: { asset: string; volume: number }; sounds?: Partial<Record<string, string>> };

/** A level's sound settings after one change: music, its volume (0 to 1, or a percentage), or a sound's file ('' for built-in). */
function changeAudio(docs: ProjectDocs, audio: Audio | undefined, name: string, value: unknown): Audio | undefined {
  const next: Audio = { ...(audio ?? {}), ...(audio?.sounds ? { sounds: { ...audio.sounds } } : {}) };
  const checkFile = (v: unknown): string => {
    if (typeof v !== "string") throw new OpError(`${name} needs a sound file, or '' for none`);
    if (v === "") return v;
    if (!docs.assets) throw new OpError("Imported sounds play in Godot projects");
    if (!(docs.assets.audio ?? []).includes(v)) throw new OpError(`There is no sound file '${v}'. Sound files: ${(docs.assets.audio ?? []).join(", ") || "none (import some, or add free ones from the library's Sounds, in Assets)"}`);
    return v;
  };
  if (name === "music") {
    const f = checkFile(value);
    if (f) next.music = { asset: f, volume: next.music?.volume ?? 0.6 };
    else delete next.music;
  } else if (name === "musicVolume") {
    const raw = coerceToKind("number", value);
    if (typeof raw !== "number") throw new OpError("musicVolume needs a number from 0 to 1");
    const v = raw > 1 ? raw / 100 : raw;
    if (!next.music) throw new OpError("Choose the music first");
    next.music = { ...next.music, volume: Math.min(1, Math.max(0, v)) };
  } else {
    const f = checkFile(value);
    const sounds = { ...(next.sounds ?? {}) };
    if (f) sounds[name] = f;
    else delete sounds[name];
    next.sounds = sounds;
  }
  if (next.sounds && Object.keys(next.sounds).length === 0) delete next.sounds;
  return next.music || next.sounds ? next : undefined;
}

/** Apply a proposal to copies of the documents. Nothing is written; callers decide after review. */
export function applyProposal(input: ProjectDocs, proposal: Proposal, registry: NodeRegistry, opts: { allowed: OperationKind[]; author: string }): ApplyResult {
  const docs: ProjectDocs = structuredClone(input);
  const changes: ChangeLine[] = [];
  const errors: { op: number; message: string }[] = [];
  const touched = new Set<string>();
  let edgeCounter = 0;

  const world = () => docs.world ?? (() => { throw new OpError("This project has no world layout"); })();
  const graphOf = (id: string) => docs.rules[id] ?? (() => { throw new OpError(`There is no rule graph '${id}'. Graphs: ${Object.keys(docs.rules).join(", ") || "none"}`); })();
  const catalog = () => docs.catalog ?? (() => { throw new OpError("This project has no creature catalog"); })();
  const level = () => docs.level ?? (() => { throw new OpError("This project has no platformer level"); })();
  const matchDoc = () => docs.match ?? (() => { throw new OpError("This project has no football match"); })();
  const farmDoc = () => docs.farm ?? (() => { throw new OpError("This project has no farm"); })();
  const levelObject = (id: string) => level().level.objects.find((o) => o.id === id) ?? (() => { throw new OpError(`No object '${id}' in the level. Use level.add to create a new one.`); })();
  const objectOf = (id: string) => world().world.objects.find((o) => o.id === id) ?? (() => { throw new OpError(`No object '${id}' in the world. Existing objects can be moved, changed or removed; use world.add to create a new one.`); })();

  proposal.operations.forEach((op: Operation, i: number) => {
    try {
      if (!opts.allowed.includes(op.op)) throw new OpError(`This assistant is not allowed to use '${op.op}'`);
      switch (op.op) {
        case "world.add": {
          const w = world();
          if (w.world.objects.some((o) => o.id === op.id)) throw new OpError(`An object called '${op.id}' already exists`);
          if (!/^[a-z][a-z0-9_]{0,47}$/.test(op.id)) throw new OpError(`'${op.id}' is not a valid object id (lowercase letters, digits, underscores)`);
          const obj = OBJECT_DEFAULTS[op.objectType](op.id, op.x, op.z);
          if ((obj.type === "enemy" || obj.type === "crate") && docs.manifest.engine.id !== "godot") {
            throw new OpError(`${obj.type === "enemy" ? "Enemies" : "Pushable blocks"} work in Godot projects only; this project's game cannot use them`);
          }
          for (const a of op.attributes) setWorldField(obj, a.name, a.value);
          if (obj.type === "model") {
            if (!docs.assets) throw new OpError("Imported models are placed in Godot projects; this project's engine imports models in its own editor");
            if (!obj.asset) throw new OpError(`A model needs an 'asset' attribute. Models: ${docs.assets?.models.join(", ") || "none (import one in Assets)"}`);
            if (docs.assets && !docs.assets.models.includes(obj.asset)) throw new OpError(`There is no model '${obj.asset}'. Models: ${docs.assets.models.join(", ") || "none (import one in Assets)"}`);
          }
          w.world.objects.push(obj);
          touched.add(w.path);
          changes.push({ doc: w.path, op: i, text: `Add ${op.objectType} '${op.id}' at (${fmt(op.x)}, ${fmt(op.z)})` });
          break;
        }
        case "world.move": {
          const o = objectOf(op.id);
          const from = `(${fmt(o.x)}, ${fmt(o.z)})`;
          o.x = op.x;
          o.z = op.z;
          touched.add(world().path);
          changes.push({ doc: world().path, op: i, text: `Move '${op.id}' from ${from} to (${fmt(op.x)}, ${fmt(op.z)})` });
          break;
        }
        case "world.remove": {
          const w = world();
          objectOf(op.id);
          w.world.objects = w.world.objects.filter((o) => o.id !== op.id);
          touched.add(w.path);
          changes.push({ doc: w.path, op: i, text: `Remove '${op.id}'` });
          break;
        }
        case "world.set": {
          const o = objectOf(op.id);
          if (op.name === "persona" || op.name === "knows") {
            if (o.type !== "npc") throw new OpError(`Only villagers (npc) answer players with AI; '${op.id}' is a ${o.type}`);
            if (typeof op.value !== "string") throw new OpError(`${op.name} needs text ('' for none)`);
            const ai = { persona: o.ai?.persona ?? "", knows: o.ai?.knows ?? "", [op.name]: op.value.trim() };
            const before = o.ai?.[op.name] ?? "";
            if (!ai.persona && !ai.knows) delete o.ai;
            else o.ai = ai;
            touched.add(world().path);
            changes.push({ doc: world().path, op: i, text: `'${op.id}' ${op.name === "persona" ? "AI persona" : "AI knowledge"}: ${JSON.stringify(before)} → ${JSON.stringify(op.value.trim())}` });
            break;
          }
          const before = (o as unknown as Record<string, unknown>)[op.name];
          if (op.name === "texture" || op.name === "textureTile" || op.name === "tint") {
            if (!(TEXTURED_TYPES as readonly string[]).includes(o.type)) throw new OpError(`A ${o.type} cannot take a texture (only ${TEXTURED_TYPES.join(", ")})`);
            const rec = o as unknown as { material?: ObjectMaterial };
            const before = rec.material;
            if (op.name === "texture") {
              if (typeof op.value !== "string") throw new OpError("texture needs a texture file, or '' for plain colours");
              if (op.value === "") delete rec.material;
              else {
                if (!docs.assets) throw new OpError("Textures on objects are used in Godot projects");
                if (!docs.assets.textures.includes(op.value)) throw new OpError(`There is no texture '${op.value}'. Textures: ${docs.assets.textures.join(", ") || "none (import one, or get one from the free library, in Assets)"}`);
                rec.material = { albedo: op.value, ...matchingMaps(op.value, docs.assets.textures), tile: before?.tile ?? 1, tint: before?.tint ?? false };
              }
            } else {
              if (!rec.material) throw new OpError(`Give '${op.id}' a texture first`);
              const v = coerceToKind(op.name === "tint" ? "boolean" : "number", op.value);
              if (op.name === "tint" ? typeof v !== "boolean" : typeof v !== "number") throw new OpError(`${op.name} needs ${op.name === "tint" ? "true or false" : "a number of metres"}`);
              rec.material = op.name === "tint" ? { ...rec.material, tint: v as boolean } : { ...rec.material, tile: v as number };
            }
            touched.add(world().path);
            changes.push({ doc: world().path, op: i, text: op.name === "texture" ? `Texture on '${op.id}': ${before?.albedo ?? "none"} → ${rec.material?.albedo ?? "none"}` : `'${op.id}' texture ${op.name === "tint" ? "keeps its colours" : "repeats every"}: ${JSON.stringify(op.name === "tint" ? before?.tint : before?.tile)} → ${JSON.stringify(op.name === "tint" ? rec.material!.tint : rec.material!.tile)}` });
            break;
          }
          if (op.name === "model" && op.value === "") {
            const rec = o as unknown as Record<string, unknown>;
            delete rec["model"];
            delete rec["animation"];
            delete rec["height"];
          } else {
            setWorldField(o, op.name, op.value);
          }
          if (op.name === "asset" && docs.assets && !docs.assets.models.includes(String(op.value))) throw new OpError(`There is no model '${String(op.value)}'`);
          if (op.name === "model" && op.value !== "") checkModel(docs, String(op.value));
          if (op.name === "animation") {
            const file = o.type === "npc" ? o.model : o.type === "model" ? o.asset : undefined;
            if (!file) throw new OpError(`Give '${op.id}' a model before an animation`);
            (o as unknown as Record<string, unknown>)["animation"] = checkClip(docs, file, String(op.value));
          }
          touched.add(world().path);
          changes.push({ doc: world().path, op: i, text: `Set '${op.id}' ${op.name}: ${JSON.stringify(before)} → ${JSON.stringify(op.value)}` });
          break;
        }
        case "world.environment": {
          const env = world().world.environment as unknown as Record<string, unknown>;
          const isColor = ["skyTop", "skyHorizon", "ground", "sunColor"].includes(op.name);
          if ((GODOT_ONLY_ENVIRONMENT as readonly string[]).includes(op.name) && !docs.assets) throw new OpError(`${op.name} is drawn by the Godot game only; this project's engine sets its look in its own editor`);
          if (op.name === "skyImage") {
            if (typeof op.value !== "string") throw new OpError("skyImage needs a sky file, or an empty string for the sky colours and clouds");
            const skies = docs.assets?.skies ?? [];
            if (op.value && !skies.includes(op.value)) throw new OpError(`There is no sky '${op.value}'. Skies: ${skies.join(", ") || "none (get one in Assets, Free library, Skies)"}`);
            const before = env["skyImage"] ?? "colours and clouds";
            if (op.value) env["skyImage"] = op.value;
            else delete env["skyImage"];
            touched.add(world().path);
            changes.push({ doc: world().path, op: i, text: `Sky: ${String(before)} → ${op.value || "colours and clouds"}` });
            break;
          }
          if (op.name === "style") {
            if (op.value !== "standard" && op.value !== "anime" && op.value !== "realistic") throw new OpError("style is 'standard', 'anime' or 'realistic'");
            const before = env["style"] ?? "standard";
            env["style"] = op.value;
            touched.add(world().path);
            changes.push({ doc: world().path, op: i, text: `Style: ${String(before)} → ${op.value}` });
            break;
          }
          if (op.name === "quality") {
            if (op.value !== "standard" && op.value !== "high") throw new OpError("quality is 'standard' or 'high'");
            const before = env["quality"] ?? "standard";
            env["quality"] = op.value;
            touched.add(world().path);
            changes.push({ doc: world().path, op: i, text: `Render quality: ${String(before)} → ${op.value}` });
            break;
          }
          if (op.name === "groundTexture") {
            if (!docs.assets) throw new OpError("Ground textures are set in Godot projects; this project's engine sets materials in its own editor");
            if (typeof op.value !== "string") throw new OpError("groundTexture needs a texture path, or an empty string for none");
            if (op.value && docs.assets && !docs.assets.textures.includes(op.value)) throw new OpError(`There is no texture '${op.value}'. Textures: ${docs.assets.textures.join(", ") || "none (import one in Assets)"}`);
            const before = (env["groundMaterial"] as { albedo?: string } | undefined)?.albedo ?? "none";
            if (op.value) env["groundMaterial"] = { albedo: op.value, tile: 4 };
            else delete env["groundMaterial"];
            touched.add(world().path);
            changes.push({ doc: world().path, op: i, text: `Ground texture: ${before} → ${op.value || "none"}` });
            break;
          }
          if (isColor ? typeof op.value !== "string" : typeof op.value !== "number") throw new OpError(`${op.name} needs ${isColor ? "a #rrggbb colour" : "a number"}`);
          const before = env[op.name];
          env[op.name] = op.value;
          touched.add(world().path);
          changes.push({ doc: world().path, op: i, text: `Environment ${op.name}: ${JSON.stringify(before)} → ${JSON.stringify(op.value)}` });
          break;
        }
        case "farm.set": {
          const f = farmDoc();
          const farm = f.farm;
          let before: unknown;
          if (op.name === "width" || op.name === "height") {
            const v = coerceToKind("number", op.value);
            if (typeof v !== "number") throw new OpError(`${op.name} needs a whole number of tiles`);
            before = farm.map[op.name];
            f.farm = resizeMap(farm, op.name === "width" ? Math.round(v) : farm.map.width, op.name === "height" ? Math.round(v) : farm.map.height);
          } else if (op.name === "spawnX" || op.name === "spawnY") {
            const v = coerceToKind("number", op.value);
            if (typeof v !== "number") throw new OpError(`${op.name} needs a tile number`);
            const key = op.name === "spawnX" ? "x" : "y";
            before = farm.map.spawn[key];
            farm.map.spawn[key] = Math.round(v);
          } else if (op.name === "farmerName" || op.name === "shirt") {
            if (typeof op.value !== "string" || !op.value.trim()) throw new OpError(`${op.name} needs text`);
            const key = op.name === "farmerName" ? "name" : "shirt";
            before = farm.farmer[key];
            farm.farmer[key] = op.value.trim();
          } else if (op.name === "name" || op.name === "currency") {
            if (typeof op.value !== "string" || !op.value.trim()) throw new OpError(`${op.name} needs text`);
            before = farm[op.name];
            farm[op.name] = op.value.trim();
          } else {
            const v = coerceToKind("number", op.value);
            if (typeof v !== "number") throw new OpError(`${op.name} needs a number`);
            before = farm[op.name];
            farm[op.name] = op.name === "startMoney" ? Math.round(v) : v;
          }
          touched.add(f.path);
          changes.push({ doc: f.path, op: i, text: `Farm ${op.name}: ${JSON.stringify(before)} → ${JSON.stringify(op.value)}` });
          break;
        }
        case "farm.crop": {
          const f = farmDoc();
          const crop = f.farm.crops.find((c) => c.id === op.crop);
          if (!crop) throw new OpError(`There is no crop '${op.crop}'. Crops: ${f.farm.crops.map((c) => c.id).join(", ")} (farm.addCrop adds one)`);
          const before = crop[op.name];
          if (op.name === "name" || op.name === "color") {
            if (typeof op.value !== "string" || !op.value.trim()) throw new OpError(`${op.name} needs text`);
            crop[op.name] = op.value.trim();
          } else if (op.name === "needsWater") {
            const v = coerceToKind("boolean", op.value);
            if (typeof v !== "boolean") throw new OpError("needsWater needs true or false");
            crop.needsWater = v;
          } else {
            const v = coerceToKind("number", op.value);
            if (typeof v !== "number") throw new OpError(`${op.name} needs a whole number`);
            crop[op.name] = Math.round(v);
          }
          touched.add(f.path);
          changes.push({ doc: f.path, op: i, text: `${crop.name} ${op.name}: ${JSON.stringify(before)} → ${JSON.stringify(crop[op.name])}` });
          break;
        }
        case "farm.addCrop": {
          const f = farmDoc();
          if (f.farm.crops.some((c) => c.id === op.crop)) throw new OpError(`A crop called '${op.crop}' already exists`);
          if (!/^[a-z][a-z0-9_]{0,23}$/.test(op.crop)) throw new OpError(`'${op.crop}' is not a valid crop id (lowercase letters, digits, underscores)`);
          f.farm.crops.push({ id: op.crop, name: op.name.trim() || op.crop, seedCost: 5, days: 3, yield: 2, price: 6, color: "#8bc34a", needsWater: true, regrow: 0 });
          touched.add(f.path);
          changes.push({ doc: f.path, op: i, text: `Add crop '${op.crop}' (${op.name})` });
          break;
        }
        case "farm.removeCrop": {
          const f = farmDoc();
          if (!f.farm.crops.some((c) => c.id === op.crop)) throw new OpError(`There is no crop '${op.crop}'`);
          if (f.farm.crops.length <= 1) throw new OpError("A farm needs at least one crop");
          f.farm.crops = f.farm.crops.filter((c) => c.id !== op.crop);
          touched.add(f.path);
          changes.push({ doc: f.path, op: i, text: `Remove crop '${op.crop}'` });
          break;
        }
        case "farm.fill": {
          const f = farmDoc();
          const { width, height } = f.farm.map;
          if (op.width < 1 || op.height < 1) throw new OpError("width and height are at least 1 tile");
          if (op.x < 0 || op.y < 0 || op.x + op.width > width || op.y + op.height > height) throw new OpError(`The rectangle (${op.x}, ${op.y}) ${op.width} by ${op.height} leaves the ${width} by ${height} map`);
          const letter = (Object.keys(TILES) as TileLetter[]).find((k) => TILES[k] === op.tile)!;
          let next = f.farm;
          for (let y = op.y; y < op.y + op.height; y++) for (let x = op.x; x < op.x + op.width; x++) next = paintTile(next, x, y, letter);
          f.farm = next;
          touched.add(f.path);
          changes.push({ doc: f.path, op: i, text: `Paint ${op.tile} from (${op.x}, ${op.y}), ${op.width} by ${op.height} tiles` });
          break;
        }
        case "match.set": {
          const m = matchDoc();
          const settings = m.match;
          const pitchKey = { pitchLength: "length", pitchWidth: "width", goalWidth: "goalWidth", grass: "grass", lines: "lines", stripes: "stripes" } as const;
          let before: unknown;
          if (op.name === "name") {
            if (typeof op.value !== "string" || !op.value.trim()) throw new OpError("name needs text");
            before = settings.name;
            settings.name = op.value.trim();
          } else if (op.name === "difficulty") {
            if (typeof op.value !== "string" || !(DIFFICULTIES as readonly string[]).includes(op.value)) throw new OpError(`difficulty is one of ${DIFFICULTIES.join(", ")}`);
            before = settings.difficulty;
            settings.difficulty = op.value as Match["difficulty"];
          } else if (op.name === "control") {
            if (typeof op.value !== "string" || !(CONTROLS as readonly string[]).includes(op.value)) throw new OpError(`control is one of ${CONTROLS.join(", ")} ('none' watches the computer play both sides)`);
            before = settings.control;
            settings.control = op.value as Match["control"];
          } else if (op.name === "teamSize" || op.name === "minutes") {
            const v = coerceToKind("number", op.value);
            if (typeof v !== "number") throw new OpError(`${op.name} needs a number`);
            before = settings[op.name];
            settings[op.name] = op.name === "teamSize" ? Math.round(v) : v;
          } else {
            const key = pitchKey[op.name];
            const v = key === "stripes" ? coerceToKind("boolean", op.value) : key === "grass" || key === "lines" ? op.value : coerceToKind("number", op.value);
            if (key === "stripes" ? typeof v !== "boolean" : key === "grass" || key === "lines" ? typeof v !== "string" : typeof v !== "number") throw new OpError(`${op.name} needs ${key === "stripes" ? "true or false" : key === "grass" || key === "lines" ? "a #rrggbb colour" : "a number of metres"}`);
            before = settings.pitch[key];
            (settings.pitch as Record<string, unknown>)[key] = v;
          }
          touched.add(m.path);
          changes.push({ doc: m.path, op: i, text: `Match ${op.name}: ${JSON.stringify(before)} → ${JSON.stringify(op.value)}` });
          break;
        }
        case "match.team": {
          const m = matchDoc();
          const team = m.match[op.team];
          const before = team[op.name];
          (team as Record<string, unknown>)[op.name] = op.name === "short" ? op.value.trim().toUpperCase() : op.value.trim();
          touched.add(m.path);
          changes.push({ doc: m.path, op: i, text: `${op.team === "home" ? "Home" : "Away"} team ${op.name}: ${JSON.stringify(before)} → ${JSON.stringify(op.value)}` });
          break;
        }
        case "match.player": {
          const m = matchDoc();
          const team = m.match[op.team];
          if (op.slot < 1 || op.slot > SQUAD_SIZE) throw new OpError(`slot is 1 to ${SQUAD_SIZE} (1 keeps goal)`);
          const player = team.players[op.slot - 1]!;
          const before = player[op.name];
          if (op.name === "name") {
            if (typeof op.value !== "string" || !op.value.trim()) throw new OpError("A player's name needs text");
            player.name = op.value.trim();
          } else {
            const v = coerceToKind("number", op.value);
            if (typeof v !== "number") throw new OpError(`${op.name} needs a whole number`);
            player[op.name] = Math.round(v);
          }
          touched.add(m.path);
          changes.push({ doc: m.path, op: i, text: `${team.name} player ${op.slot} (${player.name}) ${op.name}: ${JSON.stringify(before)} → ${JSON.stringify(player[op.name])}` });
          break;
        }
        case "world.player": {
          const p = world().world.player;
          if (op.name === "health" && docs.manifest.engine.id !== "godot") throw new OpError("Hearts are used in Godot projects only; this project's game has no health");
          if (op.name === "spawnX" || op.name === "spawnZ") {
            const key = op.name === "spawnX" ? "x" : "z";
            const before = p.spawn[key];
            p.spawn[key] = op.value;
            changes.push({ doc: world().path, op: i, text: `Player spawn ${key}: ${fmt(before)} → ${fmt(op.value)}` });
          } else {
            const rec = p as unknown as Record<string, number>;
            const before = rec[op.name];
            rec[op.name] = op.value;
            changes.push({ doc: world().path, op: i, text: `Player ${op.name}: ${fmt(before ?? 0)} → ${fmt(op.value)}` });
          }
          touched.add(world().path);
          break;
        }
        case "level.add": {
          const l = level();
          if (l.level.objects.some((o) => o.id === op.id)) throw new OpError(`An object called '${op.id}' already exists`);
          if (!/^[a-z][a-z0-9_]{0,47}$/.test(op.id)) throw new OpError(`'${op.id}' is not a valid object id (lowercase letters, digits, underscores)`);
          const obj = LEVEL_OBJECT_DEFAULTS[op.objectType](op.id, op.x, op.y);
          for (const a of op.attributes) setLevelField(obj, a.name, a.value, docs.assets?.textures);
          l.level.objects.push(obj);
          touched.add(l.path);
          changes.push({ doc: l.path, op: i, text: `Add ${op.objectType} '${op.id}' at (${fmt(op.x)}, ${fmt(op.y)})` });
          break;
        }
        case "level.move": {
          const o = levelObject(op.id);
          const from = `(${fmt(o.x)}, ${fmt(o.y)})`;
          o.x = op.x;
          o.y = op.y;
          touched.add(level().path);
          changes.push({ doc: level().path, op: i, text: `Move '${op.id}' from ${from} to (${fmt(op.x)}, ${fmt(op.y)})` });
          break;
        }
        case "level.remove": {
          const l = level();
          levelObject(op.id);
          l.level.objects = l.level.objects.filter((o) => o.id !== op.id);
          touched.add(l.path);
          changes.push({ doc: l.path, op: i, text: `Remove '${op.id}'` });
          break;
        }
        case "level.set": {
          const o = levelObject(op.id);
          const before = (o as unknown as Record<string, unknown>)[op.name];
          setLevelField(o, op.name, op.value, docs.assets?.textures);
          touched.add(level().path);
          changes.push({ doc: level().path, op: i, text: `Set '${op.id}' ${op.name}: ${JSON.stringify(before)} → ${JSON.stringify(op.value)}` });
          break;
        }
        case "level.settings": {
          const l = level().level;
          const colour = ["skyTop", "skyBottom", "hills"].includes(op.name);
          const value = op.name === "name" || colour ? op.value : coerceToKind("number", op.value);
          if (op.name === "name" ? typeof value !== "string" : colour ? typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value) : typeof value !== "number") {
            throw new OpError(`${op.name} needs ${op.name === "name" ? "text" : colour ? "a #rrggbb colour" : "a number"}`);
          }
          let before: unknown;
          if (op.name === "name") [before, l.name] = [l.name, value as string];
          else if (op.name === "width" || op.name === "height") [before, l.size[op.name]] = [l.size[op.name], value as number];
          else if (op.name === "spawnX") [before, l.player.spawn.x] = [l.player.spawn.x, value as number];
          else if (op.name === "spawnY") [before, l.player.spawn.y] = [l.player.spawn.y, value as number];
          else if (colour) {
            const k = op.name as "skyTop" | "skyBottom" | "hills";
            [before, l.background[k]] = [l.background[k], value as string];
          } else {
            const k = op.name as "speed" | "jumpHeight" | "gravity";
            [before, l.player[k]] = [l.player[k], value as number];
          }
          touched.add(level().path);
          changes.push({ doc: level().path, op: i, text: `Level ${op.name}: ${JSON.stringify(before)} → ${JSON.stringify(value)}` });
          break;
        }
        case "world.character": {
          const p = world().world.player;
          const before = p.character ? { ...p.character } : undefined;
          if (op.name === "asset") {
            if (typeof op.value !== "string") throw new OpError("asset needs a model path, or an empty string for the capsule");
            if (op.value === "") {
              delete (p as { character?: unknown }).character;
            } else {
              checkModel(docs, op.value);
              p.character = { ...(p.character ?? { height: 1.8, turn: 180 }), asset: op.value };
            }
          } else {
            if (!p.character) throw new OpError("Choose the character's model first (world.character asset)");
            if (op.name === "height" || op.name === "turn") {
              const v = coerceToKind("number", op.value);
              if (typeof v !== "number") throw new OpError(`${op.name} needs a number`);
              p.character[op.name] = v;
            } else {
              if (typeof op.value !== "string") throw new OpError(`${op.name} needs an animation name`);
              if (op.value === "") delete p.character[op.name];
              else p.character[op.name] = checkClip(docs, p.character.asset, op.value);
            }
          }
          touched.add(world().path);
          const after = p.character;
          changes.push({ doc: world().path, op: i, text: op.name === "asset" ? `Player character: ${before?.asset ?? "capsule"} → ${after?.asset ?? "capsule"}` : `Player character ${op.name}: ${JSON.stringify(before?.[op.name] ?? null)} → ${JSON.stringify(after?.[op.name] ?? null)}` });
          break;
        }
        case "level.sprite": {
          const p = level().level.player;
          const before = p.sprite ? { ...p.sprite } : undefined;
          if (op.name === "asset") {
            if (typeof op.value !== "string") throw new OpError("asset needs a sprite sheet path, or an empty string for the drawn runner");
            if (op.value === "") delete (p as { sprite?: unknown }).sprite;
            else {
              if (!docs.assets) throw new OpError("Sprite sheets are used in Godot projects");
              if (!docs.assets.textures.includes(op.value) || !/\.(png|webp)$/i.test(op.value)) throw new OpError(`There is no sprite sheet '${op.value}'. Pictures: ${docs.assets.textures.filter((t) => /\.(png|webp)$/i.test(t)).join(", ") || "none (import one in Assets)"}`);
              p.sprite = { ...(p.sprite ?? { columns: 4, rows: 1, idle: [0], run: [], jump: [], fps: 10, height: 1.5, facing: "right", pixelArt: true }), asset: op.value };
            }
          } else {
            if (!p.sprite) throw new OpError("Choose the sprite sheet first (level.sprite asset)");
            if (op.name === "idle" || op.name === "run" || op.name === "jump") {
              const v = coerceToKind("numberList", op.value);
              if (!Array.isArray(v) || !v.every((n) => Number.isInteger(n) && n >= 0)) throw new OpError(`${op.name} needs a list of frame numbers`);
              p.sprite[op.name] = v as number[];
            } else if (op.name === "facing") {
              if (op.value !== "left" && op.value !== "right") throw new OpError("facing is 'left' or 'right'");
              p.sprite.facing = op.value;
            } else {
              const v = coerceToKind("number", op.value);
              if (typeof v !== "number") throw new OpError(`${op.name} needs a number`);
              p.sprite[op.name] = v;
            }
          }
          touched.add(level().path);
          changes.push({ doc: level().path, op: i, text: op.name === "asset" ? `Player sprite: ${before?.asset ?? "drawn runner"} → ${p.sprite?.asset ?? "drawn runner"}` : `Player sprite ${op.name}: ${JSON.stringify(before?.[op.name] ?? null)} → ${JSON.stringify(p.sprite?.[op.name] ?? null)}` });
          break;
        }
        case "world.audio":
        case "level.audio": {
          const holder = (op.op === "world.audio" ? world().world : level().level) as { audio?: Audio };
          const path = op.op === "world.audio" ? world().path : level().path;
          const before = holder.audio?.[op.name === "music" || op.name === "musicVolume" ? "music" : "sounds"];
          const next = changeAudio(docs, holder.audio, op.name, op.value);
          if (next) holder.audio = next;
          else delete holder.audio;
          touched.add(path);
          const describe = (v: unknown) => (v === undefined ? "built-in" : JSON.stringify(v));
          changes.push({ doc: path, op: i, text: op.name === "music" ? `Music: ${(before as Audio["music"])?.asset ?? "none"} → ${next?.music?.asset ?? "none"}` : op.name === "musicVolume" ? `Music volume: ${Math.round(((before as Audio["music"])?.volume ?? 0) * 100)}% → ${Math.round((next?.music?.volume ?? 0) * 100)}%` : `${op.name} sound: ${describe((before as Audio["sounds"])?.[op.name])} → ${describe(next?.sounds?.[op.name])}` });
          break;
        }
        case "rules.addNode": {
          const g = graphOf(op.graph);
          if (g.graph.nodes.some((n) => n.id === op.id)) throw new OpError(`A node called '${op.id}' already exists`);
          const spec = registry.get(op.type);
          if (!spec) throw new OpError(`Unknown node type '${op.type}'`);
          const kindOf = (name: string) => spec.params.find((p) => p.id === name)?.kind ?? "";
          g.graph.nodes.push({ id: op.id, type: op.type, position: { x: op.x, y: op.y }, params: Object.fromEntries(op.params.map((p) => [p.name, coerceToKind(kindOf(p.name), p.value)])) });
          touched.add(g.path);
          changes.push({ doc: g.path, op: i, text: `Add node '${spec.title}' (${op.id})` });
          break;
        }
        case "rules.removeNode": {
          const g = graphOf(op.graph);
          const node = g.graph.nodes.find((n) => n.id === op.id) ?? (() => { throw new OpError(`No node '${op.id}'`); })();
          g.graph.nodes = g.graph.nodes.filter((n) => n.id !== op.id);
          const before = g.graph.edges.length;
          g.graph.edges = g.graph.edges.filter((e) => e.source !== op.id && e.target !== op.id);
          touched.add(g.path);
          changes.push({ doc: g.path, op: i, text: `Remove node '${registry.get(node.type)?.title ?? node.type}' (${op.id}) and ${before - g.graph.edges.length} connection(s)` });
          break;
        }
        case "rules.setParam": {
          const g = graphOf(op.graph);
          const node = g.graph.nodes.find((n) => n.id === op.node) ?? (() => { throw new OpError(`No node '${op.node}'`); })();
          const spec = registry.get(node.type);
          const param = spec?.params.find((p) => p.id === op.name);
          if (!param) throw new OpError(`${spec?.title ?? node.type} has no setting '${op.name}'`);
          const before = node.params[op.name] ?? param.default;
          const value = coerceToKind(param.kind, op.value);
          node.params[op.name] = value;
          touched.add(g.path);
          changes.push({ doc: g.path, op: i, text: `${spec!.title} (${op.node}) › ${param.label}: ${JSON.stringify(before)} → ${JSON.stringify(value)}` });
          break;
        }
        case "rules.connect": {
          const g = graphOf(op.graph);
          const sourceHandle = inferPin(registry, g.graph, op.from, op.fromPin, "out");
          const targetHandle = inferPin(registry, g.graph, op.to, op.toPin, "in");
          let edgeId = `ai-${++edgeCounter}`;
          while (g.graph.edges.some((e) => e.id === edgeId)) edgeId = `ai-${++edgeCounter}`;
          g.graph.edges.push({ id: edgeId, source: op.from, sourceHandle, target: op.to, targetHandle });
          touched.add(g.path);
          changes.push({ doc: g.path, op: i, text: `Connect ${op.from}.${sourceHandle} → ${op.to}.${targetHandle}` });
          break;
        }
        case "rules.disconnect": {
          const g = graphOf(op.graph);
          const sh = inferPin(registry, g.graph, op.from, op.fromPin, "out");
          const th = inferPin(registry, g.graph, op.to, op.toPin, "in");
          const before = g.graph.edges.length;
          g.graph.edges = g.graph.edges.filter((e) => !(e.source === op.from && e.sourceHandle === sh && e.target === op.to && e.targetHandle === th));
          if (g.graph.edges.length === before) throw new OpError(`There is no connection ${op.from}.${sh} → ${op.to}.${th}`);
          touched.add(g.path);
          changes.push({ doc: g.path, op: i, text: `Disconnect ${op.from}.${sh} → ${op.to}.${th}` });
          break;
        }
        case "rules.addVariable": {
          const g = graphOf(op.graph);
          if (g.graph.variables.some((v) => v.name === op.name)) throw new OpError(`Variable '${op.name}' already exists`);
          g.graph.variables.push({ name: op.name, type: op.type, initial: op.initial });
          touched.add(g.path);
          changes.push({ doc: g.path, op: i, text: `Add ${op.type} variable '${op.name}' = ${JSON.stringify(op.initial)}` });
          break;
        }
        case "creatures.add": {
          const c = catalog();
          if (c.catalog.creatures.some((x) => x.id === op.id)) throw new OpError(`A creature called '${op.id}' already exists`);
          c.catalog.creatures.push({
            id: op.id,
            name: op.name,
            element: op.element,
            description: op.description,
            stats: { hp: op.hp, attack: op.attack, defense: op.defense, speed: op.speed },
            moves: op.moves,
            provenance: { origin: "original", author: opts.author, license: "Project content", notes: "Proposed by an AI assistant and approved in Game Studio. Check it is original before publishing." },
          });
          touched.add(c.path);
          changes.push({ doc: c.path, op: i, text: `Add creature '${op.name}' (${op.element}) with ${op.moves.length} move(s)` });
          break;
        }
        case "creatures.set": {
          const c = catalog();
          const creature = c.catalog.creatures.find((x) => x.id === op.id) ?? (() => { throw new OpError(`No creature '${op.id}'`); })();
          if (["hp", "attack", "defense", "speed"].includes(op.name)) {
            if (typeof op.value !== "number") throw new OpError(`${op.name} needs a number`);
            (creature.stats as Record<string, number>)[op.name] = op.value;
          } else {
            if (typeof op.value !== "string") throw new OpError(`${op.name} needs text`);
            (creature as unknown as Record<string, unknown>)[op.name] = op.value;
          }
          touched.add(c.path);
          changes.push({ doc: c.path, op: i, text: `Set ${creature.name} ${op.name} → ${JSON.stringify(op.value)}` });
          break;
        }
        case "lesson.addQuestion": {
          const l = docs.lessons[op.lesson] ?? (() => { throw new OpError(`No lesson '${op.lesson}'`); })();
          if (l.lesson.questions.some((q) => q.id === op.id)) throw new OpError(`Question '${op.id}' already exists`);
          if (op.kind === "single") {
            l.lesson.questions.push({ id: op.id, kind: "single", prompt: op.prompt, options: op.options, answer: op.answer, explanation: op.explanation });
          } else {
            l.lesson.questions.push({ id: op.id, kind: "numeric", prompt: op.prompt, answer: op.answer, tolerance: op.tolerance, unit: op.unit, explanation: op.explanation });
          }
          touched.add(l.path);
          changes.push({ doc: l.path, op: i, text: `Add ${op.kind === "single" ? "multiple-choice" : "numeric"} question '${op.id}'` });
          break;
        }
        case "project.describe": {
          docs.manifest = { ...docs.manifest, description: op.description };
          touched.add("gamestudio.json");
          changes.push({ doc: "gamestudio.json", op: i, text: "Update the project description" });
          break;
        }
      }
    } catch (e) {
      if (e instanceof OpError) errors.push({ op: i, message: e.message });
      else throw e;
    }
  });

  const diagnostics: ApplyResult["diagnostics"] = [];
  if (errors.length === 0) {
    for (const { path, graph } of Object.values(docs.rules)) {
      if (!touched.has(path)) continue;
      for (const d of validateGraph(graph, registry).diagnostics) if (d.severity !== "info") diagnostics.push({ doc: path, severity: d.severity, message: d.message });
      for (const d of engineDiagnostics(graph, registry, docs.manifest.engine.id)) diagnostics.push({ doc: path, severity: d.severity, message: d.message });
    }
    if (docs.world && touched.has(docs.world.path)) {
      const r = parseWorld(docs.world.world);
      if (!r.ok) for (const m of r.errors) diagnostics.push({ doc: docs.world.path, severity: "error", message: m });
    }
    if (docs.farm && touched.has(docs.farm.path)) {
      const r = parseFarm(docs.farm.farm);
      if (!r.ok) for (const m of r.errors) diagnostics.push({ doc: docs.farm.path, severity: "error", message: m });
    }
    if (docs.match && touched.has(docs.match.path)) {
      const r = parseMatch(docs.match.match);
      if (!r.ok) for (const m of r.errors) diagnostics.push({ doc: docs.match.path, severity: "error", message: m });
    }
    if (docs.level && touched.has(docs.level.path)) {
      const r = parseLevel(docs.level.level);
      if (!r.ok) for (const m of r.errors) diagnostics.push({ doc: docs.level.path, severity: "error", message: m });
      else for (const m of reachWarnings(r.level)) diagnostics.push({ doc: docs.level.path, severity: "warning", message: m });
    }
    if (docs.catalog && touched.has(docs.catalog.path)) {
      const r = parseCatalog(docs.catalog.catalog);
      if (!r.ok) for (const m of r.errors) diagnostics.push({ doc: docs.catalog.path, severity: "error", message: m });
    }
    for (const l of Object.values(docs.lessons)) {
      if (!touched.has(l.path)) continue;
      const r = parseLesson(l.lesson);
      if (!r.ok) for (const m of r.errors) diagnostics.push({ doc: l.path, severity: "error", message: m });
    }
  }
  const ok = errors.length === 0 && !diagnostics.some((d) => d.severity === "error");
  return { ok, docs, changes, touched: [...touched].sort(), errors, diagnostics };
}

export type DiffEntry = { path: string; kind: "added" | "removed" | "changed"; before?: unknown; after?: unknown };

/** Structural JSON diff for review. Arrays of objects with an `id` are matched by id. */
export function diffJson(before: unknown, after: unknown, path = ""): DiffEntry[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (Array.isArray(before) && Array.isArray(after)) {
    const keyed = [...before, ...after].every((x) => isObj(x) && typeof x["id"] === "string");
    if (keyed) {
      const out: DiffEntry[] = [];
      const b = new Map(before.map((x) => [(x as { id: string }).id, x]));
      const a = new Map(after.map((x) => [(x as { id: string }).id, x]));
      for (const [k, v] of b) if (!a.has(k)) out.push({ path: `${path}[${k}]`, kind: "removed", before: v });
      for (const [k, v] of a) out.push(...(b.has(k) ? diffJson(b.get(k), v, `${path}[${k}]`) : [{ path: `${path}[${k}]`, kind: "added" as const, after: v }]));
      return out;
    }
    return [{ path: path || "/", kind: "changed", before, after }];
  }
  if (isObj(before) && isObj(after)) {
    const out: DiffEntry[] = [];
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const p = `${path}/${k}`;
      if (!(k in after)) out.push({ path: p, kind: "removed", before: before[k] });
      else if (!(k in before)) out.push({ path: p, kind: "added", after: after[k] });
      else out.push(...diffJson(before[k], after[k], p));
    }
    return out;
  }
  return [{ path: path || "/", kind: "changed", before, after }];
}

import {
  BackSide, BoxGeometry, BufferAttribute, BufferGeometry, CapsuleGeometry, Color, CylinderGeometry, DirectionalLight, DoubleSide,
  EquirectangularReflectionMapping, FogExp2, Group, HemisphereLight, InstancedMesh, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, MeshStandardMaterial, PerspectiveCamera,
  Plane, PlaneGeometry, PointLight, Ray, Raycaster, RingGeometry, Scene, ShaderChunk, SphereGeometry, TorusGeometry, Vector2, Vector3, type Material,
} from "three";
import { Restyler, grassMesh, patchGround, skyMaterial, tuftGeometry, updateSky } from "./look";
import { NatureMaterials, natureGroup } from "./nature";
import { AnimationMixer, Box3, type AnimationClip, type Object3D, type Texture } from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { TEXTURED_TYPES, grassKeepOut, guessClips, type Character, type CharacterState, type ObjectMaterial, type World, type WorldObject } from "@gamestudio/explore";
export { bearing, normalizeRotation } from "./angles";

/**
 * The 3D level view's scene, without a renderer, so tests can build and pick it in Node.
 * Shapes, sizes and colours follow templates/exploration-3d/godot/scripts/world_builder.gd:
 * keep the two in step. Coordinates are the world file's: metres, x east, z south, y up.
 */

export const SPAWN_ID = "__spawn";

// Godot's exponential fog is 1 - exp(-density * distance); three.js's FogExp2 squares the exponent.
// Patch three's fog shader once so the fog preview thins out with distance the way the game's does.
const SQUARED_FOG = "1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth )";
if (ShaderChunk.fog_fragment.includes(SQUARED_FOG)) ShaderChunk.fog_fragment = ShaderChunk.fog_fragment.replace(SQUARED_FOG, "1.0 - exp( - fogDensity * vFogDepth )");
const DEG = Math.PI / 180;
/** Height of the turning ring: above water (0.07 m) and zone rings (0.05 m). */
export const RING_Y = 0.12;

export type Hit = { kind: "object"; id: string; point: Vector3; t: number } | { kind: "spawn"; point: Vector3; t: number } | { kind: "ring"; id: string; point: Vector3; t: number };

/** The sun's strength in this view. Godot's sun has energy 1, so the game's light energies are scaled by this. */
export const SUN_INTENSITY = 2.4;
/** The most point lights drawn at once. Godot's web renderer allows 32 on screen; beyond that the nearest win. */
export const MAX_LIGHTS = 32;

/** An object's OmniLight3D in the game: height above the object's base, colour, energy and range in metres. */
export interface Emitter {
  y: number;
  color: string;
  energy: number;
  range: number;
}

/** The light an object gives off in the game (world_builder.gd: _torch and _collectible), or null. */
export function lightOf(o: WorldObject): Emitter | null {
  switch (o.type) {
    case "torch":
      return { y: 2.0, color: "#ffb46b", energy: 1.4, range: 7.0 };
    case "collectible":
      return { y: 1.1, color: "#ffcf73", energy: 0.8, range: 3.5 };
    default:
      return null;
  }
}

/** Where the sun shines from: a unit vector towards it, matching Godot's Sun rotation (-elevation, heading). */
export function sunDirection(elevation: number, heading: number): Vector3 {
  const e = elevation * DEG;
  const h = heading * DEG;
  return new Vector3(Math.cos(e) * Math.sin(h), Math.sin(e), Math.cos(e) * Math.cos(h));
}


/**
 * Half-size and height of each imported model once loaded (asset path → bounds, in the model's units).
 * `spanX` is its full width and `doorWidth` the width of its door pieces (gate models; see doorParts).
 */
export const MODEL_BOUNDS = new Map<string, { halfX: number; halfZ: number; height: number; tall?: number; spanX?: number; doorWidth?: number }>();

/** A loaded model file: its scene and its animations. */
export interface LoadedModel {
  scene: Object3D;
  clips: AnimationClip[];
}

/**
 * A sensible height for a character model from its own size: taken as metres when it is 0.3 to 3
 * units tall, as centimetres when it is 30 to 300 (many exports use centimetres), otherwise 1.8 m.
 */
export function suggestedHeight(tall: number): number {
  const round = (n: number) => Math.round(n * 100) / 100;
  if (tall >= 0.3 && tall <= 3) return round(tall);
  if (tall >= 30 && tall <= 300) return round(tall / 100);
  return 1.8;
}

/**
 * The animation to play: the named one (compared without case or punctuation, as the game does in
 * models.gd), or, with no name, the one whose name suggests `state`.
 */
export function pickClip(names: readonly string[], wanted: string | undefined, state?: CharacterState): string | undefined {
  const plain = (n: string) => n.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (wanted) return names.find((n) => n === wanted) ?? names.find((n) => plain(n) === plain(wanted) || plain(n).endsWith(plain(wanted)));
  return state ? guessClips(names)[state] : undefined;
}

/**
 * Draws a material's colour map projected from the three axes in world space, repeated every `tile`
 * metres, the way Godot's StandardMaterial3D does with uv1_triplanar and uv1_world_triplanar
 * (world_builder.gd: _textured): same blend weights, same flips.
 */
export function triplanar(material: MeshStandardMaterial, tile: number): void {
  const scale = 1 / Math.max(0.1, tile);
  material.onBeforeCompile = (shader) => {
    shader.uniforms["triScale"] = { value: scale };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vTriPos;\nvarying vec3 vTriNormal;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvTriPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvTriNormal = normalize(mat3(modelMatrix) * objectNormal);");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vTriPos;\nvarying vec3 vTriNormal;\nuniform float triScale;")
      .replace(
        "#include <map_fragment>",
        [
          "vec3 triW = abs(normalize(vTriNormal));",
          "triW /= (triW.x + triW.y + triW.z);",
          "vec3 triP = vTriPos * triScale * vec3(1.0, -1.0, 1.0);",
          "vec4 triC = texture2D(map, triP.xy) * triW.z + texture2D(map, triP.xz) * triW.y + texture2D(map, triP.zy * vec2(-1.0, 1.0)) * triW.x;",
          "diffuseColor *= triC;",
        ].join("\n"),
      );
  };
  material.customProgramCacheKey = () => `triplanar|${scale}`;
}

/** Scales `obj` to `height` and stands its lowest point on y = 0, like models.gd's fit_height. */
export function fitHeight(obj: Object3D, height: number): void {
  obj.scale.setScalar(1);
  obj.position.set(0, 0, 0);
  obj.updateMatrixWorld(true);
  const box = new Box3().setFromObject(obj);
  const size = box.max.y - box.min.y;
  if (!(size > 1e-5)) return;
  const k = height / size;
  obj.scale.setScalar(k);
  obj.position.y = -box.min.y * k;
}

/**
 * Scales `obj` evenly so its largest side is `size`, centred over the origin and standing on y = 0: a
 * pushable block's model fills its block, like models.gd's fit_box.
 */
export function fitBox(obj: Object3D, size: number): void {
  obj.scale.setScalar(1);
  obj.position.set(0, 0, 0);
  obj.updateMatrixWorld(true);
  const box = new Box3().setFromObject(obj);
  if (box.isEmpty()) return;
  const largest = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z);
  if (!(largest > 1e-5)) return;
  const k = size / largest;
  obj.scale.setScalar(k);
  obj.position.set(-((box.min.x + box.max.x) / 2) * k, -box.min.y * k, -((box.min.z + box.max.z) / 2) * k);
}

/** A gate model's door: each outermost part whose name contains "Door" (models.gd: door_parts). */
export function doorParts(obj: Object3D): Object3D[] {
  const out: Object3D[] = [];
  for (const child of obj.children) {
    if (child.name.includes("Door")) out.push(child);
    else out.push(...doorParts(child));
  }
  return out;
}

/** The width of a model's door parts, or undefined when it has none. `obj` must have no transform above it. */
function doorWidthOf(obj: Object3D): number | undefined {
  obj.updateMatrixWorld(true);
  const door = new Box3();
  for (const part of doorParts(obj)) door.union(new Box3().setFromObject(part));
  const w = door.isEmpty() ? 0 : door.max.x - door.min.x;
  return w > 1e-5 ? w : undefined;
}

/**
 * Scales a gate model evenly so its door is `width` wide (without a door: so the whole gate is
 * `width` + 1.8 wide, the built-in gate's size) and stands it on y = 0, like models.gd's fit_gate.
 */
export function fitGate(obj: Object3D, width: number): void {
  obj.scale.setScalar(1);
  obj.position.set(0, 0, 0);
  obj.updateMatrixWorld(true);
  const box = new Box3().setFromObject(obj);
  if (box.isEmpty()) return;
  const door = doorWidthOf(obj);
  const span = door ?? box.max.x - box.min.x;
  if (!(span > 1e-5)) return;
  const k = (door ? width : width + 1.8) / span;
  obj.scale.setScalar(k);
  obj.position.y = -box.min.y * k;
}

/**
 * The asset a model's file reference points to: `rel` (as written in the .gltf, URL-encoded) taken
 * from the model's folder. Null when it would leave the assets folder or is not a plain path.
 */
export function siblingAsset(model: string, rel: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(decoded) || decoded.startsWith("/") || decoded.includes("\\")) return null;
  const parts = model.split("/").slice(0, -1);
  for (const p of decoded.split("/")) {
    if (p === "" || p === ".") continue;
    if (p === "..") {
      if (parts.length <= 1) return null;
      parts.pop();
    } else parts.push(p);
  }
  return parts[0] === "assets" && parts.length >= 2 ? parts.join("/") : null;
}

/** Measures a loaded model around its origin, the way the game places it (world_builder.gd: _model). */
export function measureModel(root: Object3D): { halfX: number; halfZ: number; height: number; tall: number; spanX: number; doorWidth?: number } {
  root.updateMatrixWorld(true);
  const box = new Box3().setFromObject(root);
  if (box.isEmpty()) return { halfX: 0.5, halfZ: 0.5, height: 1, tall: 1, spanX: 1 };
  const doorWidth = doorWidthOf(root);
  return {
    halfX: Math.max(0.1, Math.abs(box.min.x), Math.abs(box.max.x)),
    halfZ: Math.max(0.1, Math.abs(box.min.z), Math.abs(box.max.z)),
    height: Math.max(0.1, box.max.y),
    tall: box.max.y - box.min.y,
    spanX: box.max.x - box.min.x,
    ...(doorWidth ? { doorWidth } : {}),
  };
}

type Proxy = { kind: "cylinder"; radius: number; height: number } | { kind: "box"; halfX: number; halfZ: number; height: number } | { kind: "disc"; radius: number; y: number };

/** A generous invisible shape used for clicking, in the object's own units (before its scale). */
export function pickProxy(o: WorldObject): Proxy {
  switch (o.type) {
    case "tree":
      return o.variant === "tall" ? { kind: "cylinder", radius: 1.4, height: 5.8 } : o.variant === "baobab" ? { kind: "cylinder", radius: 2.4, height: 4.9 } : { kind: "cylinder", radius: 1.5, height: 4.6 };
    case "rock":
      return { kind: "cylinder", radius: 0.9, height: 1.05 };
    case "collectible":
      return { kind: "cylinder", radius: 0.7, height: 1.9 };
    case "npc":
      return o.model ? { kind: "cylinder", radius: Math.max(0.45, (o.height ?? 1.8) * 0.25), height: (o.height ?? 1.8) + 0.1 } : { kind: "cylinder", radius: 0.45, height: 2.05 };
    case "enemy": {
      if (!o.model) return { kind: "cylinder", radius: 0.8, height: 1.05 };
      // Around the model fitted to its height (a beetle is long), never smaller than a person.
      const h = o.height ?? 1.8;
      const b = MODEL_BOUNDS.get(o.model);
      const k = b ? h / Math.max(b.tall ?? b.height, 1e-5) : 0;
      return { kind: "cylinder", radius: Math.max(0.45, h * 0.25, b ? Math.max(b.halfX, b.halfZ) * k : 0), height: h + 0.1 };
    }
    case "crate":
      // A model is fitted inside the 1.2 m block.
      return { kind: "box", halfX: 0.65, halfZ: 0.65, height: 1.25 };
    case "gate": {
      const built = { kind: "box" as const, halfX: o.width / 2 + 0.9, halfZ: 0.5, height: 5.1 };
      const b = o.model ? MODEL_BOUNDS.get(o.model) : undefined;
      if (!b) return built;
      const k = b.doorWidth ? o.width / b.doorWidth : (o.width + 1.8) / Math.max(b.spanX ?? b.halfX * 2, 1e-5);
      return { kind: "box", halfX: Math.max(built.halfX, b.halfX * k), halfZ: Math.max(built.halfZ, b.halfZ * k), height: Math.max(built.height, (b.tall ?? b.height) * k) };
    }
    case "zone":
      return { kind: "disc", radius: o.radius, y: 0.05 };
    case "water":
      return { kind: "disc", radius: o.radius, y: 0.07 };
    case "sign":
      return { kind: "box", halfX: 0.8, halfZ: 0.25, height: 1.95 };
    case "torch":
      return { kind: "cylinder", radius: 0.35, height: 2.15 };
    case "model": {
      const b = MODEL_BOUNDS.get(o.asset) ?? { halfX: 0.5, halfZ: 0.5, height: 1 };
      return { kind: "box", halfX: b.halfX, halfZ: b.halfZ, height: b.height };
    }
  }
}

/** Radius of the turning ring drawn around a selected object, in metres. */
export function ringRadius(o: WorldObject): number {
  const p = pickProxy(o);
  const r = p.kind === "box" ? p.halfX : p.radius;
  return Math.max(1.2, r * o.scale + 0.7);
}

/** Height of an object's top, for labels. */
export function objectTop(o: WorldObject): number {
  const p = pickProxy(o);
  return (p.kind === "disc" ? 0.4 : p.height) * o.scale;
}

/** Distance along the ray to a vertical cylinder (axis at cx, cz; y from 0 to height), or null. */
export function intersectCylinder(ray: Ray, cx: number, cz: number, radius: number, height: number): number | null {
  const o = ray.origin;
  const d = ray.direction;
  const ox = o.x - cx;
  const oz = o.z - cz;
  const a = d.x * d.x + d.z * d.z;
  let tIn = -Infinity;
  let tOut = Infinity;
  if (a < 1e-12) {
    if (ox * ox + oz * oz > radius * radius) return null;
  } else {
    const b = 2 * (ox * d.x + oz * d.z);
    const c = ox * ox + oz * oz - radius * radius;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const s = Math.sqrt(disc);
    tIn = (-b - s) / (2 * a);
    tOut = (-b + s) / (2 * a);
  }
  if (Math.abs(d.y) < 1e-12) {
    if (o.y < 0 || o.y > height) return null;
  } else {
    const t0 = (0 - o.y) / d.y;
    const t1 = (height - o.y) / d.y;
    tIn = Math.max(tIn, Math.min(t0, t1));
    tOut = Math.min(tOut, Math.max(t0, t1));
  }
  if (tIn > tOut || tOut < 0) return null;
  return Math.max(tIn, 0);
}

/** Distance along the ray to a box standing on the ground, turned by rotation degrees (clockwise from above), or null. */
export function intersectBox(ray: Ray, cx: number, cz: number, rotation: number, halfX: number, halfZ: number, height: number): number | null {
  const a = rotation * DEG;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const ox = ray.origin.x - cx;
  const oz = ray.origin.z - cz;
  // The group is turned by -rotation about +y; undo that to read the ray in the box's own frame.
  const local = (x: number, z: number) => [x * cos + z * sin, -x * sin + z * cos] as const;
  const [lox, loz] = local(ox, oz);
  const [ldx, ldz] = local(ray.direction.x, ray.direction.z);
  const slabs: [number, number, number, number][] = [
    [lox, ldx, -halfX, halfX],
    [ray.origin.y, ray.direction.y, 0, height],
    [loz, ldz, -halfZ, halfZ],
  ];
  let tIn = -Infinity;
  let tOut = Infinity;
  for (const [o, d, lo, hi] of slabs) {
    if (Math.abs(d) < 1e-12) {
      if (o < lo || o > hi) return null;
      continue;
    }
    const t0 = (lo - o) / d;
    const t1 = (hi - o) / d;
    tIn = Math.max(tIn, Math.min(t0, t1));
    tOut = Math.min(tOut, Math.max(t0, t1));
  }
  if (tIn > tOut || tOut < 0) return null;
  return Math.max(tIn, 0);
}

/** Distance along the ray to a flat disc at height y, or null. */
export function intersectDisc(ray: Ray, cx: number, cz: number, radius: number, y: number): number | null {
  if (Math.abs(ray.direction.y) < 1e-12) return null;
  const t = (y - ray.origin.y) / ray.direction.y;
  if (t < 0) return null;
  const x = ray.origin.x + ray.direction.x * t - cx;
  const z = ray.origin.z + ray.direction.z * t - cz;
  return x * x + z * z <= radius * radius ? t : null;
}

export function intersectObject(ray: Ray, o: WorldObject): number | null {
  const p = pickProxy(o);
  const s = o.scale;
  if (p.kind === "cylinder") return intersectCylinder(ray, o.x, o.z, p.radius * s, p.height * s);
  if (p.kind === "box") return intersectBox(ray, o.x, o.z, o.rotation, p.halfX * s, p.halfZ * s, p.height * s);
  return intersectDisc(ray, o.x, o.z, p.radius * s, p.y * s);
}

/**
 * What changes an object's geometry (as opposed to where it stands). `loaded` tells whether a model file
 * is ready; `realistic` whether trees and rocks are drawn in detail (the realistic style).
 */
function shapeKey(o: WorldObject, loaded: (asset: string) => boolean, realistic: boolean): string {
  return `${baseShapeKey(o, loaded, realistic)}${"material" in o && o.material ? `|${JSON.stringify(o.material)}` : ""}`;
}

function baseShapeKey(o: WorldObject, loaded: (asset: string) => boolean, realistic: boolean): string {
  switch (o.type) {
    case "tree":
      return `tree|${o.variant}|${realistic}`;
    case "rock":
      return `rock|${realistic}`;
    case "npc":
      return `npc|${o.color}|${o.model ?? ""}|${o.height ?? ""}|${o.animation ?? ""}|${o.model && loaded(o.model) ? "loaded" : ""}`;
    case "enemy":
      return `enemy|${o.color}|${o.model ?? ""}|${o.height ?? ""}|${o.model && loaded(o.model) ? "loaded" : ""}`;
    case "crate":
      return `crate|${o.variant}|${o.model ?? ""}|${o.model && loaded(o.model) ? "loaded" : ""}`;
    case "gate":
      return `gate|${o.width}|${o.model ?? ""}|${o.model && loaded(o.model) ? "loaded" : ""}`;
    case "zone":
      return `zone|${o.radius}|${o.visible}`;
    case "water":
      return `water|${o.radius}`;
    case "model":
      return `model|${o.asset}|${o.animation ?? ""}|${loaded(o.asset) ? "loaded" : "pending"}`;
    default:
      return o.type;
  }
}

function envKey(w: World): string {
  const e = w.environment;
  return [w.size.width, w.size.depth, e.skyTop, e.skyHorizon, e.ground, e.sunElevation, e.sunHeading, e.fogDensity, e.sunColor, e.clouds, e.groundVariation, e.style, e.skyImage, e.skyBrightness, JSON.stringify(e.groundMaterial ?? null)].join("|");
}

/** What the grass depends on: its settings, the ground, and the water and zones it keeps clear of. */
function grassKey(w: World): string {
  const e = w.environment;
  return [w.size.width, w.size.depth, e.grass ?? 0, e.groundVariation ?? 0, e.ground, JSON.stringify(grassKeepOut(w))].join("|");
}

type Entry = { key: string; group: Group; data: WorldObject };

export class LevelModel {
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly target = new Vector3();
  private readonly geometries = new Map<string, BufferGeometry>();
  private readonly materials = new Map<string, Material>();
  private readonly entries = new Map<string, Entry>();
  private readonly objectsRoot = new Group();
  private readonly ground: Mesh;
  private readonly grid: LineSegments;
  private readonly border: LineSegments;
  private readonly sky: Mesh;
  private readonly skyShader = skyMaterial();
  /** The ground's patches (look.ts, patchGround): how strong they are. */
  private readonly groundPatches: { variation: { value: number } };
  private grass: InstancedMesh | null = null;
  private grassKey = "";
  private readonly tuft = tuftGeometry();
  private readonly grassMaterial = new MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: DoubleSide });
  /** The anime style's toon materials and outlines (look.ts, Restyler). */
  private readonly restyler = new Restyler();
  /** The realistic style's bark, stone and leaves (nature.ts). */
  private readonly nature = new NatureMaterials();
  private readonly hemi: HemisphereLight;
  readonly sun: DirectionalLight;
  /** Point lights for torches and crystals, reused as objects come and go (see updateLights). */
  private readonly lights: PointLight[] = [];
  private readonly spawn = new Group();
  private readonly spawnBody = new Group();
  private spawnKey = "";
  private readonly ring = new Group();
  private ringMesh: Mesh | null = null;
  private ringKey = "";
  private accent = "#7aa7ff";
  private env = "";
  world: World | null = null;
  selected: string | null = null;
  private fog = false;

  constructor(camera?: PerspectiveCamera) {
    this.camera = camera ?? new PerspectiveCamera(50, 16 / 9, 0.1, 5000);
    this.objectsRoot.name = "objects";
    this.scene.add(this.objectsRoot);

    const groundMaterial = new MeshStandardMaterial({ color: "#5a7d3c", roughness: 0.95 });
    this.groundPatches = patchGround(groundMaterial);
    this.ground = new Mesh(new PlaneGeometry(1, 1), groundMaterial);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.ground.name = "ground";
    this.scene.add(this.ground);

    this.grid = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.1, depthWrite: false }));
    this.grid.name = "grid";
    this.scene.add(this.grid);
    this.border = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.35, depthWrite: false }));
    this.border.name = "border";
    this.scene.add(this.border);

    this.sky = new Mesh(new SphereGeometry(1000, 32, 16), this.skyShader);
    this.sky.name = "sky";
    this.sky.renderOrder = -1;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);

    this.hemi = new HemisphereLight("#ffffff", "#444444", 1.15);
    this.scene.add(this.hemi);
    this.sun = new DirectionalLight("#fff3df", SUN_INTENSITY);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.buildSpawn();
    this.ring.name = "ring";
    this.scene.add(this.ring);
  }

  // ---- shared geometry and materials -------------------------------------------------------

  private geo(key: string, make: () => BufferGeometry): BufferGeometry {
    let g = this.geometries.get(key);
    if (!g) {
      g = make();
      this.geometries.set(key, g);
    }
    return g;
  }

  private cyl(top: number, bottom: number, height: number, segments = 18, open = false) {
    return this.geo(`cyl|${top}|${bottom}|${height}|${segments}|${open}`, () => new CylinderGeometry(top, bottom, height, segments, 1, open));
  }

  private sphere(radius: number, w = 20, h = 14) {
    return this.geo(`sphere|${radius}|${w}|${h}`, () => new SphereGeometry(radius, w, h));
  }

  private box(x: number, y: number, z: number) {
    return this.geo(`box|${x}|${y}|${z}`, () => new BoxGeometry(x, y, z));
  }

  /** A Godot-style material: roughness 0.85, optional emission strength and transparency. */
  private mat(hex: string, emission = 0, alpha = 1): Material {
    const key = `std|${hex}|${emission}|${alpha}`;
    let m = this.materials.get(key);
    if (!m) {
      const s = new MeshStandardMaterial({ color: hex, roughness: alpha < 1 ? 0.15 : 0.85, metalness: alpha < 1 ? 0.2 : 0 });
      if (emission > 0) {
        s.emissive = new Color(hex);
        s.emissiveIntensity = Math.min(1, emission * 0.45);
      }
      if (alpha < 1) {
        s.transparent = true;
        s.opacity = alpha;
        s.depthWrite = false;
      }
      m = s;
      this.materials.set(key, m);
    }
    return m;
  }

  /** An enemy's shell: shinier than the other parts (roughness 0.45, metallic 0.15, as in the game). */
  private shell(hex: string): Material {
    const key = `shell|${hex}`;
    let m = this.materials.get(key);
    if (!m) {
      m = new MeshStandardMaterial({ color: hex, roughness: 0.45, metalness: 0.15 });
      this.materials.set(key, m);
    }
    return m;
  }

  private basic(hex: string, opacity: number): Material {
    const key = `basic|${hex}|${opacity}`;
    let m = this.materials.get(key);
    if (!m) {
      m = new MeshBasicMaterial({ color: hex, transparent: true, opacity, side: DoubleSide, depthWrite: false, fog: false });
      this.materials.set(key, m);
    }
    return m;
  }

  private part(g: Group, geometry: BufferGeometry, material: Material, x: number, y: number, z: number, o: { rx?: number; sy?: number; shadow?: boolean } = {}): Mesh {
    const m = new Mesh(geometry, material);
    m.position.set(x, y, z);
    if (o.rx) m.rotation.x = o.rx;
    if (o.sy) m.scale.y = o.sy;
    const shadow = o.shadow ?? true;
    m.castShadow = shadow;
    m.receiveShadow = shadow;
    g.add(m);
    return m;
  }

  // ---- objects -------------------------------------------------------------------------------

  /** Builds one object in its own space, with its texture set if it has one. */
  buildObject(o: WorldObject): Group {
    this.mixers.delete(o.id);
    const g = this.buildShape(o);
    if ((TEXTURED_TYPES as readonly string[]).includes(o.type) && "material" in o && o.material) this.applyTexture(g, o.id, o.material);
    return g;
  }

  // ---- texture sets on built-in objects -----------------------------------------------------------

  private readonly textures = new Map<string, Promise<Texture>>();
  private readonly texturedMaterials = new Map<string, Material>();
  /** Objects whose plain parts carry a texture set (object id → number of parts), for tests and the self-test. */
  readonly textured = new Map<string, number>();

  /** Gives the object's plain parts (not glowing or see-through ones) the texture set, once its colour map loads. */
  private applyTexture(g: Group, id: string, m: ObjectMaterial) {
    const url = this.modelUrl?.(m.albedo);
    if (!url || !this.textureLoader) {
      this.modelErrors.set(m.albedo, "Textures are drawn in the desktop app.");
      return;
    }
    let p = this.textures.get(url);
    if (!p) {
      p = this.textureLoader(url, true);
      this.textures.set(url, p);
      p.catch(() => this.textures.delete(url));
    }
    p.then(
      (tex) => {
        if (this.entries.get(id)?.group !== g) return;
        let count = 0;
        g.traverse((c) => {
          const mesh = c as Mesh;
          const base = mesh.isMesh ? (mesh.material as MeshStandardMaterial) : null;
          if (!base || !(base as { isMeshStandardMaterial?: boolean }).isMeshStandardMaterial || base.transparent || base.alphaTest > 0 || base.emissiveIntensity * (base.emissive.r + base.emissive.g + base.emissive.b) > 0) return;
          // Parts coloured by their mesh (the realistic style's bark and rocks) keep those colours when tinted.
          const vertexColors = Boolean(m.tint && base.vertexColors);
          const key = `${base.color.getHexString()}|${vertexColors}|${JSON.stringify(m)}`;
          let t = this.texturedMaterials.get(key);
          if (!t) {
            const made = new MeshStandardMaterial({ color: m.tint ? base.color.clone() : new Color("#ffffff"), roughness: 1, map: tex, vertexColors });
            triplanar(made, m.tile);
            t = made;
            this.texturedMaterials.set(key, t);
          }
          mesh.material = t;
          count++;
        });
        this.textured.set(id, count);
        this.onModelLoaded?.();
      },
      (e: unknown) => {
        this.modelErrors.set(m.albedo, e instanceof Error ? e.message : String(e));
        this.onModelLoaded?.();
      },
    );
  }

  /** Builds one object in its own space, like world_builder.gd's _tree, _rock, ... */
  private buildShape(o: WorldObject): Group {
    const g = new Group();
    g.name = o.id;
    g.userData["id"] = o.id;
    switch (o.type) {
      case "tree": {
        if (this.world?.environment.style === "realistic") {
          // Like world_builder.gd's _nature: a detailed tree (nature.ts).
          g.add(natureGroup(o.variant, o.id, this.nature));
          this.nature.loadLeaves(this.textureLoader, () => this.onModelLoaded?.());
          break;
        }
        const baobab = o.variant === "baobab";
        const trunkH = baobab ? 3.6 : 2.2;
        const trunkR = baobab ? 0.85 : 0.28;
        this.part(g, this.cyl(trunkR * 0.8, trunkR, trunkH), this.mat("#7a5634"), 0, trunkH / 2, 0);
        const canopy = this.mat(baobab ? "#4f8a3a" : "#2f7d4a");
        if (o.variant === "tall") this.part(g, this.cyl(0, 1.4, 4.0), canopy, 0, trunkH + 1.6, 0);
        else if (baobab) this.part(g, this.sphere(2.4), canopy, 0, trunkH + 0.5, 0, { sy: 1.6 / 4.8 });
        else this.part(g, this.sphere(1.5), canopy, 0, trunkH + 1.0, 0, { sy: 2.8 / 3.0 });
        break;
      }
      case "rock":
        if (this.world?.environment.style === "realistic") g.add(natureGroup("rock", o.id, this.nature));
        else this.part(g, this.sphere(0.9, 10, 6), this.mat("#8a8f96"), 0, 0.45, 0, { sy: 1.2 / 1.8 });
        break;
      case "collectible": {
        const crystal = this.mat("#f2b84b", 2.2);
        const half = this.cyl(0, 0.32, 0.55, 6);
        this.part(g, half, crystal, 0, 1.1 + 0.27, 0);
        this.part(g, half, crystal, 0, 1.1 - 0.27, 0, { rx: Math.PI });
        break;
      }
      case "npc": {
        // A villager drawn from an imported character: scaled to its height, facing south at rotation 0.
        const character = o.model ? this.models.get(o.model) : undefined;
        if (o.model && character) {
          const copy = this.instanceOf(character);
          fitHeight(copy, o.height ?? 1.8);
          g.add(copy);
          this.animate(o.id, copy, character.clips, o.animation, "idle");
          break;
        }
        if (o.model) this.loadModel(o.model);
        this.part(g, this.geo("capsule|0.34|0.82", () => new CapsuleGeometry(0.34, 1.5 - 0.68, 6, 16)), this.mat(o.color), 0, 0.75, 0);
        this.part(g, this.sphere(0.24, 16, 12), this.mat("#6b4a32"), 0, 1.72, 0);
        this.part(g, this.cyl(0.2, 0.26, 0.18, 16), this.mat(o.color), 0, 1.92, 0);
        break;
      }
      case "enemy": {
        // Like world_builder.gd's _enemy: an imported character turned to face north, or a thorn beetle.
        const character = o.model ? this.models.get(o.model) : undefined;
        if (o.model && character) {
          const copy = this.instanceOf(character);
          fitHeight(copy, o.height ?? 1.8);
          copy.rotation.y = Math.PI;
          g.add(copy);
          this.animate(o.id, copy, character.clips, undefined, "idle");
          break;
        }
        if (o.model) this.loadModel(o.model);
        const dark = this.mat("#2b2233");
        this.part(g, this.sphere(0.55), this.shell(o.color), 0, 0.45, 0.05, { sy: 0.7 / 1.1 });
        this.part(g, this.sphere(0.45), dark, 0, 0.25, 0.05, { sy: 0.4 / 0.9 });
        this.part(g, this.sphere(0.26), dark, 0, 0.42, -0.5, { sy: 0.44 / 0.52 });
        for (const side of [-1, 1]) this.part(g, this.sphere(0.07, 10, 8), this.mat("#ffd23f", 2.5), side * 0.11, 0.5, -0.7);
        for (const z of [-0.15, 0.12, 0.38]) this.part(g, this.cyl(0, 0.09, 0.32, 6), this.mat("#7bd36a"), 0, 0.88 - Math.abs(z) * 0.25, z, { rx: (-20 * Math.PI) / 180 });
        break;
      }
      case "crate": {
        // Like world_builder.gd's _crate: an imported model fitted to the 1.2 m block, or a box with a band round its middle.
        const blockModel = o.model ? this.models.get(o.model) : undefined;
        if (o.model && blockModel) {
          const copy = this.instanceOf(blockModel);
          fitBox(copy, 1.2);
          g.add(copy);
          break;
        }
        if (o.model) this.loadModel(o.model);
        const stone = o.variant === "stone";
        this.part(g, this.box(1.2, 1.2, 1.2), this.mat(stone ? "#8d8a80" : "#9a6b3c"), 0, 0.6, 0);
        this.part(g, this.box(1.224, 0.192, 1.224), this.mat(stone ? "#6f6c63" : "#6b4a2a"), 0, 0.6, 0);
        break;
      }
      case "gate": {
        const w = o.width;
        // Like world_builder.gd's _gate: an imported gate scaled to the door's width, or the built-in stones and door.
        const gateModel = o.model ? this.models.get(o.model) : undefined;
        if (o.model && gateModel) {
          const copy = this.instanceOf(gateModel);
          fitGate(copy, w);
          g.add(copy);
          break;
        }
        if (o.model) this.loadModel(o.model);
        const stone = this.mat("#b9a27a");
        for (const side of [-1, 1]) this.part(g, this.box(0.9, 4.4, 0.9), stone, side * (w / 2 + 0.45), 2.2, 0);
        this.part(g, this.box(w + 1.8, 0.7, 1.0), stone, 0, 4.75, 0);
        this.part(g, this.box(w, 4.0, 0.35), this.mat("#6b4a2a"), 0, 2.0, 0);
        this.part(g, this.cyl(0.6, 0.6, 0.06, 24), this.mat("#f2b84b", 1.2), 0, 2.4, 0.2, { rx: Math.PI / 2 });
        break;
      }
      case "zone": {
        const r = o.radius;
        const inner = Math.max(r - 0.18, 0.1);
        const torus = this.geo(`torus|${r}`, () => new TorusGeometry((inner + r) / 2, (r - inner) / 2, 8, 64));
        this.part(g, torus, o.visible ? this.mat("#3cc9b4", 1.5) : this.basic("#3cc9b4", 0.35), 0, 0.05, 0, { rx: Math.PI / 2, shadow: false });
        // Editor aid: the trigger volume (a 3 m tall cylinder), drawn faintly.
        this.part(g, this.cyl(r, r, 3, 48, true), this.basic("#3cc9b4", 0.07), 0, 1.5, 0, { shadow: false });
        break;
      }
      case "water": {
        const m = this.part(g, this.cyl(o.radius, o.radius, 0.08, 48), this.mat("#2f7fb8", 0, 0.78), 0, 0.03, 0, { shadow: false });
        m.receiveShadow = true;
        break;
      }
      case "sign": {
        const wood = this.mat("#8a6239");
        this.part(g, this.box(0.14, 1.6, 0.14), wood, 0, 0.8, 0);
        this.part(g, this.box(1.5, 0.75, 0.1), wood, 0, 1.55, 0);
        break;
      }
      case "torch":
        this.part(g, this.cyl(0.07, 0.09, 1.8, 10), this.mat("#5a4030"), 0, 0.9, 0);
        this.part(g, this.sphere(0.16, 12, 8), this.mat("#ff9b3d", 3.0), 0, 1.95, 0, { sy: 0.36 / 0.32, shadow: false });
        break;
      case "model": {
        const loaded = this.models.get(o.asset);
        if (loaded) {
          const copy = this.instanceOf(loaded);
          g.add(copy);
          if (o.animation) this.animate(o.id, copy, loaded.clips, o.animation);
        } else {
          // Until the file loads (or when it cannot be found): a faint box where the model will stand.
          const b = MODEL_BOUNDS.get(o.asset) ?? { halfX: 0.5, halfZ: 0.5, height: 1 };
          this.part(g, this.box(b.halfX * 2, b.height, b.halfZ * 2), this.basic(this.modelErrors.has(o.asset) ? "#e5484d" : "#7aa7ff", 0.35), 0, b.height / 2, 0, { shadow: false });
          this.loadModel(o.asset);
        }
        break;
      }
    }
    return g;
  }

  // ---- imported models ---------------------------------------------------------------------------

  private readonly models = new Map<string, LoadedModel>();
  /** Animations playing in the view (object id, or SPAWN_ID for the player, → its mixer and animation). */
  private readonly mixers = new Map<string, { mixer: AnimationMixer; clip: string }>();
  private readonly loading = new Set<string>();
  /** Assets that failed to load, with the reason (shown by the editor). */
  readonly modelErrors = new Map<string, string>();
  /** Where to fetch an asset (a URL), or null when files cannot be read (tests, browser preview). */
  modelUrl: ((asset: string) => string | null) | null = null;
  /** Loads a model file and the files it refers to (through `resolve`); three's GLTFLoader is imported only when a world uses models. */
  modelLoader: ((asset: string, resolve: (asset: string) => string | null) => Promise<LoadedModel>) | null = null;
  /** Loads a repeating texture (colour textures in sRGB). */
  textureLoader: ((url: string, srgb: boolean) => Promise<import("three").Texture>) | null = null;
  /** Loads a photographed sky (.hdr) as an equirectangular texture of light values (set by the view). */
  hdrLoader: ((url: string) => Promise<import("three").Texture>) | null = null;
  /** The photographed sky now shown, if any (environment.skyImage). */
  photoSky: import("three").Texture | null = null;
  /** Called when a model finishes loading, so the view can draw again. */
  onModelLoaded: (() => void) | null = null;

  /** Hands the scene a model that was loaded elsewhere (tests use it). */
  addLoadedModel(asset: string, root: Object3D, clips: AnimationClip[] = []) {
    this.models.set(asset, { scene: root, clips });
    MODEL_BOUNDS.set(asset, measureModel(root));
    this.modelErrors.delete(asset);
    if (this.world) this.sync(this.world, this.selected);
  }

  /** The animation names in a loaded model, or null before it has loaded. */
  clipNames(asset: string): string[] | null {
    const m = this.models.get(asset);
    return m ? m.clips.map((c) => c.name) : null;
  }

  /** A copy of a loaded model with its own skeleton (a plain clone would share the original's bones). */
  private instanceOf(m: LoadedModel): Object3D {
    const copy = cloneSkinned(m.scene);
    copy.traverse((c) => {
      if ((c as Mesh).isMesh) {
        c.castShadow = true;
        c.receiveShadow = true;
      }
    });
    return copy;
  }

  /** Loops an animation on `root` (the named one, or the one suggesting `state`). */
  private animate(id: string, root: Object3D, clips: AnimationClip[], wanted: string | undefined, state?: CharacterState) {
    const name = pickClip(clips.map((c) => c.name), wanted, state);
    const clip = clips.find((c) => c.name === name);
    if (!clip) return;
    const mixer = new AnimationMixer(root);
    mixer.clipAction(clip).play();
    this.mixers.set(id, { mixer, clip: clip.name });
  }

  /** Moves every animation on by `dt` seconds. */
  tick(dt: number) {
    for (const m of this.mixers.values()) m.mixer.update(dt);
  }

  /** Whether anything in the view is animated. */
  animating(): boolean {
    return this.mixers.size > 0;
  }

  /** What each animated thing plays (for tests and the self-test). */
  playing(): Record<string, string> {
    return Object.fromEntries([...this.mixers].map(([id, m]) => [id, m.clip]));
  }

  private loadModel(asset: string) {
    if (this.loading.has(asset) || this.modelErrors.has(asset)) return;
    const url = this.modelUrl?.(asset);
    if (!url || !this.modelLoader) {
      this.modelErrors.set(asset, "Models are drawn in the desktop app.");
      return;
    }
    this.loading.add(asset);
    this.modelLoader(asset, (a) => this.modelUrl?.(a) ?? null)
      .then((loaded) => {
        this.addLoadedModel(asset, loaded.scene, loaded.clips);
        this.onModelLoaded?.();
      })
      .catch((e: unknown) => {
        this.modelErrors.set(asset, e instanceof Error ? e.message : String(e));
        if (this.world) {
          // Rebuild the placeholder in red.
          for (const [id, entry] of this.entries) if ((entry.data.type === "model" && entry.data.asset === asset) || (entry.data.type === "npc" && entry.data.model === asset)) this.entries.set(id, { ...entry, key: "" });
          this.sync(this.world, this.selected);
        }
        this.onModelLoaded?.();
      })
      .finally(() => this.loading.delete(asset));
  }

  private place(g: Group, o: { x: number; z: number; rotation: number; scale: number }) {
    g.position.set(o.x, 0, o.z);
    g.rotation.set(0, -o.rotation * DEG, 0);
    g.scale.setScalar(o.scale);
  }

  private buildSpawn() {
    this.spawn.name = SPAWN_ID;
    this.spawnBody.name = "body";
    this.spawn.add(this.spawnBody);
    this.capsuleSpawn();
    const marker = new Mesh(this.geo("ring|0.7|0.95", () => new RingGeometry(0.7, 0.95, 40)), this.basic("#3cc9b4", 0.9));
    marker.rotation.x = -Math.PI / 2;
    marker.position.y = 0.04;
    this.spawn.add(marker);
    this.scene.add(this.spawn);
  }

  /** The player from scenes/player.tscn: a 1.7 m capsule with a visor facing north. */
  private capsuleSpawn() {
    this.spawnBody.clear();
    this.part(this.spawnBody, this.geo("capsule|0.35|1.0", () => new CapsuleGeometry(0.35, 1.0, 6, 16)), this.mat("#3cc9b4"), 0, 0.85, 0);
    this.part(this.spawnBody, this.box(0.42, 0.14, 0.12), this.mat("#0f1a2b"), 0, 1.38, -0.3);
  }

  /**
   * The player's imported character at the start, standing idle, built the way player.gd builds it:
   * scaled to its height and turned by `turn` (glTF characters face +Z, the player faces north).
   */
  private syncSpawnCharacter(c: Character | undefined) {
    const loaded = c ? this.models.get(c.asset) : undefined;
    const key = c ? `${c.asset}|${c.height}|${c.turn}|${c.idle ?? ""}|${loaded ? "loaded" : ""}` : "";
    if (key === this.spawnKey) return;
    this.spawnKey = key;
    this.mixers.delete(SPAWN_ID);
    if (c && loaded) {
      this.spawnBody.clear();
      const copy = this.instanceOf(loaded);
      fitHeight(copy, c.height);
      copy.rotation.y = c.turn * DEG;
      this.spawnBody.add(copy);
      this.animate(SPAWN_ID, copy, loaded.clips, c.idle, "idle");
    } else {
      if (c) this.loadModel(c.asset);
      this.capsuleSpawn();
    }
  }

  // ---- syncing with the world file ---------------------------------------------------------------

  setOptions(o: { grid: boolean; fog: boolean }) {
    this.grid.visible = o.grid;
    if (o.fog !== this.fog) {
      this.fog = o.fog;
      this.env = "";
      if (this.world) this.applyEnvironment(this.world);
    }
  }

  /** Brings the scene in line with the world: rebuilds objects whose shape changed, moves the rest. */
  sync(world: World, selected: string | null) {
    this.world = world;
    this.selected = selected;
    if (envKey(world) !== this.env) this.applyEnvironment(world);
    if (grassKey(world) !== this.grassKey) this.applyGrass(world);
    const seen = new Set<string>();
    for (const o of world.objects) {
      if (seen.has(o.id)) continue;
      seen.add(o.id);
      const key = shapeKey(o, (a) => this.models.has(a), world.environment.style === "realistic");
      let e = this.entries.get(o.id);
      if (!e || e.key !== key) {
        if (e) this.objectsRoot.remove(e.group);
        e = { key, group: this.buildObject(o), data: o };
        this.entries.set(o.id, e);
        this.objectsRoot.add(e.group);
      }
      e.data = o;
      this.place(e.group, o);
    }
    for (const [id, e] of this.entries) {
      if (!seen.has(id)) {
        this.objectsRoot.remove(e.group);
        this.entries.delete(id);
        this.mixers.delete(id);
      }
    }
    this.spawn.position.set(world.player.spawn.x, 0, world.player.spawn.z);
    this.syncSpawnCharacter(world.player.character);
    this.ensureRing();
    const o = this.selectedObject();
    if (o) this.moveRing(o.x, o.z, o.rotation);
    this.updateLights();
  }

  /**
   * Gives torches and crystals real point lights, set up like the game's OmniLight3D: same colour and
   * range, falloff exponent 1 (Godot's default attenuation) and energy scaled like the sun. three.js
   * recompiles every material when the number of lights changes, so the pool grows and shrinks in steps
   * of 8 and spare lights stay dark. With more than MAX_LIGHTS emitters, the ones nearest the camera's
   * focus get the lights.
   */
  private updateLights() {
    const emitters: { x: number; y: number; z: number; e: Emitter }[] = [];
    for (const entry of this.entries.values()) {
      const e = lightOf(entry.data);
      if (!e) continue;
      const g = entry.group; // follows drag previews
      emitters.push({ x: g.position.x, y: e.y * g.scale.y, z: g.position.z, e });
    }
    const want = emitters.length === 0 ? 0 : Math.min(MAX_LIGHTS, Math.ceil(emitters.length / 8) * 8);
    while (this.lights.length < want) {
      const l = new PointLight("#ffffff", 0, 1, 1);
      l.name = `light_${this.lights.length}`;
      this.lights.push(l);
      this.scene.add(l);
    }
    while (this.lights.length > want) {
      const l = this.lights.pop()!;
      this.scene.remove(l);
      l.dispose();
    }
    if (emitters.length > this.lights.length) {
      const t = this.target;
      emitters.sort((a, b) => Math.hypot(a.x - t.x, a.z - t.z) - Math.hypot(b.x - t.x, b.z - t.z));
    }
    this.lights.forEach((l, i) => {
      const m = emitters[i];
      if (!m) {
        l.intensity = 0;
        return;
      }
      l.position.set(m.x, m.y, m.z);
      l.color.set(m.e.color);
      l.intensity = m.e.energy * SUN_INTENSITY;
      l.distance = m.e.range;
      l.decay = 1;
    });
  }

  /** The point lights in use, for tests and the self-test. */
  activeLights(): { x: number; y: number; z: number; color: string; intensity: number; distance: number; decay: number }[] {
    return this.lights.filter((l) => l.intensity > 0).map((l) => ({ x: l.position.x, y: l.position.y, z: l.position.z, color: `#${l.color.getHexString()}`, intensity: l.intensity, distance: l.distance, decay: l.decay }));
  }

  /** How many point lights the scene holds, lit or spare: the number three.js compiles shaders for. */
  lightPoolSize(): number {
    return this.lights.length;
  }

  private applyEnvironment(w: World) {
    this.env = envKey(w);
    const { width: W, depth: D } = w.size;
    const e = w.environment;
    this.ground.geometry.dispose();
    this.ground.geometry = new PlaneGeometry(W, D);
    const groundMat = this.ground.material as MeshStandardMaterial;
    groundMat.color.set(e.ground);
    for (const k of ["map", "normalMap", "roughnessMap"] as const) {
      groundMat[k]?.dispose();
      groundMat[k] = null;
    }
    groundMat.needsUpdate = true;
    const gm = e.groundMaterial;
    if (gm && this.modelUrl && this.textureLoader) {
      // Like the game: the colour texture replaces the ground colour, repeated every `tile` metres.
      const repeat = (k: "map" | "normalMap" | "roughnessMap", asset: string | undefined) => {
        const url = asset ? this.modelUrl?.(asset) : null;
        if (!url) return;
        const key = this.env;
        this.textureLoader!(url, k === "map")
          .then((t) => {
            if (this.env !== key) return t.dispose();
            t.repeat.set(W / gm.tile, D / gm.tile);
            groundMat[k] = t;
            if (k === "map") groundMat.color.set("#ffffff");
            groundMat.needsUpdate = true;
            this.onModelLoaded?.();
          })
          .catch((err: unknown) => this.modelErrors.set(asset!, err instanceof Error ? err.message : String(err)));
      };
      repeat("map", gm.albedo);
      repeat("normalMap", gm.normal);
      repeat("roughnessMap", gm.roughness);
    }

    const grid: number[] = [];
    for (let x = -W / 2 + 10; x < W / 2 - 1e-6; x += 10) grid.push(x, 0.02, -D / 2, x, 0.02, D / 2);
    for (let z = -D / 2 + 10; z < D / 2 - 1e-6; z += 10) grid.push(-W / 2, 0.02, z, W / 2, 0.02, z);
    this.grid.geometry.dispose();
    this.grid.geometry = new BufferGeometry();
    this.grid.geometry.setAttribute("position", new BufferAttribute(new Float32Array(grid), 3));
    const [x0, x1, z0, z1] = [-W / 2, W / 2, -D / 2, D / 2];
    const edge = [x0, 0.03, z0, x1, 0.03, z0, x1, 0.03, z0, x1, 0.03, z1, x1, 0.03, z1, x0, 0.03, z1, x0, 0.03, z1, x0, 0.03, z0];
    this.border.geometry.dispose();
    this.border.geometry = new BufferGeometry();
    this.border.geometry.setAttribute("position", new BufferAttribute(new Float32Array(edge), 3));

    // Sky: the game's sky shader (look.ts), with its clouds, sun and the fog over it; or a photographed
    // sky (world_builder.gd, photo_sky.gdshader) that also lights the level.
    const horizon = new Color(e.skyHorizon);
    updateSky(this.skyShader, w, sunDirection(e.sunElevation, e.sunHeading), this.fog);
    this.applyPhotoSky(e.skyImage, e.skyBrightness ?? 1);
    this.groundPatches.variation.value = e.groundVariation ?? 0;
    this.sun.color.set(e.sunColor ?? "#fff3df");

    this.hemi.color.copy(horizon).lerp(new Color("#ffffff"), 0.5);
    this.hemi.groundColor.set(e.ground).multiplyScalar(0.6);

    const half = Math.hypot(W, D) / 2 + 5;
    const dist = half * 2 + 20;
    this.sun.position.copy(sunDirection(e.sunElevation, e.sunHeading).multiplyScalar(dist));
    this.sun.target.position.set(0, 0, 0);
    const cam = this.sun.shadow.camera;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.near = 1;
    cam.far = dist * 2 + 50;
    cam.updateProjectionMatrix();

    this.scene.fog = this.fog && e.fogDensity > 0 ? new FogExp2(horizon.getHex(), e.fogDensity) : null;
  }

  /** Shows a photographed sky behind the level and lights the level with it, or goes back to the sky shader. */
  private applyPhotoSky(asset: string | undefined, brightness: number) {
    const clear = () => {
      this.photoSky?.dispose();
      this.photoSky = null;
      this.scene.background = null;
      this.scene.environment = null;
      this.sky.visible = true;
      this.hemi.intensity = 1.15;
    };
    const url = asset ? this.modelUrl?.(asset) : null;
    if (!asset || !url || !this.hdrLoader) {
      clear();
      return;
    }
    const key = this.env;
    this.hdrLoader(url)
      .then((t) => {
        if (this.env !== key) return t.dispose();
        clear();
        t.mapping = EquirectangularReflectionMapping;
        this.photoSky = t;
        this.scene.background = t;
        this.scene.environment = t;
        this.scene.backgroundIntensity = brightness;
        this.scene.environmentIntensity = brightness;
        // The photo lights the level now; the hemisphere light only fills in a little.
        this.sky.visible = false;
        this.hemi.intensity = 0.25;
        this.onModelLoaded?.();
      })
      .catch((err: unknown) => this.modelErrors.set(asset, err instanceof Error ? err.message : String(err)));
  }

  /** The level's grass (look.ts, grassMesh), rebuilt when its settings, the ground or the water and zones change. */
  private applyGrass(w: World) {
    this.grassKey = grassKey(w);
    if (this.grass) {
      this.scene.remove(this.grass);
      this.grass.dispose();
      this.grass = null;
    }
    this.grass = grassMesh(w, this.tuft, this.grassMaterial);
    if (this.grass) this.scene.add(this.grass);
  }

  /** How many tufts of grass are drawn (0 when the level has none). */
  grassCount(): number {
    return this.grass?.count ?? 0;
  }

  /**
   * The selection ring: an accent ring around the selected object, with a knob on the side it faces.
   * It floats just above water and zone discs and is hidden behind solid objects, so what you see is what a click takes.
   */
  private ensureRing() {
    const o = this.selectedObject();
    const thickness = this.ringThickness();
    const r = o ? this.ringRadiusNow(o) : 0;
    const key = o ? `${r.toFixed(2)}|${thickness.toFixed(3)}|${this.accent}` : "";
    this.ring.visible = !!o;
    if (key === this.ringKey) return;
    this.ringKey = key;
    this.ring.clear();
    this.ringMesh?.geometry.dispose();
    this.ringMesh = null;
    if (!o) return;
    const ring = new Mesh(new RingGeometry(r - thickness, r + thickness, 72), this.basic(this.accent, 0.95));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = RING_Y;
    const knob = new Mesh(this.sphere(1, 12, 8), this.basic(this.accent, 1));
    knob.scale.setScalar(thickness * 1.8);
    knob.position.set(0, RING_Y, -r);
    this.ring.add(ring, knob);
    this.ringMesh = ring;
  }

  private moveRing(x: number, z: number, rotation: number) {
    this.ring.position.set(x, 0, z);
    this.ring.rotation.set(0, -rotation * DEG, 0);
  }

  private cameraDistance(o: WorldObject): number {
    return this.camera.position.distanceTo(new Vector3(o.x, 0, o.z));
  }

  /** The ring keeps a readable size on screen: never tighter than about 3% of the camera's distance. */
  ringRadiusNow(o: WorldObject): number {
    return Math.max(ringRadius(o), this.cameraDistance(o) * 0.03);
  }

  private ringThickness(): number {
    const o = this.selectedObject();
    if (!o) return 0.1;
    return Math.min(this.ringRadiusNow(o) * 0.15, Math.max(0.05, this.cameraDistance(o) * 0.0028));
  }

  /** The selection colour, taken from the app's theme so the 3D view matches the map. */
  setAccent(css: string) {
    try {
      const hex = `#${new Color().setStyle(css.trim()).getHexString()}`;
      if (hex !== this.accent) {
        this.accent = hex;
        this.ringKey = "";
        this.ensureRing();
      }
    } catch {
      // Keep the default when the theme gives something three.js cannot read.
    }
  }

  selectedObject(): WorldObject | null {
    if (!this.selected) return null;
    return this.entries.get(this.selected)?.data ?? null;
  }

  object(id: string): WorldObject | null {
    return this.entries.get(id)?.data ?? null;
  }

  group(id: string): Group | null {
    return id === SPAWN_ID ? this.spawn : (this.entries.get(id)?.group ?? null);
  }

  /** Shows an object somewhere else while it is dragged, without touching the world file. */
  preview(id: string, p: { x: number; z: number; rotation?: number }) {
    const g = this.group(id);
    if (!g) return;
    g.position.set(p.x, 0, p.z);
    if (p.rotation !== undefined) g.rotation.set(0, -p.rotation * DEG, 0);
    const o = this.selectedObject();
    if (o && id === o.id) this.moveRing(p.x, p.z, p.rotation ?? o.rotation);
  }

  /** Per-frame upkeep: the sky follows the camera, the ring keeps a readable thickness and lights follow drags. */
  beforeRender() {
    this.sky.position.copy(this.camera.position);
    this.ensureRing();
    this.updateLights();
    const anime = this.anime();
    this.restyler.apply(this.objectsRoot, anime);
    this.restyler.apply(this.spawn, anime);
    if (anime) this.restyler.outlineOnlyStyled(this.scene);
  }

  /** Whether the level is drawn in the anime style (environment.style; style.gd in the game). */
  anime(): boolean {
    return this.world?.environment.style === "anime";
  }

  // ---- picking ---------------------------------------------------------------------------------

  /** A ray from the camera through a point given in normalised device coordinates (-1..1). */
  rayAt(ndcX: number, ndcY: number): Ray {
    const rc = new Raycaster();
    this.camera.updateMatrixWorld();
    rc.setFromCamera(new Vector2(ndcX, ndcY), this.camera);
    return rc.ray.clone();
  }

  /** Where the ray meets the horizontal plane at height y, or null when it points away from it. */
  static onPlane(ray: Ray, y = 0): Vector3 | null {
    return ray.intersectPlane(new Plane(new Vector3(0, 1, 0), -y), new Vector3());
  }

  /** The nearest thing under the pointer: an object, the player start, or the selected object's turning ring. */
  pick(ray: Ray): Hit | null {
    let best: Hit | null = null;
    const sel = this.selectedObject();
    if (sel) {
      const p = LevelModel.onPlane(ray, RING_Y);
      if (p) {
        const r = this.ringRadiusNow(sel);
        const band = Math.max(this.ringThickness() * 2.5, 0.35);
        const d = Math.hypot(p.x - sel.x, p.z - sel.z);
        if (Math.abs(d - r) <= band) best = { kind: "ring", id: sel.id, point: p, t: ray.origin.distanceTo(p) };
      }
    }
    for (const e of this.entries.values()) {
      const t = intersectObject(ray, e.data);
      if (t !== null && (!best || t < best.t)) best = { kind: "object", id: e.data.id, t, point: ray.at(t, new Vector3()) };
    }
    if (this.world) {
      const s = this.world.player.spawn;
      const t = intersectCylinder(ray, s.x, s.z, 0.6, 2.0);
      if (t !== null && (!best || t < best.t)) best = { kind: "spawn", t, point: ray.at(t, new Vector3()) };
    }
    return best;
  }

  // ---- camera ----------------------------------------------------------------------------------

  /**
   * Frames the whole level from the south, 52° above the ground: the closest distance at which all four
   * corners are on screen, leaving a margin for the toolbar and the legend.
   */
  fit() {
    if (!this.world) return;
    const { width: W, depth: D } = this.world.size;
    const dir = new Vector3(0, Math.sin(52 * DEG), Math.cos(52 * DEG));
    const corners = [[-W / 2, -D / 2], [W / 2, -D / 2], [-W / 2, D / 2], [W / 2, D / 2]].map(([x, z]) => new Vector3(x, 0, z));
    this.target.set(0, 0, 0);
    this.camera.updateProjectionMatrix();
    const fits = (dist: number) => {
      this.camera.position.copy(dir).multiplyScalar(dist);
      this.camera.lookAt(this.target);
      this.camera.updateMatrixWorld();
      return corners.every((c) => {
        if (c.clone().applyMatrix4(this.camera.matrixWorldInverse).z >= 0) return false; // behind the camera
        const p = c.clone().project(this.camera);
        return Math.abs(p.x) <= 0.92 && Math.abs(p.y) <= 0.86;
      });
    };
    let lo = 1;
    let hi = Math.max(W, D) * 4 + 50; // always fits, and stays inside the far plane
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) hi = mid;
      else lo = mid;
    }
    fits(hi);
  }

  /** Moves the camera so it looks at (x, z) from the same angle and distance. */
  focus(x: number, z: number) {
    const offset = this.camera.position.clone().sub(this.target);
    this.target.set(x, 0, z);
    this.camera.position.copy(this.target).add(offset);
    this.camera.lookAt(this.target);
  }

  /** Brings the camera closer (factor < 1) or further away (factor > 1), within limits. */
  zoom(factor: number, min = 2, max = 2000) {
    const offset = this.camera.position.clone().sub(this.target);
    const len = Math.min(max, Math.max(min, offset.length() * factor));
    offset.setLength(len);
    this.camera.position.copy(this.target).add(offset);
    this.camera.lookAt(this.target);
  }

  dispose() {
    for (const g of this.geometries.values()) g.dispose();
    for (const m of this.materials.values()) m.dispose();
    this.ground.geometry.dispose();
    (this.ground.material as Material).dispose();
    this.grid.geometry.dispose();
    (this.grid.material as Material).dispose();
    this.border.geometry.dispose();
    (this.border.material as Material).dispose();
    this.sky.geometry.dispose();
    (this.sky.material as Material).dispose();
    this.grass?.dispose();
    this.photoSky?.dispose();
    this.tuft.dispose();
    this.grassMaterial.dispose();
    this.restyler.dispose();
    this.nature.dispose();
    this.ringMesh?.geometry.dispose();
    this.sun.shadow.map?.dispose();
    for (const l of this.lights) l.dispose();
    this.lights.length = 0;
    this.geometries.clear();
    this.materials.clear();
    this.entries.clear();
    for (const m of this.mixers.values()) m.mixer.stopAllAction();
    this.mixers.clear();
    for (const m of this.texturedMaterials.values()) m.dispose();
    this.texturedMaterials.clear();
  }
}

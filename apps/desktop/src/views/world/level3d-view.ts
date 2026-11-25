import { AgXToneMapping, NeutralToneMapping, PCFShadowMap, Vector3, WebGLRenderer } from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { OutlineEffect } from "three/addons/effects/OutlineEffect.js";
import type { World } from "@gamestudio/explore";
import { bearing, normalizeRotation } from "./angles";
import { LevelModel, RING_Y, SPAWN_ID, objectTop, type Hit } from "./level3d";
import { loadModelFile } from "./modelFiles";

/**
 * Draws the level with WebGL and turns pointer input into edits. Clicks on objects, the player start
 * and the turning ring are handled here; everything else goes to the orbit camera.
 */
export interface LevelViewEvents {
  select(id: string | null): void;
  /** id is SPAWN_ID for the player start. Called once, when a drag ends somewhere new. */
  move(id: string, x: number, z: number): void;
  rotate(id: string, rotation: number): void;
  contextLost(lost: boolean): void;
}

/** Where the camera is and what it looks at, kept while the 3D view is closed. */
export interface CameraState {
  position: [number, number, number];
  target: [number, number, number];
}

export interface LevelViewOptions {
  grid: boolean;
  fog: boolean;
  snap: boolean;
}

type Drag =
  | { kind: "move"; id: string; pointerId: number; planeY: number; start: Vector3; origX: number; origZ: number; x: number; z: number }
  | { kind: "turn"; id: string; pointerId: number; x: number; z: number; startBearing: number; orig: number; rotation: number };

/** Pointer travel, in pixels, below which a press counts as a click. */
const CLICK_SLOP = 4;
const SNAP_DEGREES = 15;

export class LevelView {
  private outlines: OutlineEffect | null = null;
  readonly model = new LevelModel();
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;
  private readonly controls: OrbitControls;
  private readonly labels: HTMLDivElement;
  private readonly labelEls = new Map<string, HTMLDivElement>();
  private readonly resize: ResizeObserver;
  private readonly listeners: [EventTarget, string, EventListener, boolean][] = [];
  private drag: Drag | null = null;
  private down: { x: number; y: number; pointerId: number; onThing: boolean; moved: boolean } | null = null;
  private hover: Hit | null = null;
  private frame = 0;
  private width = 0;
  private height = 0;
  private fitted = false;
  private snap = true;
  private sizeKey = "";
  private gestureScale = 1;
  events: LevelViewEvents;
  /** Snaps and clamps a position the way the map does. */
  place: (x: number, z: number) => { x: number; z: number } = (x, z) => ({ x, z });

  constructor(private readonly host: HTMLElement, events: LevelViewEvents) {
    this.events = events;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "level3d__canvas";
    // Throws when the window cannot give us WebGL 2; the caller shows that reason.
    this.renderer = new WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = NeutralToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    host.appendChild(this.canvas);
    this.labels = document.createElement("div");
    this.labels.className = "level3d__labels";
    host.appendChild(this.labels);

    this.controls = new OrbitControls(this.model.camera, this.canvas);
    this.controls.target = this.model.target;
    this.controls.enableDamping = false;
    this.controls.screenSpacePanning = false;
    this.controls.zoomToCursor = true;
    this.controls.minDistance = 2;
    this.controls.maxPolarAngle = 87 * (Math.PI / 180);
    this.controls.addEventListener("change", () => this.requestRender());

    this.on(host, "pointerdown", (e) => this.onDown(e as PointerEvent), true);
    this.on(host, "pointermove", (e) => this.onMove(e as PointerEvent));
    this.on(host, "pointerup", (e) => this.onUp(e as PointerEvent));
    this.on(host, "pointercancel", () => this.cancel());
    this.on(host, "pointerleave", () => this.setHover(null));
    // A trackpad pinch reaches WebKit pages on macOS as gesturestart/gesturechange/gestureend with a
    // running scale, not as wheel events, so OrbitControls never sees it. Without preventDefault the
    // pinch would do nothing at all here.
    this.on(host, "gesturestart", (e) => this.onGesture(e, true));
    this.on(host, "gesturechange", (e) => this.onGesture(e, false));
    this.on(host, "gestureend", (e) => e.preventDefault());
    this.on(this.canvas, "webglcontextlost", () => this.events.contextLost(true));
    this.on(this.canvas, "webglcontextrestored", () => {
      this.events.contextLost(false);
      this.requestRender();
    });

    this.model.onModelLoaded = () => {
      this.requestRender();
      this.runAnimations();
    };
    this.model.modelLoader = (asset, resolve) => loadModelFile(asset, resolve);
    this.model.textureLoader = async (url, srgb) => {
      const { TextureLoader, RepeatWrapping, SRGBColorSpace } = await import("three");
      const t = await new TextureLoader().loadAsync(url);
      t.wrapS = t.wrapT = RepeatWrapping;
      t.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      if (srgb) t.colorSpace = SRGBColorSpace;
      return t;
    };
    this.model.hdrLoader = async (url) => {
      const { HDRLoader } = await import("three/addons/loaders/HDRLoader.js");
      return new HDRLoader().loadAsync(url);
    };

    this.resize = new ResizeObserver(() => this.setSize());
    this.resize.observe(host);
    this.setSize();
  }

  private on(target: EventTarget, type: string, fn: EventListener, capture = false) {
    target.addEventListener(type, fn, capture);
    this.listeners.push([target, type, fn, capture]);
  }

  private setSize() {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (w === 0 || h === 0 || (w === this.width && h === this.height)) return;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    this.model.camera.aspect = w / h;
    this.model.camera.updateProjectionMatrix();
    if (!this.fitted && this.model.world) this.firstFit();
    this.requestRender();
  }

  // ---- what React tells us --------------------------------------------------------------------

  update(world: World, selected: string | null, o: LevelViewOptions) {
    this.snap = o.snap;
    this.model.setAccent(getComputedStyle(this.host).getPropertyValue("--mode-accent") || "#7aa7ff");
    this.model.setOptions({ grid: o.grid, fog: o.fog });
    this.model.sync(world, selected);
    const d = this.drag;
    if (d) this.model.preview(d.id, d.kind === "move" ? { x: d.x, z: d.z } : { x: d.x, z: d.z, rotation: d.rotation });
    const key = `${world.size.width}x${world.size.depth}`;
    if (key !== this.sizeKey) {
      this.sizeKey = key;
      this.controls.maxDistance = Math.max(world.size.width, world.size.depth) * 2.5 + 30;
      this.controls.maxTargetRadius = Math.hypot(world.size.width, world.size.depth) / 2 + 10;
    }
    if (!this.fitted && this.width > 0) this.firstFit();
    this.requestRender();
    this.runAnimations();
  }

  /** Whether characters and animated models move in the view (the toolbar's animation switch). */
  setAnimate(on: boolean) {
    this.animate = on;
    this.runAnimations();
  }

  private animate = true;
  private animFrame = 0;
  private lastTick = 0;
  /** Draws every frame while something is animated (and animation is on); otherwise only on change. */
  private runAnimations() {
    if (this.animFrame || !this.animate || !this.model.animating()) return;
    this.lastTick = 0;
    const step = (t: number) => {
      this.animFrame = 0;
      if (!this.animate || !this.model.animating()) return;
      const dt = this.lastTick ? Math.min(0.1, (t - this.lastTick) / 1000) : 0;
      this.lastTick = t;
      this.model.tick(dt);
      this.render();
      this.animFrame = requestAnimationFrame(step);
    };
    this.animFrame = requestAnimationFrame(step);
  }

  /** The first view: the whole level, centred on the selected object if there is one. */
  private firstFit() {
    this.fit();
    const o = this.model.selectedObject();
    if (o) this.focus(o.x, o.z);
  }

  cameraState(): CameraState {
    const p = this.model.camera.position;
    const t = this.model.target;
    return { position: [p.x, p.y, p.z], target: [t.x, t.y, t.z] };
  }

  /** Puts the camera back where it was the last time this level was open in 3D. */
  restoreCamera(c: CameraState) {
    this.fitted = true;
    this.model.target.set(...c.target);
    this.model.camera.position.set(...c.position);
    this.model.camera.lookAt(this.model.target);
    this.controls.update();
    this.requestRender();
  }

  /** The point the camera looks at, where new objects go when added from the palette. */
  center(): { x: number; z: number } {
    return { x: this.model.target.x, z: this.model.target.z };
  }

  /** Ground position under a point on screen, or null over the sky. */
  groundAt(clientX: number, clientY: number): { x: number; z: number } | null {
    const p = LevelModel.onPlane(this.rayAt(clientX, clientY), 0);
    return p ? { x: p.x, z: p.z } : null;
  }

  fit() {
    this.fitted = true;
    this.model.fit();
    this.controls.update();
    this.requestRender();
  }

  focus(x: number, z: number) {
    this.model.focus(x, z);
    this.controls.update();
    this.requestRender();
  }

  zoom(factor: number) {
    this.model.zoom(factor, this.controls.minDistance, this.controls.maxDistance);
    this.controls.update();
    this.requestRender();
  }

  /**
   * Moves the camera closer (factor < 1) or further away, keeping the ground point under (clientX, clientY)
   * where it is on screen, the way scrolling does. Used for pinches.
   */
  zoomAt(factor: number, clientX: number, clientY: number) {
    const camera = this.model.camera;
    const target = this.model.target;
    const dist = camera.position.distanceTo(target);
    const k = Math.min(this.controls.maxDistance, Math.max(this.controls.minDistance, dist * factor)) / dist;
    if (!Number.isFinite(k) || Math.abs(k - 1) < 1e-6) return;
    let p = LevelModel.onPlane(this.rayAt(clientX, clientY), 0);
    // Near the horizon the ground point runs off towards infinity; zoom towards the middle instead.
    if (!p || p.distanceTo(target) > dist * 3) p = target.clone();
    // Scaling camera and target about p keeps p at the same place on screen.
    camera.position.sub(p).multiplyScalar(k).add(p);
    target.sub(p).multiplyScalar(k).add(p);
    this.controls.update();
    this.requestRender();
  }

  private onGesture(e: Event, start: boolean) {
    e.preventDefault();
    const g = e as Event & { scale?: unknown; clientX?: unknown; clientY?: unknown };
    const scale = typeof g.scale === "number" && g.scale > 0 ? g.scale : 1;
    if (start) this.gestureScale = 1;
    const r = this.canvas.getBoundingClientRect();
    const x = typeof g.clientX === "number" && Number.isFinite(g.clientX) ? g.clientX : r.left + r.width / 2;
    const y = typeof g.clientY === "number" && Number.isFinite(g.clientY) ? g.clientY : r.top + r.height / 2;
    // Fingers apart (scale up) brings the camera closer.
    this.zoomAt(this.gestureScale / scale, x, y);
    this.gestureScale = scale;
  }

  /** Where an object's base appears in the window, for tests and diagnostics. */
  screenPoint(x: number, y: number, z: number): { x: number; y: number } | null {
    this.model.camera.updateMatrixWorld();
    const v = new Vector3(x, y, z);
    if (v.clone().applyMatrix4(this.model.camera.matrixWorldInverse).z >= 0) return null;
    v.project(this.model.camera);
    const r = this.canvas.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }

  /** What the GPU did for the last frame. */
  stats(): { calls: number; triangles: number; renderer: string; lights: number } {
    const gl = this.renderer.getContext();
    const info = this.renderer.info.render;
    return { calls: info.calls, triangles: info.triangles, renderer: String(gl.getParameter(gl.RENDERER) ?? ""), lights: this.model.activeLights().length };
  }

  /** Draws a frame and reads back the pixel under a point on screen: proof that WebGL really drew something. */
  samplePixel(clientX: number, clientY: number): number[] {
    this.render();
    const gl = this.renderer.getContext();
    const r = this.canvas.getBoundingClientRect();
    const x = Math.round((clientX - r.left) * (this.canvas.width / r.width));
    const y = Math.round(this.canvas.height - (clientY - r.top) * (this.canvas.height / r.height));
    const px = new Uint8Array(4);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return Array.from(px);
  }

  /** What is under a point on screen. */
  pickAt(clientX: number, clientY: number): Hit | null {
    return this.model.pick(this.rayAt(clientX, clientY));
  }

  // ---- pointer input -------------------------------------------------------------------------

  private rayAt(clientX: number, clientY: number) {
    const r = this.canvas.getBoundingClientRect();
    return this.model.rayAt(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  }

  private onDown(e: PointerEvent) {
    this.down = null;
    if (e.button !== 0) return; // right and middle buttons pan and zoom
    // Shift, Control or Command with a drag pans the camera, even over an object.
    const hit = e.shiftKey || e.ctrlKey || e.metaKey ? null : this.pickAt(e.clientX, e.clientY);
    this.down = { x: e.clientX, y: e.clientY, pointerId: e.pointerId, onThing: !!hit, moved: false };
    if (!hit) return; // the orbit camera takes it
    e.stopPropagation();
    e.preventDefault();
    try {
      this.host.setPointerCapture(e.pointerId);
    } catch {
      // Pointer events dispatched by the self-test have no live pointer to capture.
    }
    if (hit.kind === "ring") {
      const o = this.model.object(hit.id);
      if (!o) return;
      this.drag = { kind: "turn", id: o.id, pointerId: e.pointerId, x: o.x, z: o.z, startBearing: bearing(o.x, o.z, hit.point.x, hit.point.z), orig: o.rotation, rotation: o.rotation };
    } else {
      const from = hit.kind === "spawn" ? this.model.world?.player.spawn : this.model.object(hit.id);
      if (!from) return;
      if (hit.kind === "object") this.events.select(hit.id);
      this.drag = { kind: "move", id: hit.kind === "spawn" ? SPAWN_ID : hit.id, pointerId: e.pointerId, planeY: Math.max(0, hit.point.y), start: hit.point.clone(), origX: from.x, origZ: from.z, x: from.x, z: from.z };
    }
    this.setCursor("grabbing");
    this.updateLabels();
  }

  private onMove(e: PointerEvent) {
    const down = this.down;
    if (down && e.pointerId === down.pointerId && !down.moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_SLOP) down.moved = true;
    const d = this.drag;
    if (d && e.pointerId === d.pointerId) {
      const ray = this.rayAt(e.clientX, e.clientY);
      if (d.kind === "move") {
        const p = LevelModel.onPlane(ray, d.planeY);
        if (!p) return;
        const at = this.place(d.origX + p.x - d.start.x, d.origZ + p.z - d.start.z);
        d.x = at.x;
        d.z = at.z;
        this.model.preview(d.id, at);
      } else {
        const p = LevelModel.onPlane(ray, RING_Y);
        if (!p) return;
        // Snap the turn, not the result, so it adds whole steps to any starting angle, like Q and E do.
        const turn = bearing(d.x, d.z, p.x, p.z) - d.startBearing;
        const r = normalizeRotation(d.orig + (this.snap ? Math.round(turn / SNAP_DEGREES) * SNAP_DEGREES : turn));
        d.rotation = r;
        this.model.preview(d.id, { x: d.x, z: d.z, rotation: r });
      }
      this.requestRender();
      return;
    }
    if (e.buttons === 0) this.setHover(this.pickAt(e.clientX, e.clientY));
  }

  private onUp(e: PointerEvent) {
    const d = this.drag;
    if (d && e.pointerId === d.pointerId) {
      this.drag = null;
      if (this.host.hasPointerCapture(e.pointerId)) this.host.releasePointerCapture(e.pointerId);
      if (d.kind === "move" && (d.x !== d.origX || d.z !== d.origZ)) this.events.move(d.id, d.x, d.z);
      else if (d.kind === "turn" && d.rotation !== d.orig) this.events.rotate(d.id, d.rotation);
      else this.resetPreview();
    }
    const down = this.down;
    this.down = null;
    // A click on empty ground clears the selection; a drag there only turned the camera.
    if (down && e.pointerId === down.pointerId && !down.onThing && !down.moved) this.events.select(null);
    this.setHover(this.pickAt(e.clientX, e.clientY));
  }

  private cancel() {
    this.drag = null;
    this.down = null;
    this.resetPreview();
  }

  private resetPreview() {
    const w = this.model.world;
    if (w) this.model.sync(w, this.model.selected);
    this.requestRender();
  }

  private setCursor(c: string) {
    this.canvas.style.cursor = c;
  }

  private setHover(hit: Hit | null) {
    this.hover = hit;
    if (!this.drag) this.setCursor(hit ? "grab" : "");
    this.updateLabels();
  }

  // ---- drawing -------------------------------------------------------------------------------

  requestRender() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  /** Draws a frame now (the self-test uses this to read the result straight away). */
  render() {
    if (this.width === 0) return;
    this.model.beforeRender();
    // The realistic style uses a filmic curve made for photographs, as the game does (AgX).
    const toneMapping = this.model.world?.environment.style === "realistic" ? AgXToneMapping : NeutralToneMapping;
    if (this.renderer.toneMapping !== toneMapping) this.renderer.toneMapping = toneMapping;
    if (this.model.anime()) {
      // The anime style's ink outlines (outline.gdshader in the game), for toon materials only.
      this.outlines ??= new OutlineEffect(this.renderer, { defaultThickness: 0.0035 });
      this.outlines.render(this.model.scene, this.model.camera);
    } else {
      this.renderer.render(this.model.scene, this.model.camera);
    }
    this.updateLabels();
  }

  private label(key: string, text: string | null, at: Vector3 | null, kind: string) {
    let el = this.labelEls.get(key);
    if (!text || !at) {
      if (el) el.hidden = true;
      return;
    }
    if (!el) {
      el = document.createElement("div");
      el.className = `level3d__label level3d__label--${kind}`;
      el.dataset["label"] = key;
      this.labels.appendChild(el);
      this.labelEls.set(key, el);
    }
    if (el.textContent !== text) el.textContent = text;
    const cam = this.model.camera;
    const inFront = at.clone().applyMatrix4(cam.matrixWorldInverse).z < 0;
    const p = at.clone().project(cam);
    const visible = inFront && Math.abs(p.x) <= 1.02 && Math.abs(p.y) <= 1.02;
    el.hidden = !visible;
    if (visible) el.style.transform = `translate(${((p.x + 1) / 2) * this.width}px, ${((1 - p.y) / 2) * this.height}px) translate(-50%, -100%)`;
  }

  private updateLabels() {
    const w = this.model.world;
    if (!w || this.width === 0) return;
    this.label("north", "North", new Vector3(0, 0.3, -w.size.depth / 2 - 2), "north");
    const d = this.drag;
    const sel = this.model.selectedObject();
    if (sel) {
      const g = this.model.group(sel.id);
      let text = sel.id;
      if (d?.id === sel.id) text = d.kind === "move" ? `${sel.id} · ${d.x}, ${d.z}` : `${sel.id} · ${d.rotation}°`;
      this.label("selected", text, g ? new Vector3(g.position.x, objectTop(sel) + 0.4, g.position.z) : null, "selected");
    } else {
      this.label("selected", null, null, "selected");
    }
    const spawn = d?.id === SPAWN_ID ? { x: d.x, z: d.z } : w.player.spawn;
    this.label("spawn", d?.id === SPAWN_ID ? `Player start · ${spawn.x}, ${spawn.z}` : null, new Vector3(spawn.x, 2.3, spawn.z), "selected");
    const h = d ? null : this.hover;
    let text: string | null = null;
    let at: Vector3 | null = null;
    if (h?.kind === "ring") {
      text = "Drag to turn";
      at = h.point;
    } else if (h?.kind === "spawn") {
      text = "Player start";
      at = new Vector3(spawn.x, 2.3, spawn.z);
    } else if (h?.kind === "object" && h.id !== sel?.id) {
      const o = this.model.object(h.id);
      if (o) {
        text = o.id;
        at = new Vector3(o.x, objectTop(o) + 0.4, o.z);
      }
    }
    this.label("hover", text, at, "hover");
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.animFrame);
    this.animate = false;
    this.resize.disconnect();
    for (const [target, type, fn, capture] of this.listeners) target.removeEventListener(type, fn, capture);
    this.controls.dispose();
    this.model.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
    this.labels.remove();
  }
}

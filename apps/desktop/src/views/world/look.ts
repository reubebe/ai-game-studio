/**
 * The 3D template's look in the studio's 3D view: the sky with clouds, patches on the ground and tufts
 * of grass, drawn the way the game draws them (templates/exploration-3d/godot: shaders/sky.gdshader,
 * shaders/ground.gdshader, shaders/grass.gdshader and scripts/grass.gd). Keep the noise, the colours,
 * the grass placement and the tuft's shape in step with those files. The maths the game and the studio
 * must share exactly (fog over the sky, the patches, grass placement) is in @gamestudio/explore (look.ts).
 */
import { BufferAttribute, BufferGeometry, Color, DataTexture, DynamicDrawUsage, InstancedMesh, Matrix4, MeshStandardMaterial, MeshToonMaterial, NearestFilter, Quaternion, RedFormat, ShaderMaterial, Vector2, Vector3, BackSide, type Material, type Mesh, type Object3D } from "three";
import { grassKeepOut, hash2, patches, placeTufts, skyFog, smoothstep, type World } from "@gamestudio/explore";

const fract = (x: number) => x - Math.floor(x);


/** One tuft: nine thin blades leaning out from a small circle, darker at the foot (grass.gd, tuft_mesh). */
export function tuftGeometry(): BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * Math.PI * 2 + 0.4 * Math.sin(k * 2.3);
    const dir = new Vector3(Math.cos(a), 0, Math.sin(a));
    const side = new Vector3(-dir.z, 0, dir.x);
    const h = 0.26 + 0.22 * fract(k * 0.618);
    const foot = dir.clone().multiplyScalar(0.04 + 0.05 * fract(k * 0.43));
    const w = 0.03;
    const tip = foot.clone().addScaledVector(dir, 0.1 + 0.08 * fract(k * 0.37)).add(new Vector3(0, h, 0)).addScaledVector(side, 0.03);
    const l = foot.clone().addScaledVector(side, -w);
    const r = foot.clone().addScaledVector(side, w);
    pos.push(l.x, l.y, l.z, r.x, r.y, r.z, tip.x, tip.y, tip.z);
    // grass.gdshader: mix(under * 0.62, under * (1.28, 1.24, 0.98), UV.y)
    col.push(0.62, 0.62, 0.62, 0.62, 0.62, 0.62, 1.28, 1.24, 0.98);
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  // Lit like the ground it grows from.
  g.setAttribute("normal", new BufferAttribute(new Float32Array(pos.map((_, n) => (n % 3 === 1 ? 1 : 0))), 3));
  g.setAttribute("color", new BufferAttribute(new Float32Array(col), 3));
  return g;
}

/** The colour of the ground under a point (linear), with the level's patches: ground.gdshader's patchy() without the mottle. */
export function groundUnder(ground: Color, x: number, z: number, variation: number): Color {
  const n = smoothstep(0.3, 0.7, patches(x, z));
  const lush = [0.76, 0.88, 0.8];
  const dry = [1.32, 1.18, 0.78];
  const c = ground.clone();
  const k = [c.r, c.g, c.b].map((v, i) => {
    const mixed = v * (lush[i]! + (dry[i]! - lush[i]!) * n);
    return v + (mixed - v) * variation;
  });
  return new Color(k[0]!, k[1]!, k[2]!);
}

/** The level's grass as one instanced mesh, or null when it has none. */
export function grassMesh(world: World, geometry: BufferGeometry, material: MeshStandardMaterial): InstancedMesh | null {
  const e = world.environment;
  const density = e.grass ?? 0;
  if (density <= 0) return null;
  const variation = e.groundVariation ?? 0;
  const tufts = placeTufts(world.size.width, world.size.depth, density, variation, grassKeepOut(world));
  if (!tufts.length) return null;
  const mesh = new InstancedMesh(geometry, material, tufts.length);
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  const ground = new Color(e.ground);
  const m = new Matrix4();
  const q = new Quaternion();
  const up = new Vector3(0, 1, 0);
  tufts.forEach(([x, z, turn, size], n) => {
    m.compose(new Vector3(x, 0, z), q.setFromAxisAngle(up, turn), new Vector3(size, size, size));
    mesh.setMatrixAt(n, m);
    // grass.gdshader: each tuft a shade different, coloured like the ground under it.
    const shade = 0.9 + hash2(x * 0.37, z * 0.37) * 0.22;
    mesh.setColorAt(n, groundUnder(ground, x, z, variation).multiplyScalar(shade));
  });
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.name = "grass";
  return mesh;
}

// ---- Shaders ------------------------------------------------------------------------------------

const GLSL_NOISE = /* glsl */ `
float gsHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float gsValueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = gsHash(i);
  float b = gsHash(i + vec2(1.0, 0.0));
  float c = gsHash(i + vec2(0.0, 1.0));
  float d = gsHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
`;

/** Patches on the ground (ground.gdshader's patchy()), added to the 3D view's ground material. */
export function patchGround(material: MeshStandardMaterial): { variation: { value: number } } {
  const variation = { value: 0 };
  material.onBeforeCompile = (shader) => {
    shader.uniforms["gsVariation"] = variation;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vGsWorld;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvGsWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
varying vec3 vGsWorld;
uniform float gsVariation;
${GLSL_NOISE}
float gsPatches(vec2 xz) {
  vec2 p = xz / 16.0;
  return gsValueNoise(p) * 0.6 + gsValueNoise(p * 2.7 + 7.1) * 0.28 + gsValueNoise(p * 7.3 + 3.7) * 0.12;
}
vec3 gsPatchy(vec3 base, vec2 xz, float dist) {
  float n = smoothstep(0.3, 0.7, gsPatches(xz));
  vec3 lush = base * vec3(0.76, 0.88, 0.8);
  vec3 dry = base * vec3(1.32, 1.18, 0.78);
  float mottle = (gsValueNoise(xz / 2.3 + 31.0) - 0.5) * 0.16 * clamp(1.0 - dist / 45.0, 0.0, 1.0);
  return mix(base, mix(lush, dry, n) * (1.0 + mottle), gsVariation);
}`,
      )
      .replace("#include <color_fragment>", "#include <color_fragment>\nif (gsVariation > 0.0) diffuseColor.rgb = gsPatchy(diffuseColor.rgb, vGsWorld.xz, length(vGsWorld - cameraPosition));");
  };
  material.customProgramCacheKey = () => "gs-ground-patches";
  return { variation };
}

/** The sky (sky.gdshader): Godot's procedural sky gradient and sun, clouds, and fog over it. */
export function skyMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    uniforms: {
      skyTop: { value: new Color("#2f63a8") },
      skyHorizon: { value: new Color("#b8d4ec") },
      groundBottom: { value: new Color("#33402e") },
      sunDir: { value: new Vector3(0, 1, 0) },
      sunColor: { value: new Color("#ffffff") },
      clouds: { value: 0 },
      cloudOffset: { value: new Vector2(0, 11) },
      fogColor: { value: new Color("#b8d4ec") },
      fogAmount: { value: 0 },
      anime: { value: 0 },
    },
    vertexShader: /* glsl */ `
varying vec3 vWorld;
void main() {
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`,
    fragmentShader: /* glsl */ `
uniform vec3 skyTop;
uniform vec3 skyHorizon;
uniform vec3 groundBottom;
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform float clouds;
uniform vec2 cloudOffset;
uniform vec3 fogColor;
uniform float fogAmount;
uniform float anime;
varying vec3 vWorld;
${GLSL_NOISE}
float gsFbm(vec2 p) {
  float total = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 5; i++) {
    total += gsValueNoise(p) * amp;
    p = p * 2.03 + vec2(17.0, 9.0);
    amp *= 0.5;
  }
  return total / 0.96875;
}
void main() {
  vec3 dir = normalize(vWorld - cameraPosition);
  float v = clamp(dir.y, -1.0, 1.0);
  vec3 sky = mix(skyTop, skyHorizon, clamp(pow(1.0 - v, 4.0), 0.0, 1.0));
  float sunAngle = dot(sunDir, dir);
  float sunAmount = 0.0;
  if (sunAngle > 0.866) {
    float c2 = (1.0 - sunAngle) / (1.0 - 0.866);
    sunAmount = clamp(pow(1.0 - c2, 22.76), 0.0, 1.0);
  }
  if (clouds > 0.0 && dir.y > 0.0) {
    vec2 p = dir.xz / (dir.y + 0.12) * 1.6 + cloudOffset;
    float d = gsFbm(p);
    float threshold = mix(0.72, 0.28, clouds);
    float alpha = smoothstep(threshold, threshold + mix(0.22, 0.045, anime), d) * smoothstep(0.0, 0.14, dir.y);
    float thick = clamp((d - threshold) * 2.2, 0.0, 1.0);
    vec3 lit = mix(vec3(1.0), sunColor, 0.3);
    vec3 shade = mix(skyHorizon, skyTop, 0.35) * 0.82;
    vec3 animeShade = mix(skyTop, vec3(1.0), 0.55) * vec3(0.93, 0.92, 1.0);
    float shadeAmount = mix(thick * 0.75, smoothstep(0.4, 0.48, thick) * 0.85, anime);
    vec3 cloud = mix(lit, mix(shade, animeShade, anime), shadeAmount);
    cloud += sunColor * pow(max(sunAngle, 0.0), 12.0) * 0.6 * (1.0 - thick);
    sky = mix(sky, cloud, alpha * 0.92);
    sunAmount *= 1.0 - alpha * 0.85;
  }
  sky = mix(sky, sunColor, sunAmount);
  vec3 ground = mix(groundBottom, skyHorizon, clamp(pow(1.0 + v, 30.0), 0.0, 1.0));
  vec3 col = mix(ground, sky, step(0.0, dir.y));
  col = mix(col, fogColor, fogAmount);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
  });
}

/** Sets the sky's colours, sun, clouds and fog from the level (world_builder.gd, _apply_environment). */
export function updateSky(material: ShaderMaterial, world: World, sunDir: Vector3, fog: boolean): void {
  const e = world.environment;
  const u = material.uniforms;
  (u["skyTop"]!.value as Color).set(e.skyTop);
  (u["skyHorizon"]!.value as Color).set(e.skyHorizon);
  // Below the horizon the 3D view keeps its own darker surround (the game's is the ground colour darkened
  // by 40%, seen only past the level's edge; from above, the editor shows a lot of it).
  (u["groundBottom"]!.value as Color).set(e.ground).multiplyScalar(0.25).lerp(new Color(e.skyHorizon), 0.15);
  (u["sunDir"]!.value as Vector3).copy(sunDir).normalize();
  (u["sunColor"]!.value as Color).set(e.sunColor ?? "#ffffff");
  u["clouds"]!.value = e.clouds ?? 0;
  (u["cloudOffset"]!.value as Vector2).set(e.sunHeading * 0.37, 11);
  (u["fogColor"]!.value as Color).set(e.skyHorizon);
  u["fogAmount"]!.value = fog && e.fogDensity > 0 ? skyFog(e.fogDensity) : 0;
  u["anime"]!.value = e.style === "anime" ? 1 : 0;
}

// ---- The anime style (style.gd) -------------------------------------------------------------

/** The ink colour of outlines.gdshader, as OutlineEffect takes it. */
const INK = [0.1, 0.08, 0.13];

/** One crisp step between shade and light, like Godot's toon diffuse at the style's low roughness. */
function toonGradient(): DataTexture {
  const t = new DataTexture(new Uint8Array([0, 255]), 2, 1, RedFormat);
  t.minFilter = NearestFilter;
  t.magFilter = NearestFilter;
  t.needsUpdate = true;
  return t;
}

/**
 * The anime style in the 3D view: plain object materials become toon materials (a crisp line between light
 * and shade, no gloss) and are the only ones OutlineEffect outlines; glowing and see-through parts keep their
 * look, as in style.gd. Textured parts keep their texture projection and get the outline only.
 */
export class Restyler {
  private readonly toon = new Map<Material, Material>();
  private readonly original = new Map<Material, Material>();
  private readonly gradient = toonGradient();

  /** Restyles the meshes under root for the anime style, or puts the standard materials back. */
  apply(root: Object3D, anime: boolean): void {
    root.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => this.swap(m, anime)) : this.swap(mesh.material, anime);
    });
  }

  /** Whether a material is one the style made (or outlines). */
  outlined(m: Material): boolean {
    return (m.userData["outlineParameters"] as { visible?: boolean } | undefined)?.visible === true;
  }

  /** Keeps everything else in the scene (ground, grass, water, sky, editor aids) out of the outline pass. */
  outlineOnlyStyled(scene: Object3D): void {
    scene.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (!m.userData["outlineParameters"]) m.userData["outlineParameters"] = { visible: false };
      }
    });
  }

  private swap(m: Material, anime: boolean): Material {
    if (!anime) return this.original.get(m) ?? m;
    if (this.original.has(m)) return m;
    const done = this.toon.get(m);
    if (done) return done;
    const s = m as MeshStandardMaterial;
    const glowing = Boolean(s.emissive) && s.emissive.getHex() !== 0 && s.emissiveIntensity >= 0.45;
    let out: Material = m;
    if (!s.isMeshStandardMaterial || s.transparent || glowing) {
      m.userData["outlineParameters"] = { visible: false };
    } else if (s.customProgramCacheKey !== MeshStandardMaterial.prototype.customProgramCacheKey) {
      // A projected texture (level3d.ts, triplanar): keep it, add the outline.
      m.userData["outlineParameters"] = { thickness: 0.0035, color: INK, alpha: 1, visible: true };
    } else {
      const t = new MeshToonMaterial({ color: s.color, map: s.map, gradientMap: this.gradient, vertexColors: s.vertexColors, side: s.side, emissive: s.emissive, emissiveIntensity: s.emissiveIntensity, emissiveMap: s.emissiveMap, normalMap: s.normalMap, alphaTest: s.alphaTest });
      t.name = `toon:${s.name}`;
      t.userData["outlineParameters"] = { thickness: 0.0035, color: INK, alpha: 1, visible: true };
      this.original.set(t, m);
      out = t;
    }
    this.toon.set(m, out);
    return out;
  }

  dispose(): void {
    for (const t of this.original.keys()) t.dispose();
    this.gradient.dispose();
  }
}

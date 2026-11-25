import { crc32, deflateSync } from "node:zlib";

/**
 * Small, valid asset files for tests: a binary glTF (GLB) box and a PNG. They let the real-engine
 * tests import and place genuine model and texture files without downloading anything.
 */

/** A box `w` x `h` x `d` metres standing on its origin, one colour, as a GLB file. */
export function boxGlb(w = 2, h = 1.5, d = 2, color: [number, number, number] = [0.8, 0.5, 0.2]): Uint8Array {
  const [x0, x1, y0, y1, z0, z1] = [-w / 2, w / 2, 0, h, -d / 2, d / 2];
  // Six faces, four corners each, with outward normals.
  const faces: [number[][], number[]][] = [
    [[[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], [1, 0, 0]],
    [[[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]], [-1, 0, 0]],
    [[[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], [0, 1, 0]],
    [[[x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1]], [0, -1, 0]],
    [[[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1]],
    [[[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1]],
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  faces.forEach(([corners, n], f) => {
    for (const c of corners) {
      positions.push(...c);
      normals.push(...n);
    }
    const b = f * 4;
    indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  const pos = new Float32Array(positions);
  const nor = new Float32Array(normals);
  const idx = new Uint16Array(indices);
  const bin = new Uint8Array(pos.byteLength + nor.byteLength + idx.byteLength + 2);
  bin.set(new Uint8Array(pos.buffer), 0);
  bin.set(new Uint8Array(nor.buffer), pos.byteLength);
  bin.set(new Uint8Array(idx.buffer), pos.byteLength + nor.byteLength);
  const json = {
    asset: { version: "2.0", generator: "Game Studio tests" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: "Box" }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [...color, 1], metallicFactor: 0, roughnessFactor: 0.8 } }],
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.byteLength, target: 34962 },
      { buffer: 0, byteOffset: pos.byteLength, byteLength: nor.byteLength, target: 34962 },
      { buffer: 0, byteOffset: pos.byteLength + nor.byteLength, byteLength: idx.byteLength, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 24, type: "VEC3", min: [x0, y0, z0], max: [x1, y1, z1] },
      { bufferView: 1, componentType: 5126, count: 24, type: "VEC3" },
      { bufferView: 2, componentType: 5123, count: 36, type: "SCALAR" },
    ],
  };
  let text = JSON.stringify(json);
  while (text.length % 4) text += " ";
  const jsonBytes = new TextEncoder().encode(text);
  const total = 12 + 8 + jsonBytes.byteLength + 8 + bin.byteLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); // "glTF"
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.byteLength, true);
  view.setUint32(16, 0x4e4f534a, true); // "JSON"
  out.set(jsonBytes, 20);
  const binAt = 20 + jsonBytes.byteLength;
  view.setUint32(binAt, bin.byteLength, true);
  view.setUint32(binAt + 4, 0x004e4942, true); // "BIN"
  out.set(bin, binAt + 8);
  return out;
}

/** A `size` x `size` RGB PNG checkerboard of two colours. */
export function checkerPng(size = 64, a: [number, number, number] = [90, 125, 60], b: [number, number, number] = [70, 100, 45]): Uint8Array {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const c = ((x >> 3) + (y >> 3)) % 2 ? a : b;
      raw.set(c, y * (size * 3 + 1) + 1 + x * 3);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}

/**
 * A tiny skinned, animated character as a GLB: a 0.6 x 1.8 x 0.4 m body on two bones (Hips at the
 * feet, Chest at 0.9 m), facing +Z like glTF characters. Each named clip lasts one second: the chest
 * leans (more for Walk and Run) and Jump lifts the hips. Tests use it to check that engines import the
 * skeleton and play animations by name.
 */
export function characterGlb(clips: string[] = ["Idle", "Walk", "Run", "Jump"]): Uint8Array {
  const parts: { bytes: Uint8Array; target?: number }[] = [];
  const views: Record<string, unknown>[] = [];
  const accessors: Record<string, unknown>[] = [];
  let offset = 0;
  const add = (bytes: Uint8Array, accessor: Record<string, unknown>, target?: number): number => {
    const pad = (4 - (offset % 4)) % 4;
    if (pad) parts.push({ bytes: new Uint8Array(pad) });
    offset += pad;
    views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength, ...(target ? { target } : {}) });
    parts.push({ bytes });
    offset += bytes.byteLength;
    accessors.push({ bufferView: views.length - 1, ...accessor });
    return accessors.length - 1;
  };
  const f32 = (a: number[]) => new Uint8Array(new Float32Array(a).buffer);
  // The body: a box from y = 0 to 1.8, bottom corners on the hips, top corners on the chest.
  const [w, h, d] = [0.3, 1.8, 0.2];
  const faces: [number[][], number[]][] = [
    [[[w, 0, -d], [w, h, -d], [w, h, d], [w, 0, d]], [1, 0, 0]],
    [[[-w, 0, d], [-w, h, d], [-w, h, -d], [-w, 0, -d]], [-1, 0, 0]],
    [[[-w, h, -d], [-w, h, d], [w, h, d], [w, h, -d]], [0, 1, 0]],
    [[[-w, 0, d], [-w, 0, -d], [w, 0, -d], [w, 0, d]], [0, -1, 0]],
    [[[-w, 0, d], [w, 0, d], [w, h, d], [-w, h, d]], [0, 0, 1]],
    [[[w, 0, -d], [-w, 0, -d], [-w, h, -d], [w, h, -d]], [0, 0, -1]],
  ];
  const pos: number[] = [];
  const nor: number[] = [];
  const joints: number[] = [];
  const weights: number[] = [];
  const idx: number[] = [];
  faces.forEach(([corners, n], f) => {
    for (const c of corners) {
      pos.push(...c);
      nor.push(...n);
      joints.push(c[1]! > 0.9 ? 1 : 0, 0, 0, 0);
      weights.push(1, 0, 0, 0);
    }
    idx.push(f * 4, f * 4 + 1, f * 4 + 2, f * 4, f * 4 + 2, f * 4 + 3);
  });
  const aPos = add(f32(pos), { componentType: 5126, count: 24, type: "VEC3", min: [-w, 0, -d], max: [w, h, d] }, 34962);
  const aNor = add(f32(nor), { componentType: 5126, count: 24, type: "VEC3" }, 34962);
  const aJoints = add(new Uint8Array(joints), { componentType: 5121, count: 24, type: "VEC4" }, 34962);
  const aWeights = add(f32(weights), { componentType: 5126, count: 24, type: "VEC4" }, 34962);
  const aIdx = add(new Uint8Array(new Uint16Array(idx).buffer), { componentType: 5123, count: 36, type: "SCALAR" }, 34963);
  // Inverse bind matrices (column-major): the hips at the origin, the chest 0.9 m up.
  const ibm = add(f32([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -0.9, 0, 1]), { componentType: 5126, count: 2, type: "MAT4" });
  const times = add(f32([0, 0.5, 1]), { componentType: 5126, count: 3, type: "SCALAR", min: [0], max: [1] });
  const lean = (deg: number) => {
    const r = (deg * Math.PI) / 360;
    return [0, 0, 0, 1, Math.sin(r), 0, 0, Math.cos(r), 0, 0, 0, 1];
  };
  const animations = clips.map((name, i) => {
    const amount = /walk/i.test(name) ? 20 : /run/i.test(name) ? 35 : /jump/i.test(name) ? 10 : 6 + i;
    const rot = add(f32(lean(amount)), { componentType: 5126, count: 3, type: "VEC4" });
    const channels: Record<string, unknown>[] = [{ sampler: 0, target: { node: 2, path: "rotation" } }];
    const samplers: Record<string, unknown>[] = [{ input: times, output: rot, interpolation: "LINEAR" }];
    if (/jump/i.test(name)) {
      samplers.push({ input: times, output: add(f32([0, 0, 0, 0, 0.5, 0, 0, 0, 0]), { componentType: 5126, count: 3, type: "VEC3" }), interpolation: "LINEAR" });
      channels.push({ sampler: 1, target: { node: 1, path: "translation" } });
    }
    return { name, channels, samplers };
  });
  const json = {
    asset: { version: "2.0", generator: "Game Studio tests" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: "Character", children: [1, 3] },
      { name: "Hips", children: [2] },
      { name: "Chest", translation: [0, 0.9, 0] },
      { name: "Body", mesh: 0, skin: 0 },
    ],
    skins: [{ joints: [1, 2], inverseBindMatrices: ibm, skeleton: 1 }],
    meshes: [{ primitives: [{ attributes: { POSITION: aPos, NORMAL: aNor, JOINTS_0: aJoints, WEIGHTS_0: aWeights }, indices: aIdx, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.25, 0.55, 0.85, 1], metallicFactor: 0, roughnessFactor: 0.7 } }],
    animations,
    buffers: [{ byteLength: 0 }],
    bufferViews: views,
    accessors,
  };
  const bin = new Uint8Array(offset + ((4 - (offset % 4)) % 4));
  let at = 0;
  for (const p of parts) {
    bin.set(p.bytes, at);
    at += p.bytes.byteLength;
  }
  json.buffers[0]!.byteLength = bin.byteLength;
  return glb(json, bin);
}

function glb(json: unknown, bin: Uint8Array): Uint8Array {
  let text = JSON.stringify(json);
  while (text.length % 4) text += " ";
  const jsonBytes = new TextEncoder().encode(text);
  const total = 12 + 8 + jsonBytes.byteLength + 8 + bin.byteLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.byteLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  const binAt = 20 + jsonBytes.byteLength;
  view.setUint32(binAt, bin.byteLength, true);
  view.setUint32(binAt + 4, 0x004e4942, true);
  out.set(bin, binAt + 8);
  return out;
}

/**
 * A sprite sheet PNG of `frames` equal frames in one row, each `w` x `h` pixels: a figure with a
 * different colour per frame on a transparent background, so tests can tell frames apart.
 */
export function spriteSheetPng(frames = 4, w = 16, h = 24): Uint8Array {
  const colours: [number, number, number][] = [[230, 120, 60], [60, 160, 230], [90, 200, 120], [220, 200, 60], [180, 90, 200], [240, 80, 120]];
  const width = frames * w;
  const raw = Buffer.alloc((width * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (width * 4 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const f = Math.floor(x / w);
      const lx = x % w;
      const inside = lx >= 3 && lx < w - 3 && y >= 2;
      const c = colours[f % colours.length]!;
      raw.set(inside ? [...c, 255] : [0, 0, 0, 0], y * (width * 4 + 1) + 1 + x * 4);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}

/** A mono 16-bit WAV of a sine tone: `seconds` long at `hz`. */
export function toneWav(seconds = 0.5, hz = 440, rate = 22050): Uint8Array {
  const count = Math.round(seconds * rate);
  const out = Buffer.alloc(44 + count * 2);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + count * 2, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) out.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 12000), 44 + i * 2);
  return new Uint8Array(out);
}

/**
 * A tiny photographed-sky stand-in: a Radiance .hdr panorama (4 x 2, flat RGBE scanlines, which readers
 * take for widths under 8), blue above and green below, with light values up to 1.8 as a real sky has.
 */
export function skyHdr(): Uint8Array {
  const w = 4;
  const h = 2;
  const header = `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${h} +X ${w}\n`;
  const rgbe = (r: number, g: number, b: number): number[] => {
    const max = Math.max(r, g, b);
    const e = Math.ceil(Math.log2(max));
    const f = 256 / 2 ** e;
    return [Math.min(255, Math.floor(r * f)), Math.min(255, Math.floor(g * f)), Math.min(255, Math.floor(b * f)), e + 128];
  };
  const rows = [rgbe(0.6, 1.0, 1.8), rgbe(0.25, 0.4, 0.15)];
  const px: number[] = [];
  for (const row of rows) for (let x = 0; x < w; x++) px.push(...row);
  const head = new TextEncoder().encode(header);
  const out = new Uint8Array(head.length + px.length);
  out.set(head, 0);
  out.set(px, head.length);
  return out;
}

/**
 * A small VRM 1.0 humanoid (a .vrm file: glTF with the VRMC_vrm extension) in a T-pose facing +Z: hips,
 * spine, chest, neck, head, both legs with feet and both arms with hands, about 1.6 m tall, with a box on
 * each bone skinned to it and no animations. Tests use it to check that VRM characters import and get
 * Game Studio's humanoid clips.
 */
export function humanoidVrm(): Uint8Array {
  // [name, parent index, offset from the parent]
  const skeleton: [string, number, [number, number, number]][] = [
    ["hips", -1, [0, 0.9, 0]],
    ["spine", 0, [0, 0.1, 0]],
    ["chest", 1, [0, 0.15, 0]],
    ["neck", 2, [0, 0.2, 0]],
    ["head", 3, [0, 0.1, 0]],
    ["leftUpperLeg", 0, [0.1, -0.05, 0]],
    ["leftLowerLeg", 5, [0, -0.42, 0]],
    ["leftFoot", 6, [0, -0.4, 0]],
    ["rightUpperLeg", 0, [-0.1, -0.05, 0]],
    ["rightLowerLeg", 8, [0, -0.42, 0]],
    ["rightFoot", 9, [0, -0.4, 0]],
    ["leftUpperArm", 2, [0.18, 0.15, 0]],
    ["leftLowerArm", 11, [0.27, 0, 0]],
    ["leftHand", 12, [0.24, 0, 0]],
    ["rightUpperArm", 2, [-0.18, 0.15, 0]],
    ["rightLowerArm", 14, [-0.27, 0, 0]],
    ["rightHand", 15, [-0.24, 0, 0]],
  ];
  const world: [number, number, number][] = [];
  skeleton.forEach(([, parent, o], i) => {
    const p = parent >= 0 ? world[parent]! : [0, 0, 0];
    world[i] = [p[0]! + o[0], p[1]! + o[1], p[2]! + o[2]];
  });
  const parts: Uint8Array[] = [];
  const views: Record<string, unknown>[] = [];
  const accessors: Record<string, unknown>[] = [];
  let offset = 0;
  const add = (bytes: Uint8Array, accessor: Record<string, unknown>, target?: number): number => {
    const pad = (4 - (offset % 4)) % 4;
    if (pad) parts.push(new Uint8Array(pad));
    offset += pad;
    views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength, ...(target ? { target } : {}) });
    parts.push(bytes);
    offset += bytes.byteLength;
    accessors.push({ bufferView: views.length - 1, ...accessor });
    return accessors.length - 1;
  };
  const f32 = (a: number[]) => new Uint8Array(new Float32Array(a).buffer);
  // A 6 cm box at each bone, skinned to that bone.
  const s = 0.03;
  const pos: number[] = [];
  const nor: number[] = [];
  const joints: number[] = [];
  const weights: number[] = [];
  const idx: number[] = [];
  const faces: [number[][], number[]][] = [
    [[[s, -s, -s], [s, s, -s], [s, s, s], [s, -s, s]], [1, 0, 0]],
    [[[-s, -s, s], [-s, s, s], [-s, s, -s], [-s, -s, -s]], [-1, 0, 0]],
    [[[-s, s, -s], [-s, s, s], [s, s, s], [s, s, -s]], [0, 1, 0]],
    [[[-s, -s, s], [-s, -s, -s], [s, -s, -s], [s, -s, s]], [0, -1, 0]],
    [[[-s, -s, s], [s, -s, s], [s, s, s], [-s, s, s]], [0, 0, 1]],
    [[[s, -s, -s], [-s, -s, -s], [-s, s, -s], [s, s, -s]], [0, 0, -1]],
  ];
  world.forEach((w, b) => {
    faces.forEach(([corners, n]) => {
      const base = pos.length / 3;
      for (const c of corners) {
        pos.push(w[0] + c[0]!, w[1] + c[1]!, w[2] + c[2]!);
        nor.push(...n);
        joints.push(b, 0, 0, 0);
        weights.push(1, 0, 0, 0);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    });
  });
  const count = pos.length / 3;
  const xs = pos.filter((_, i) => i % 3 === 0);
  const ys = pos.filter((_, i) => i % 3 === 1);
  const zs = pos.filter((_, i) => i % 3 === 2);
  const aPos = add(f32(pos), { componentType: 5126, count, type: "VEC3", min: [Math.min(...xs), Math.min(...ys), Math.min(...zs)], max: [Math.max(...xs), Math.max(...ys), Math.max(...zs)] }, 34962);
  const aNor = add(f32(nor), { componentType: 5126, count, type: "VEC3" }, 34962);
  const aJoints = add(new Uint8Array(joints), { componentType: 5121, count, type: "VEC4" }, 34962);
  const aWeights = add(f32(weights), { componentType: 5126, count, type: "VEC4" }, 34962);
  const aIdx = add(new Uint8Array(new Uint16Array(idx).buffer), { componentType: 5123, count: idx.length, type: "SCALAR" }, 34963);
  const ibm = add(f32(world.flatMap((w) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -w[0], -w[1], -w[2], 1])), { componentType: 5126, count: world.length, type: "MAT4" });
  // Node 0 is the root; bone i is node i + 1; the body mesh comes last.
  const nodes: Record<string, unknown>[] = [{ name: "Root", children: [1, skeleton.length + 1] }];
  skeleton.forEach(([name, , o], i) => {
    const children = skeleton.map((b, j) => (b[1] === i ? j + 1 : -1)).filter((j) => j > 0);
    nodes.push({ name: name[0]!.toUpperCase() + name.slice(1), translation: o, ...(children.length ? { children } : {}) });
  });
  nodes.push({ name: "Body", mesh: 0, skin: 0 });
  const humanBones = Object.fromEntries(skeleton.map(([name], i) => [name, { node: i + 1 }]));
  const json = {
    asset: { version: "2.0", generator: "Game Studio tests" },
    extensionsUsed: ["VRMC_vrm"],
    extensions: {
      VRMC_vrm: {
        specVersion: "1.0",
        meta: {
          name: "Test Humanoid",
          version: "1",
          authors: ["Game Studio tests"],
          licenseUrl: "https://vrm.dev/licenses/1.0/",
          avatarPermission: "everyone",
          commercialUsage: "personalNonProfit",
          allowExcessivelyViolentUsage: false,
          allowExcessivelySexualUsage: false,
          allowPoliticalOrReligiousUsage: false,
          allowAntisocialOrHateUsage: false,
          creditNotation: "required",
          allowRedistribution: false,
          modification: "prohibited",
        },
        humanoid: { humanBones },
      },
    },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes,
    skins: [{ joints: skeleton.map((_, i) => i + 1), inverseBindMatrices: ibm, skeleton: 1 }],
    meshes: [{ primitives: [{ attributes: { POSITION: aPos, NORMAL: aNor, JOINTS_0: aJoints, WEIGHTS_0: aWeights }, indices: aIdx, material: 0 }] }],
    materials: [{ name: "Skin", pbrMetallicRoughness: { baseColorFactor: [0.9, 0.75, 0.65, 1], metallicFactor: 0, roughnessFactor: 0.8 } }],
    buffers: [{ byteLength: 0 }],
    bufferViews: views,
    accessors,
  };
  const bin = new Uint8Array(offset + ((4 - (offset % 4)) % 4));
  let at = 0;
  for (const p of parts) {
    bin.set(p, at);
    at += p.byteLength;
  }
  json.buffers[0]!.byteLength = bin.byteLength;
  return glb(json, bin);
}

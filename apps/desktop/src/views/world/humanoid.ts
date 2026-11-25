/**
 * Walking, running, standing and jumping for humanoid characters that come without them (VRoid and other
 * VRM characters), as three.js clips the 3D view plays like any model's own. The poses are the game's
 * (templates/exploration-3d/godot/scripts/humanoid_poses.json) and the maths is humanoid.gd's: each bone
 * turns about the character's own axes (left, up, forward, measured from its skeleton) starting from its
 * T-pose, and the turns add up down the chain. Keep this file in step with humanoid.gd.
 */
import { AnimationClip, Matrix3, Matrix4, Quaternion, QuaternionKeyframeTrack, Vector3, VectorKeyframeTrack, type Object3D } from "three";
import poses from "../../../../../templates/exploration-3d/godot/scripts/humanoid_poses.json";

type Turn = [string, number, number, number, number, number?];
interface ClipSpec {
  length: number;
  loop: boolean;
  hips?: Record<string, [number, number, number, number]>;
  bones: Record<string, Turn[]>;
}
const CLIPS = (poses as unknown as { clips: Record<string, ClipSpec> }).clips;

/** Bones a skeleton needs for the clips to fit (humanoid.gd, NEEDED), by the humanoid profile's names. */
export const HUMANOID_NEEDED = ["Hips", "Spine", "Head", "LeftUpperLeg", "LeftLowerLeg", "RightUpperLeg", "RightLowerLeg", "LeftUpperArm", "LeftLowerArm", "RightUpperArm", "RightLowerArm"];
/** Samples per second written into each clip (humanoid.gd, RATE). */
const RATE = 30;

/** The names of the clips made for humanoid characters. */
export const HUMANOID_CLIPS = Object.keys(CLIPS);

interface Frame {
  left: Vector3;
  up: Vector3;
  forward: Vector3;
  leg: number;
}

function angle(spec: Turn, t: number, length: number): number {
  let a = spec[1] + spec[2] * Math.sin(Math.PI * 2 * ((spec[4] * t) / length + spec[3]));
  if (spec.length > 5 && spec[5] !== undefined) a = Math.max(a, spec[5]);
  return (a * Math.PI) / 180;
}

/** The bone's own turn at time t: its listed turns about the character's axes, in order. */
function own(turns: Turn[], frame: Frame, t: number, length: number): Quaternion {
  let q = new Quaternion();
  for (const spec of turns) {
    const axis = (frame as unknown as Record<string, Vector3>)[spec[0]] ?? frame.up;
    q = new Quaternion().setFromAxisAngle(axis, angle(spec, t, length)).multiply(q);
  }
  return q;
}

/**
 * Clips for a humanoid model: `bones` maps humanoid profile names (Hips, LeftUpperLeg, ...) to the model's
 * nodes. Empty when a needed bone is missing. Turns are worked out in `root`'s own space.
 */
export function humanoidClips(root: Object3D, bones: Partial<Record<string, Object3D>>): AnimationClip[] {
  if (HUMANOID_NEEDED.some((b) => !bones[b])) return [];
  root.updateMatrixWorld(true);
  const toRoot = root.matrixWorld.clone().invert();
  const inRoot = (o: Object3D) => new Matrix4().multiplyMatrices(toRoot, o.matrixWorld);
  const restQ = (o: Object3D) => {
    const q = new Quaternion();
    inRoot(o).decompose(new Vector3(), q, new Vector3());
    return q;
  };
  const restP = (o: Object3D) => new Vector3().setFromMatrixPosition(inRoot(o));
  const up = restP(bones["Head"]!).sub(restP(bones["Hips"]!)).normalize();
  const left = restP(bones["LeftUpperLeg"]!).sub(restP(bones["RightUpperLeg"]!));
  left.addScaledVector(up, -left.dot(up)).normalize();
  const forward = new Vector3().crossVectors(left, up).normalize();
  const leg = Math.max(restP(bones["Hips"]!).distanceTo(restP(bones["LeftFoot"] ?? bones["LeftLowerLeg"]!)), 0.01);
  const frame: Frame = { left, up, forward, leg };
  const nameOf = new Map<Object3D, string>();
  for (const [n, o] of Object.entries(bones)) if (o) nameOf.set(o, n);

  // A node's turn in root space at time t: its own turns after its ancestors' (humanoid.gd, _total).
  const total = (o: Object3D | null, spec: ClipSpec, t: number): Quaternion => {
    const chain: Object3D[] = [];
    for (let n = o; n && n !== root; n = n.parent) chain.unshift(n);
    let q = new Quaternion();
    for (const n of chain) {
      const turns = spec.bones[nameOf.get(n) ?? ""];
      if (turns?.length) q = own(turns, frame, t, spec.length).multiply(q);
    }
    return q;
  };

  return Object.entries(CLIPS).map(([clipName, spec]) => {
    const steps = Math.max(2, Math.round(spec.length * RATE));
    const times = Array.from({ length: steps + 1 }, (_, s) => (spec.length * s) / steps);
    const tracks = [];
    for (const [boneName, turns] of Object.entries(spec.bones)) {
      const bone = bones[boneName];
      if (!bone || !turns.length) continue;
      const parent = bone.parent && bone.parent !== root ? bone.parent : null;
      const rest = restQ(bone);
      const parentRest = parent ? restQ(parent) : new Quaternion();
      const values: number[] = [];
      for (const t of times) {
        const local = parentRest.clone().invert().multiply(total(parent, spec, t).invert()).multiply(total(bone, spec, t)).multiply(rest);
        values.push(local.x, local.y, local.z, local.w);
      }
      tracks.push(new QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, values));
    }
    const hips = bones["Hips"]!;
    const move = spec.hips ?? {};
    if (Object.keys(move).length) {
      const parent = hips.parent && hips.parent !== root ? hips.parent : null;
      const toParent = new Matrix3().setFromMatrix4(parent ? inRoot(parent) : new Matrix4()).invert();
      const values: number[] = [];
      for (const t of times) {
        const offset = new Vector3();
        for (const [axis, m] of Object.entries(move)) {
          const amount = m[0] + m[1] * Math.sin(Math.PI * 2 * ((m[3] * t) / spec.length + m[2]));
          offset.addScaledVector((frame as unknown as Record<string, Vector3>)[axis] ?? up, amount * leg);
        }
        const p = hips.position.clone().add(offset.applyMatrix3(toParent));
        values.push(p.x, p.y, p.z);
      }
      tracks.push(new VectorKeyframeTrack(`${hips.name}.position`, times, values));
    }
    return new AnimationClip(clipName, spec.length, tracks);
  });
}

/**
 * The humanoid bones a VRM file names (VRM 0.x's `VRM` or VRM 1.0's `VRMC_vrm` extension), by the humanoid
 * profile's names (hips -> Hips), and whether it is VRM 0.x (which faces the other way: Godot's VRM importer
 * turns those round, and the 3D view does the same). Null for a model that is not VRM.
 */
export function vrmHumanBones(json: unknown, nodeOf: (index: number) => Object3D | undefined): { bones: Record<string, Object3D>; vrm0: boolean } | null {
  const ext = (json as { extensions?: Record<string, unknown> } | null)?.extensions ?? {};
  const bones: Record<string, Object3D> = {};
  const put = (vrmName: string, index: number) => {
    const o = nodeOf(index);
    if (o && vrmName) bones[vrmName[0]!.toUpperCase() + vrmName.slice(1)] = o;
  };
  const v0 = ext["VRM"] as { humanoid?: { humanBones?: { bone: string; node: number }[] } } | undefined;
  if (v0?.humanoid?.humanBones) {
    for (const b of v0.humanoid.humanBones) put(b.bone, b.node);
    return { bones, vrm0: true };
  }
  const v1 = ext["VRMC_vrm"] as { humanoid?: { humanBones?: Record<string, { node: number }> } } | undefined;
  if (v1?.humanoid?.humanBones) {
    for (const [name, b] of Object.entries(v1.humanoid.humanBones)) put(name, b.node);
    return { bones, vrm0: false };
  }
  return null;
}

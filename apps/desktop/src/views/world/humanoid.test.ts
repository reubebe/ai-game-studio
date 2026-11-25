import { describe, expect, it } from "vitest";
import { AnimationMixer, Vector3, type Object3D } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { humanoidVrm } from "../../../../../packages/project/src/test-assets";
import { HUMANOID_CLIPS, humanoidClips, vrmHumanBones } from "./humanoid";

async function loadVrm() {
  const bytes = humanoidVrm();
  const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, "");
  const byIndex = new Map<number, Object3D>();
  gltf.scene.traverse((o) => {
    const i = gltf.parser.associations.get(o)?.nodes;
    if (i !== undefined) byIndex.set(i, o);
  });
  const human = vrmHumanBones(gltf.parser.json, (i) => byIndex.get(i))!;
  return { gltf, human };
}

const at = (o: Object3D) => new Vector3().setFromMatrixPosition(o.matrixWorld);

describe("humanoid clips (VRM characters)", () => {
  it("reads a VRM's humanoid bones by the humanoid profile's names, and tells older VRM files apart", async () => {
    const { human } = await loadVrm();
    expect(human.vrm0).toBe(false);
    expect(Object.keys(human.bones)).toEqual(expect.arrayContaining(["Hips", "Spine", "Head", "LeftUpperLeg", "RightLowerLeg", "LeftUpperArm", "RightLowerArm"]));
    expect(human.bones["LeftUpperLeg"]!.name).toBe("LeftUpperLeg");
    const v0 = vrmHumanBones({ extensions: { VRM: { humanoid: { humanBones: [{ bone: "hips", node: 1 }] } } } }, () => ({ name: "pelvis" }) as Object3D);
    expect(v0?.vrm0).toBe(true);
    expect(Object.keys(v0!.bones)).toEqual(["Hips"]);
    expect(vrmHumanBones({ extensions: {} }, () => undefined)).toBeNull();
  });

  it("makes Idle, Walk, Run and Jump that pose the character as the pose file says (the game's humanoid.gd does the same)", async () => {
    const { gltf, human } = await loadVrm();
    const clips = humanoidClips(gltf.scene, human.bones);
    expect(clips.map((c) => c.name)).toEqual(HUMANOID_CLIPS);
    expect(HUMANOID_CLIPS).toEqual(["Idle", "Walk", "Run", "Jump"]);
    const pose = (clip: string, t: number) => {
      const mixer = new AnimationMixer(gltf.scene);
      mixer.clipAction(clips.find((c) => c.name === clip)!).play();
      mixer.setTime(t);
      gltf.scene.updateMatrixWorld(true);
      const b = human.bones;
      const thigh = at(b["LeftLowerLeg"]!).sub(at(b["LeftUpperLeg"]!)).normalize();
      const arm = at(b["LeftLowerArm"]!).sub(at(b["LeftUpperArm"]!)).normalize();
      const hips = at(b["Hips"]!).y;
      mixer.stopAllAction();
      mixer.uncacheRoot(gltf.scene);
      // The test humanoid faces +Z with its left at +X: degrees back from straight down.
      return { thighBack: (Math.atan2(-thigh.z, -thigh.y) * 180) / Math.PI, arm, hips };
    };
    // A quarter into Walk the left thigh is -2 + 24 sin(90 deg) = 22 degrees back; at three quarters, 26 forward.
    expect(pose("Walk", 0.25).thighBack).toBeCloseTo(22, 0);
    expect(pose("Walk", 0.75).thighBack).toBeCloseTo(-26, 0);
    // Standing, the arms hang down instead of sticking out in a T.
    const idle = pose("Idle", 0);
    expect(idle.arm.y).toBeLessThan(-0.85);
    // Running, the hips bob: lowest with the legs spread, highest as they pass.
    expect(pose("Run", 0).hips).toBeGreaterThan(pose("Run", 0.66 / 4).hips);
  });

  it("does nothing for a model without the bones a humanoid needs", async () => {
    const { gltf, human } = await loadVrm();
    const { LeftUpperLeg: _gone, ...rest } = human.bones;
    expect(humanoidClips(gltf.scene, rest)).toEqual([]);
  });
});

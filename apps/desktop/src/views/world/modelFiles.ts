import { useEffect, useState } from "react";
import type { LoadedModel } from "./level3d";
import { siblingAsset } from "./level3d";
import { humanoidClips, vrmHumanBones } from "./humanoid";

/**
 * Loads glTF/GLB files from the project once per app session, for the 3D view (which draws copies)
 * and the editor (which lists a model's animations and size). three.js is fetched on first use.
 */
const cache = new Map<string, Promise<LoadedModel>>();

export function loadModelFile(asset: string, resolve: (asset: string) => string | null): Promise<LoadedModel> {
  const main = resolve(asset);
  if (!main) return Promise.reject(new Error(`${asset} cannot be read here`));
  let p = cache.get(main);
  if (!p) {
    p = (async () => {
      const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
      const { LoadingManager } = await import("three");
      // File URLs encode the whole path, so a .gltf's relative references (buffers, textures) are
      // resolved here against the model's own folder instead of by URL rules.
      const BASE = "https://model.invalid/";
      const manager = new LoadingManager();
      manager.setURLModifier((u) => {
        if (!u.startsWith(BASE)) return u;
        const sibling = siblingAsset(asset, u.slice(BASE.length));
        return (sibling && resolve(sibling)) || "data:,";
      });
      const loader = new GLTFLoader(manager);
      loader.setResourcePath(BASE);
      const gltf = await loader.loadAsync(main);
      let clips = gltf.animations;
      // VRM characters (VRoid and others): older VRM files face the other way, so they are turned round as
      // Godot's VRM importer does, and those without walking or running get the game's humanoid clips.
      const byIndex = new Map<number, import("three").Object3D>();
      gltf.scene.traverse((o) => {
        const index = gltf.parser.associations.get(o)?.nodes;
        if (index !== undefined) byIndex.set(index, o);
      });
      const human = vrmHumanBones(gltf.parser.json, (i) => byIndex.get(i));
      let scene: import("three").Object3D = gltf.scene;
      if (human) {
        if (!clips.some((c) => /walk|run/i.test(c.name))) clips = [...clips, ...humanoidClips(gltf.scene, human.bones)];
        if (human.vrm0) {
          // Turned inside a wrapper, so placing the character (which sets its own turn) keeps this one.
          const { Group } = await import("three");
          const wrap = new Group();
          wrap.name = gltf.scene.name || "vrm";
          gltf.scene.rotation.y = Math.PI;
          wrap.add(gltf.scene);
          scene = wrap;
        }
      }
      return { scene, clips };
    })();
    cache.set(main, p);
    // A failed load is not kept, so a fixed or re-imported file can be tried again.
    p.catch(() => cache.delete(main));
  }
  return p;
}

export interface ModelInfo {
  clips: string[];
  /** Height in the model's own units, for suggesting a character height. */
  tall: number;
}

/** A model's animation names and height, once loaded; null while loading or when files cannot be read. */
export function useModelInfo(asset: string | undefined, assetUrl: ((asset: string) => string | null) | undefined): { info: ModelInfo | null; error: string | null } {
  const [state, setState] = useState<{ key: string; info: ModelInfo | null; error: string | null }>({ key: "", info: null, error: null });
  const key = asset && assetUrl ? asset : "";
  useEffect(() => {
    if (!asset || !assetUrl) return;
    let live = true;
    loadModelFile(asset, assetUrl).then(
      async (m) => {
        const { Box3 } = await import("three");
        m.scene.updateMatrixWorld(true);
        const box = new Box3().setFromObject(m.scene);
        if (live) setState({ key: asset, info: { clips: m.clips.map((c) => c.name), tall: box.isEmpty() ? 1 : box.max.y - box.min.y }, error: null });
      },
      (e: unknown) => live && setState({ key: asset, info: null, error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [asset, assetUrl]);
  return state.key === key ? { info: state.info, error: state.error } : { info: null, error: null };
}

import { BufferAttribute, BufferGeometry, Group, Mesh, MeshStandardMaterial, type Texture } from "three";
import { natureMeshes, turnOf, variantOf, type NatureKind } from "@gamestudio/explore";
import atlasScript from "../../../../../templates/exploration-3d/godot/scripts/leaf_atlas.gd?raw";

/**
 * The realistic style's detailed trees and rocks in the 3D view, built from the same numbers as the
 * game's nature.gd (packages/explore, natureMeshes): same shape for the same object id, same turn.
 */

/** The leaf picture as a data: URL, read from the template's leaf_atlas.gd (the game reads the same file). */
export const LEAF_ATLAS_URL = `data:image/png;base64,${/const PNG := "([A-Za-z0-9+/=]+)"/.exec(atlasScript)?.[1] ?? ""}`;

const geometries = new Map<string, BufferGeometry[]>();

/** Screen colour (sRGB) to linear light, as Godot does for vertex_color_is_srgb. */
export const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

function geometry(kind: NatureKind, variant: number): BufferGeometry[] {
  const key = `${kind}|${variant}`;
  let made = geometries.get(key);
  if (!made) {
    made = natureMeshes(kind, variant).map((m) => {
      const g = new BufferGeometry();
      g.setAttribute("position", new BufferAttribute(new Float32Array(m.positions), 3));
      g.setAttribute("normal", new BufferAttribute(new Float32Array(m.normals), 3));
      // The meshes carry screen colours; three.js multiplies vertex colours in linear light.
      g.setAttribute("color", new BufferAttribute(new Float32Array(m.colors.map(toLinear)), 3));
      g.setAttribute("uv", new BufferAttribute(new Float32Array(m.uvs), 2));
      g.setIndex(m.indices);
      g.computeBoundingSphere();
      return g;
    });
    geometries.set(key, made);
  }
  return made;
}

/** Materials shared by every detailed tree and rock: bark and stone coloured by the mesh, and the leaves. */
export class NatureMaterials {
  /** Like nature.gd's solid_material: vertex colours, roughness 0.92. */
  readonly solid = new MeshStandardMaterial({ vertexColors: true, roughness: 0.92 });
  /** Like nature.gd's leaf_material: the leaf picture cut out at alpha 0.4, tinted by the mesh. Hidden until the picture loads. */
  readonly leaves = new MeshStandardMaterial({ vertexColors: true, roughness: 0.8, alphaTest: 0.4, visible: false });
  private loading = false;

  /** Starts loading the leaf picture once (`load` is the view's texture loader); `done` runs when it is shown. */
  loadLeaves(load: ((url: string, srgb: boolean) => Promise<Texture>) | null, done: () => void) {
    if (this.loading || !load) return;
    this.loading = true;
    load(LEAF_ATLAS_URL, true).then(
      (t) => {
        // Godot reads a picture from its top row down; three would flip it.
        t.flipY = false;
        t.needsUpdate = true;
        this.leaves.map = t;
        this.leaves.visible = true;
        this.leaves.needsUpdate = true;
        done();
      },
      () => {
        this.loading = false;
      },
    );
  }

  dispose() {
    this.solid.dispose();
    this.leaves.map?.dispose();
    this.leaves.dispose();
  }
}

/** A detailed tree ("round", "tall", "baobab") or rock, as world_builder.gd's _nature builds it. */
export function natureGroup(kind: NatureKind, id: string, materials: NatureMaterials): Group {
  const holder = new Group();
  holder.name = "Nature";
  holder.rotation.y = turnOf(id);
  geometry(kind, variantOf(id)).forEach((g, i) => {
    const m = new Mesh(g, i === 0 ? materials.solid : materials.leaves);
    m.name = i === 0 ? (kind === "rock" ? "Rock" : "Bark") : "Leaves";
    m.castShadow = true;
    m.receiveShadow = true;
    holder.add(m);
  });
  return holder;
}

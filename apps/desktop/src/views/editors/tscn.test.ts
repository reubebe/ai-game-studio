import { describe, expect, it } from "vitest";
import { parseTscn } from "./tscn";

describe("parseTscn", () => {
  it("builds the node tree with instances, groups and properties", () => {
    const s = parseTscn(`[gd_scene format=3]

[ext_resource type="Script" path="res://scripts/player.gd" id="1_player"]
[ext_resource type="PackedScene" path="res://scenes/player.tscn" id="2_p"]
[sub_resource type="BoxMesh" id="BoxMesh_1"]
size = Vector3(1, 1, 1)

[node name="Main" type="Node3D"]
script = ExtResource("1_player")

[node name="Player" parent="." instance=ExtResource("2_p")]

[node name="Body" type="CharacterBody3D" parent="." groups=["gs_player", "x"]]

[node name="Mesh" type="MeshInstance3D" parent="Body"]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0.85, 0)
`);
    expect(s.problems).toEqual([]);
    expect(s.root?.name).toBe("Main");
    expect(s.root?.children.map((c) => c.name)).toEqual(["Player", "Body"]);
    expect(s.root?.children[0]!.instance).toBe("2_p");
    expect(s.root?.children[1]!.groups).toEqual(["gs_player", "x"]);
    expect(s.root?.children[1]!.children[0]!.properties[0]!.key).toBe("transform");
    expect(s.extResources).toHaveLength(2);
  });

  it("reports missing parents and headers", () => {
    const s = parseTscn(`[node name="A" type="Node"]\n[node name="B" type="Node" parent="Nope"]\n`);
    expect(s.problems.join(" ")).toMatch(/gd_scene/);
    expect(s.problems.join(" ")).toMatch(/missing parent/);
  });
});

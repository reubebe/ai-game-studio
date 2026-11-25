# VRM characters (VRoid and other VRM avatars)

`vrm/` and `Godot-MToon-Shader/` are the VRM importer and MToon toon shader from
https://github.com/V-Sekai/godot-vrm at commit e15199f980064028bfa4fbee5e70dddb82dd55c3
("Update .import files for Godot 4.7", 2026-07-08), unchanged. MIT licence: see each folder's LICENSE.
Each file was checked against the git blob hash GitHub lists for that commit.

They let a project use `.vrm` characters (made in VRoid Studio, for example) as the player or a villager.
Characters without walking animations get Game Studio's (`scripts/humanoid.gd`).

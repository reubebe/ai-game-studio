extends RefCounted
## The level's drawing style (environment.style). "realistic" changes the lighting (world_builder.gd,
## _apply_realistic) and draws trees and rocks in detail (nature.gd). "anime": toon shading (a crisp
## line between light and shade, no glossy highlights, a rim of light round the edges), ink outlines (shaders/outline.gdshader)
## and crisp two-tone clouds (sky.gdshader); "standard": the materials as built. Glowing and see-through
## parts keep their look and get no outline. The studio's 3D view draws the same (level3d.ts, style).

const OutlineShader := preload("res://shaders/outline.gdshader")

var style := "standard"
## Materials restyled so far (original's instance id -> toon material), so shared materials stay shared.
var _converted := {}
var _outline: ShaderMaterial = null
## How many toon materials were made (the self-test reports it).
var toon_materials := 0


func _init(s: String = "standard") -> void:
	style = s if ["standard", "anime", "realistic"].has(s) else "standard"


func anime() -> bool:
	return style == "anime"


func outline() -> ShaderMaterial:
	if _outline == null:
		_outline = ShaderMaterial.new()
		_outline.shader = OutlineShader
	return _outline


## Restyles every mesh under node: the level's objects, the player, imported models and characters.
func apply(node: Node) -> void:
	if not anime() or node == null:
		return
	_apply(node)


func _apply(node: Node) -> void:
	if node is MeshInstance3D:
		var mi := node as MeshInstance3D
		if mi.material_override != null:
			mi.material_override = _toon(mi.material_override)
		elif mi.mesh != null:
			for i in mi.mesh.get_surface_count():
				var m := mi.get_surface_override_material(i)
				if m == null:
					m = mi.mesh.surface_get_material(i)
				if m != null:
					mi.set_surface_override_material(i, _toon(m))
	for child in node.get_children():
		_apply(child)


func _toon(m: Material) -> Material:
	if not (m is BaseMaterial3D):
		return m
	var id := m.get_instance_id()
	if _converted.has(id):
		return _converted[id]
	var b := m as BaseMaterial3D
	var out: Material = m
	var glowing := b.emission_enabled and b.emission_energy_multiplier >= 1.0
	if b.shading_mode != BaseMaterial3D.SHADING_MODE_UNSHADED and b.transparency == BaseMaterial3D.TRANSPARENCY_DISABLED and not glowing:
		var t := b.duplicate() as BaseMaterial3D
		t.diffuse_mode = BaseMaterial3D.DIFFUSE_TOON
		# Toon diffuse uses roughness for how soft the line between light and shade is.
		t.roughness = 0.14
		t.specular_mode = BaseMaterial3D.SPECULAR_DISABLED
		t.metallic = 0.0
		t.metallic_specular = 0.0
		t.rim_enabled = true
		t.rim = 0.32
		t.rim_tint = 0.55
		t.next_pass = outline()
		toon_materials += 1
		out = t
	_converted[id] = out
	return out

@tool
extends Node3D
## Builds the pitch from res://gamestudio_data/match.json, the settings edited in Game Studio's match
## editor: striped grass, the lines, two goals with nets, boards all round (the ball never goes out),
## a stand of supporters in both teams' colours and floodlights. In the Godot editor it draws a preview;
## the generated nodes have no owner, so they are never saved into main.tscn.

const MATCH_PATH := "res://gamestudio_data/match.json"
const SunShadows := preload("res://scripts/sun_shadows.gd")
const GroundShader := preload("res://shaders/ground.gdshader")
const LINE := 0.12
const BOARD_HEIGHT := 0.9
const GOAL_HEIGHT := 2.0
const GOAL_DEPTH := 1.2

var match_data: Dictionary = {}
var load_error := ""
var half_length := 20.0
var half_width := 12.0
var goal_half := 2.0
var _materials: Dictionary = {}
## The grass and lines' materials (shaders/ground.gdshader), which take the sun's shadows in web builds.
var _ground_materials: Array = []
## The shadows drawn on the pitch in web builds (sun_shadows.gd, the same as the 3D template's), or null.
var drawn_shadows: Node3D = null


func _ready() -> void:
	build()


func build() -> void:
	for child in get_children():
		remove_child(child)
		child.queue_free()
	_materials.clear()
	_ground_materials.clear()
	drawn_shadows = null
	load_error = ""
	match_data = _load()
	var pitch: Dictionary = match_data.get("pitch", {})
	half_length = float(pitch.get("length", 40.0)) / 2.0
	half_width = float(pitch.get("width", 24.0)) / 2.0
	goal_half = float(pitch.get("goalWidth", 4.0)) / 2.0
	var grass := Color(str(pitch.get("grass", "#3f8f3a")))
	var lines := Color(str(pitch.get("lines", "#f5f5f0")))
	_ground(grass, bool(pitch.get("stripes", true)))
	_lines(lines)
	for side in [-1.0, 1.0]:
		_goal(side)
	_boards()
	_stand()
	_floodlights()
	if not Engine.is_editor_hint():
		_sun_shadows()


func _load() -> Dictionary:
	if not FileAccess.file_exists(MATCH_PATH):
		load_error = "Missing %s" % MATCH_PATH
		return {}
	var parsed = JSON.parse_string(FileAccess.get_file_as_string(MATCH_PATH))
	if typeof(parsed) != TYPE_DICTIONARY:
		load_error = "match.json is not valid JSON"
		return {}
	if str(parsed.get("kind", "")) != "football-match":
		load_error = "match.json is not a football match"
		return {}
	return parsed


func team(side: String) -> Dictionary:
	return match_data.get(side, {})


# ---- Building blocks --------------------------------------------------------------------------

func _mat(c: Color, emission: float = 0.0, alpha: float = 1.0) -> StandardMaterial3D:
	var key := "%s|%s|%s" % [c.to_html(), emission, alpha]
	if _materials.has(key):
		return _materials[key]
	var m := StandardMaterial3D.new()
	m.albedo_color = Color(c, alpha)
	m.roughness = 0.9
	if emission > 0.0:
		m.emission_enabled = true
		m.emission = c
		m.emission_energy_multiplier = emission
	if alpha < 1.0:
		m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
		m.cull_mode = BaseMaterial3D.CULL_DISABLED
	_materials[key] = m
	return m


## Grass and lines: a flat colour that takes the sun's shadows (shaders/ground.gdshader).
func _ground_mat(c: Color) -> ShaderMaterial:
	var key := "ground|%s" % c.to_html()
	if _materials.has(key):
		return _materials[key]
	var m := ShaderMaterial.new()
	m.shader = GroundShader
	m.set_shader_parameter("ground_color", c)
	_materials[key] = m
	_ground_materials.append(m)
	return m


## The players and the ball cast shadows on the pitch. On the desktop the sun casts them; Godot's web
## renderer washes out everything a shadow-casting light lights (see the 3D template's world_builder.gd,
## web_shadows), so there the pitch's material darkens under the outline the sun's camera draws.
func _sun_shadows() -> void:
	var sun := get_parent().get_node_or_null("Sun") as DirectionalLight3D if get_parent() != null else null
	if sun == null:
		return
	var web := RenderingServer.get_current_rendering_method() == "gl_compatibility"
	sun.shadow_enabled = not web
	sun.shadow_blur = 1.2
	if not web:
		return
	SunShadows.exclude_non_casters(self)
	drawn_shadows = SunShadows.new()
	add_child(drawn_shadows)
	drawn_shadows.call("setup", -sun.global_transform.basis.z, half_length * 2.0 + 30.0, half_width * 2.0 + 30.0)
	for m in _ground_materials:
		drawn_shadows.call("apply_to", m)


func _box(size: Vector3, pos: Vector3, material: Material, parent: Node3D = null) -> MeshInstance3D:
	var mesh := BoxMesh.new()
	mesh.size = size
	var mi := MeshInstance3D.new()
	mi.mesh = mesh
	mi.material_override = material
	mi.position = pos
	mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	(parent if parent != null else self).add_child(mi)
	return mi


func _cylinder(radius: float, height: float, pos: Vector3, material: Material, rot := Vector3.ZERO) -> MeshInstance3D:
	var mesh := CylinderMesh.new()
	mesh.top_radius = radius
	mesh.bottom_radius = radius
	mesh.height = height
	mesh.radial_segments = 12
	var mi := MeshInstance3D.new()
	mi.mesh = mesh
	mi.material_override = material
	mi.position = pos
	mi.rotation_degrees = rot
	add_child(mi)
	return mi


## Grass: stripes across the length inside the boards, a darker surround outside them.
func _ground(grass: Color, stripes: bool) -> void:
	_box(Vector3(half_length * 2.0 + 30.0, 0.1, half_width * 2.0 + 30.0), Vector3(0.0, -0.06, 0.0), _ground_mat(grass.darkened(0.35)))
	var inner_length := half_length * 2.0 + 2.0
	var count := maxi(1, int(round(inner_length / 4.0)))
	var width := inner_length / float(count)
	for i in range(count):
		var shade := grass if (not stripes or i % 2 == 0) else grass.darkened(0.08)
		_box(Vector3(width, 0.02, half_width * 2.0 + 1.0), Vector3(-inner_length / 2.0 + width * (float(i) + 0.5), -0.01, 0.0), _ground_mat(shade))


func _lines(c: Color) -> void:
	var m := _ground_mat(c)
	var y := 0.006
	for z in [-half_width, half_width]:
		_box(Vector3(half_length * 2.0 + LINE, 0.01, LINE), Vector3(0.0, y, z), m)
	for x in [-half_length, 0.0, half_length]:
		_box(Vector3(LINE, 0.01, half_width * 2.0), Vector3(x, y, 0.0), m)
	var ring := TorusMesh.new()
	ring.inner_radius = 3.0 - LINE / 2.0
	ring.outer_radius = 3.0 + LINE / 2.0
	ring.rings = 48
	var circle := MeshInstance3D.new()
	circle.mesh = ring
	circle.material_override = m
	circle.scale = Vector3(1.0, 0.08, 1.0)
	circle.position = Vector3(0.0, y, 0.0)
	add_child(circle)
	_cylinder(0.15, 0.01, Vector3(0.0, y, 0.0), m)
	# Penalty areas: as deep as a sixth of the pitch (at most 6 m), three metres wider than the goal each side.
	var depth := minf(6.0, half_length / 3.0)
	var area_half := minf(goal_half + 3.0, half_width - 1.0)
	for side in [-1.0, 1.0]:
		var front: float = side * (half_length - depth)
		_box(Vector3(LINE, 0.01, area_half * 2.0), Vector3(front, y, 0.0), m)
		for z in [-area_half, area_half]:
			_box(Vector3(depth, 0.01, LINE), Vector3(side * (half_length - depth / 2.0), y, z), m)
		_cylinder(0.12, 0.01, Vector3(side * (half_length - depth * 0.7), y, 0.0), m)


## A goal on the end line at x = side * half_length: posts, crossbar, the frame behind, and a see-through net.
func _goal(side: float) -> void:
	var white := _mat(Color("#f4f4f4"))
	var x := side * half_length
	var back := side * (half_length + GOAL_DEPTH)
	for z in [-goal_half, goal_half]:
		_cylinder(0.06, GOAL_HEIGHT, Vector3(x, GOAL_HEIGHT / 2.0, z), white)
		_cylinder(0.04, GOAL_HEIGHT, Vector3(back, GOAL_HEIGHT / 2.0, z), white)
		_cylinder(0.04, GOAL_DEPTH, Vector3((x + back) / 2.0, GOAL_HEIGHT, z), white, Vector3(0.0, 0.0, 90.0))
	_cylinder(0.06, goal_half * 2.0, Vector3(x, GOAL_HEIGHT, 0.0), white, Vector3(90.0, 0.0, 0.0))
	_cylinder(0.04, goal_half * 2.0, Vector3(back, GOAL_HEIGHT, 0.0), white, Vector3(90.0, 0.0, 0.0))
	var net := _mat(Color(1.0, 1.0, 1.0), 0.0, 0.32)
	_box(Vector3(0.02, GOAL_HEIGHT, goal_half * 2.0), Vector3(back, GOAL_HEIGHT / 2.0, 0.0), net)
	_box(Vector3(GOAL_DEPTH, 0.02, goal_half * 2.0), Vector3((x + back) / 2.0, GOAL_HEIGHT, 0.0), net)
	for z in [-goal_half, goal_half]:
		_box(Vector3(GOAL_DEPTH, GOAL_HEIGHT, 0.02), Vector3((x + back) / 2.0, GOAL_HEIGHT / 2.0, z), net)


## Boards round the pitch, in panels of the two teams' colours and white, open only at the goal mouths.
func _boards() -> void:
	var colours := [Color(str(team("home").get("shirt", "#e5484d"))), Color("#f4f4f4"), Color(str(team("away").get("shirt", "#3b82f6")))]
	var length := half_length * 2.0
	var panels := maxi(1, int(round(length / 4.0)))
	var panel := length / float(panels)
	for z in [-half_width - 0.15, half_width + 0.15]:
		for i in range(panels):
			_box(Vector3(panel - 0.05, BOARD_HEIGHT, 0.2), Vector3(-half_length + panel * (float(i) + 0.5), BOARD_HEIGHT / 2.0, z), _mat(colours[i % colours.size()]))
	for side in [-1.0, 1.0]:
		var x: float = side * (half_length + 0.15)
		var stretch := half_width - goal_half
		for sign_z in [-1.0, 1.0]:
			_box(Vector3(0.2, BOARD_HEIGHT, stretch), Vector3(x, BOARD_HEIGHT / 2.0, sign_z * (goal_half + stretch / 2.0)), _mat(colours[1]))
		# Behind the net, so the ball stops there.
		_box(Vector3(0.2, BOARD_HEIGHT, goal_half * 2.0 + 0.4), Vector3(side * (half_length + GOAL_DEPTH + 0.25), BOARD_HEIGHT / 2.0, 0.0), _mat(colours[1]))


## Three tiers of seats along the far side, filled with supporters in the teams' colours.
func _stand() -> void:
	var concrete := _mat(Color("#7c8088"))
	var front := -half_width - 2.0
	var length := half_length * 2.0 + 6.0
	for tier in range(3):
		_box(Vector3(length, 0.8 + float(tier) * 0.8, 1.6), Vector3(0.0, (0.8 + float(tier) * 0.8) / 2.0, front - 0.8 - float(tier) * 1.6), concrete)
	var palette := [Color(str(team("home").get("shirt", "#e5484d"))), Color(str(team("away").get("shirt", "#3b82f6"))), Color("#f4f4f4"), Color("#2b2f38"), Color(str(team("home").get("shorts", "#ffffff")))]
	var rng := RandomNumberGenerator.new()
	rng.seed = 7
	var per_row := int(length / 0.55)
	var mm := MultiMesh.new()
	mm.transform_format = MultiMesh.TRANSFORM_3D
	mm.use_colors = true
	var person := BoxMesh.new()
	person.size = Vector3(0.38, 0.55, 0.3)
	mm.mesh = person
	mm.instance_count = per_row * 3
	for tier in range(3):
		for i in range(per_row):
			var at := Vector3(-length / 2.0 + 0.3 + float(i) * 0.55 + rng.randf_range(-0.08, 0.08), 0.8 + float(tier) * 0.8 + 0.28, front - 0.8 - float(tier) * 1.6 + rng.randf_range(-0.2, 0.2))
			mm.set_instance_transform(tier * per_row + i, Transform3D(Basis(), at))
			mm.set_instance_color(tier * per_row + i, palette[rng.randi_range(0, palette.size() - 1)])
	var crowd := MultiMeshInstance3D.new()
	crowd.name = "Crowd"
	crowd.multimesh = mm
	var crowd_mat := StandardMaterial3D.new()
	crowd_mat.vertex_color_use_as_albedo = true
	crowd_mat.roughness = 0.9
	crowd.material_override = crowd_mat
	add_child(crowd)


func _floodlights() -> void:
	var pole := _mat(Color("#9aa0a8"))
	var lamp := _mat(Color("#fff6d8"), 3.0)
	for x in [-half_length - 3.0, half_length + 3.0]:
		var z := -half_width - 8.0
		_cylinder(0.18, 14.0, Vector3(x, 7.0, z), pole)
		_box(Vector3(2.4, 1.0, 0.3), Vector3(x, 14.2, z + 0.2), lamp)

@tool
extends Node3D
## Builds the level from res://gamestudio_data/world.json, the layout edited in Game Studio's
## world editor. In the Godot editor it draws a preview; the generated nodes have no owner,
## so they are never saved into main.tscn. Behaviour scripts are attached only in the game.

signal item_collected(item_id: String, kind: String)
signal zone_entered(zone_id: String)
signal enemy_defeated(enemy_id: String, kind: String)
## A pushed block's middle crossed into a zone.
signal block_entered_zone(block_id: String, zone_id: String)

const WORLD_PATH := "res://gamestudio_data/world.json"
const CollectibleScript := preload("res://scripts/collectible.gd")
const ZoneScript := preload("res://scripts/zone.gd")
const GateScript := preload("res://scripts/gate.gd")
const EnemyScript := preload("res://scripts/enemy.gd")
const Models := preload("res://scripts/models.gd")
const SunShadows := preload("res://scripts/sun_shadows.gd")
const GroundShader := preload("res://shaders/ground.gdshader")
const GrassScript := preload("res://scripts/grass.gd")
const WaterShader := preload("res://shaders/water.gdshader")
const StyleScript := preload("res://scripts/style.gd")
const PhotoSkyShader := preload("res://shaders/photo_sky.gdshader")
const Nature := preload("res://scripts/nature.gd")
## Built-in objects that can take a texture set (packages/explore: TEXTURED_TYPES).
const TEXTURED := ["tree", "rock", "crate", "gate", "sign", "torch"]
## Objects that move by themselves: their body keeps scale 1 and their shapes are sized instead.
const MOVING := ["enemy", "crate"]
## A block is this many metres across at scale 1.
const BLOCK_SIZE := 1.2

var world: Dictionary = {}
var load_error: String = ""
var nodes: Dictionary = {}
var types: Dictionary = {}
var collected: Dictionary = {}
var _materials: Dictionary = {}
## Godot 4.7's Compatibility renderer, the only one a web build has (Game Studio's Play here uses
## it), draws a shadow-casting light in a second pass and adds the passes together after converting
## each one for the screen. Everything the sun lights then comes out far too bright (measured on this
## level: ground #a3f6ac where Forward+ draws #7ba678; Godot's scene.glsl calls linear_to_srgb on the
## extra pass in every mode, glow and adjustments included). Without shadows the sun is drawn in the
## same pass as the sky light and the colours match Forward+, so on that renderer the sun casts no
## shadows itself and sun_shadows.gd draws them on the ground instead.
var web_shadows := false
var _sun_dir := Vector3(-0.4, -0.74, -0.54)
## The shadows drawn on the ground in web builds (sun_shadows.gd), or null.
var drawn_shadows: Node3D = null
## The ground's material (shaders/ground.gdshader).
var ground_material: ShaderMaterial
## The grass (grass.gd), or null when the level has none.
var grass: Node3D = null
## The level's drawing style (style.gd): "standard" or "anime".
var style: RefCounted = StyleScript.new()
## Imported models that could not be loaded: object id -> reason. The self-test reports them.
var model_errors: Dictionary = {}
## Enemies, blocks and gates drawn from an imported model (object id -> asset), and the pieces each
## gate model's door carries (gate id -> count), for the self-test.
var models_used: Dictionary = {}
var door_pieces: Dictionary = {}
## Whether the high-quality look was switched on (desktop renderer and quality "high").
var high_quality := false
## Whether the level's sky is a photograph (environment.skyImage) and the realistic style's desktop
## effects are on, for the self-test.
var sky_photo := false
var realistic_effects := false
## Size of each loaded model around its origin (object id -> AABB, before the object's scale).
var model_bounds: Dictionary = {}
## Objects drawn with a texture set (object id -> number of textured parts).
var textured: Dictionary = {}
## AnimationPlayers of animated scenery and villagers (object id -> AnimationPlayer).
var animation_players: Dictionary = {}
## Defeated enemies (id -> kind).
var defeated: Dictionary = {}
## Pushable blocks (id -> RigidBody3D), the spot each started on, and the zones each stands in now (id -> {zone id: true}).
var blocks: Dictionary = {}
var block_homes: Dictionary = {}
var block_zones: Dictionary = {}
## Zones blocks can be pushed into (id -> [centre, radius in metres]).
var _zone_areas: Dictionary = {}


func _ready() -> void:
	set_process(false)
	build()
	set_physics_process(not Engine.is_editor_hint() and not blocks.is_empty())


func build() -> void:
	for child in get_children():
		remove_child(child)
		child.queue_free()
	nodes.clear()
	types.clear()
	collected.clear()
	model_errors.clear()
	model_bounds.clear()
	animation_players.clear()
	textured.clear()
	defeated.clear()
	blocks.clear()
	block_homes.clear()
	block_zones.clear()
	_zone_areas.clear()
	load_error = ""
	world = _load_world()
	style = StyleScript.new(str((world.get("environment", {}) as Dictionary).get("style", "standard")))
	var size: Dictionary = world.get("size", {"width": 60.0, "depth": 60.0})
	_build_ground(float(size.get("width", 60.0)), float(size.get("depth", 60.0)))
	if not Engine.is_editor_hint():
		_apply_environment(world.get("environment", {}))
	for o in world.get("objects", []):
		if typeof(o) == TYPE_DICTIONARY:
			_build_object(o)
	drawn_shadows = null
	grass = null
	if not Engine.is_editor_hint():
		_add_grass(float(size.get("width", 60.0)), float(size.get("depth", 60.0)))
		style.call("apply", self)
		if grass != null and bool(style.call("anime")):
			(grass.get("material") as ShaderMaterial).set_shader_parameter("crisp", 1.0)
	if web_shadows and not Engine.is_editor_hint():
		_add_sun_shadows(float(size.get("width", 60.0)), float(size.get("depth", 60.0)))


func _load_world() -> Dictionary:
	if not FileAccess.file_exists(WORLD_PATH):
		load_error = "Missing %s" % WORLD_PATH
		return {}
	var parsed = JSON.parse_string(FileAccess.get_file_as_string(WORLD_PATH))
	if typeof(parsed) != TYPE_DICTIONARY:
		load_error = "world.json is not valid JSON"
		return {}
	if str(parsed.get("kind", "")) != "explore-world":
		load_error = "world.json is not an exploration world"
		return {}
	return parsed


# ---- Public API used by main.gd, the rule host and the smoke test -------------------------

func player_settings() -> Dictionary:
	return world.get("player", {})


func object_ids_of_type(object_type: String) -> Array:
	var ids: Array = []
	for id in types:
		if types[id] == object_type:
			ids.append(id)
	return ids


func collect_item(item_id: String) -> bool:
	if not nodes.has(item_id) or types.get(item_id) != "collectible" or collected.has(item_id):
		return false
	var kind := "crystal"
	for o in world.get("objects", []):
		if typeof(o) == TYPE_DICTIONARY and str(o.get("id", "")) == item_id:
			kind = str(o.get("kind", "crystal"))
	collected[item_id] = kind
	var node: Node3D = nodes[item_id]
	node.visible = false
	node.set_deferred("process_mode", Node.PROCESS_MODE_DISABLED)
	item_collected.emit(item_id, kind)
	return true


## Marks an item collected without telling the rules (restoring saved progress).
func restore_collected(item_id: String) -> void:
	if not nodes.has(item_id) or types.get(item_id) != "collectible" or collected.has(item_id):
		return
	var kind := "crystal"
	for o in world.get("objects", []):
		if typeof(o) == TYPE_DICTIONARY and str(o.get("id", "")) == item_id:
			kind = str(o.get("kind", "crystal"))
	collected[item_id] = kind
	var node: Node3D = nodes[item_id]
	node.visible = false
	node.set_deferred("process_mode", Node.PROCESS_MODE_DISABLED)


func collected_count(kind: String) -> int:
	var count := 0
	for id in collected:
		if collected[id] == kind:
			count += 1
	return count


func total_count(kind: String) -> int:
	var count := 0
	for o in world.get("objects", []):
		if typeof(o) == TYPE_DICTIONARY and str(o.get("type", "")) == "collectible" and str(o.get("kind", "crystal")) == kind:
			count += 1
	return count


func has_gate(gate_id: String) -> bool:
	return nodes.has(gate_id) and types.get(gate_id) == "gate"


func open_gate(gate_id: String) -> void:
	if has_gate(gate_id):
		var gate: Node3D = nodes[gate_id]
		if gate.has_method("open"):
			gate.call("open")


## Opens a gate at once, without the door sinking (restoring saved progress).
func open_gate_now(gate_id: String) -> void:
	if has_gate(gate_id):
		var gate: Node3D = nodes[gate_id]
		if gate.has_method("open_now"):
			gate.call("open_now")


func is_gate_open(gate_id: String) -> bool:
	if not has_gate(gate_id):
		return false
	var gate: Node3D = nodes[gate_id]
	return gate.get("is_open") == true


func set_object_visible(object_id: String, visible_now: bool) -> bool:
	if not nodes.has(object_id):
		return false
	var node: Node3D = nodes[object_id]
	if defeated.has(object_id):
		return true
	node.visible = visible_now
	node.set_deferred("process_mode", Node.PROCESS_MODE_INHERIT if visible_now else Node.PROCESS_MODE_DISABLED)
	return true


# ---- Enemies --------------------------------------------------------------------------------

func enemy_count(kind: String) -> int:
	var count := 0
	for o in world.get("objects", []):
		if typeof(o) == TYPE_DICTIONARY and str(o.get("type", "")) == "enemy" and str(o.get("kind", "beetle")) == kind:
			count += 1
	return count


func defeated_count(kind: String) -> int:
	var count := 0
	for id in defeated:
		if defeated[id] == kind:
			count += 1
	return count


func _on_enemy_defeated(enemy_id: String, kind: String) -> void:
	defeated[enemy_id] = kind
	enemy_defeated.emit(enemy_id, kind)


## Marks an enemy defeated without telling the rules (restoring saved progress).
func restore_defeated(enemy_id: String) -> void:
	if types.get(enemy_id) != "enemy" or defeated.has(enemy_id):
		return
	var enemy: Node3D = nodes[enemy_id]
	defeated[enemy_id] = str(enemy.get("kind"))
	enemy.call("defeat_now")


# ---- Pushable blocks ------------------------------------------------------------------------

## How many blocks stand in a zone now (a block counts while its middle is inside the zone's circle).
func blocks_in_zone(zone_id: String) -> int:
	var count := 0
	for id in block_zones:
		if (block_zones[id] as Dictionary).has(zone_id):
			count += 1
	return count


## Where each block stands now (id -> position), for saving progress.
func block_positions() -> Dictionary:
	var out := {}
	for id in blocks:
		var b: RigidBody3D = blocks[id]
		out[id] = b.global_position
	return out


## Puts a block somewhere at once (restoring saved progress, or the self-test). The zones it stands in
## are updated without telling the rules unless `announce` is true.
func place_block(block_id: String, at: Vector3, announce: bool = false) -> bool:
	if not blocks.has(block_id):
		return false
	var b: RigidBody3D = blocks[block_id]
	b.global_position = at
	b.linear_velocity = Vector3.ZERO
	b.sleeping = false
	_track_block(block_id, announce)
	return true


func _physics_process(_delta: float) -> void:
	for id in blocks:
		var b: RigidBody3D = blocks[id]
		if not is_instance_valid(b) or not b.is_visible_in_tree():
			continue
		if b.global_position.y < -10.0:
			place_block(id, block_homes[id] + Vector3(0.0, 0.2, 0.0))
			continue
		_track_block(id, true)


func _track_block(block_id: String, announce: bool) -> void:
	var b: RigidBody3D = blocks[block_id]
	var middle := b.global_position + Vector3(0.0, BLOCK_SIZE * 0.5, 0.0)
	var now := {}
	for zone_id in _zone_areas:
		var area: Array = _zone_areas[zone_id]
		var centre: Vector3 = area[0]
		var flat := Vector2(middle.x - centre.x, middle.z - centre.z)
		if flat.length() <= float(area[1]) and middle.y > centre.y - 1.0 and middle.y < centre.y + 3.0:
			now[zone_id] = true
	var before: Dictionary = block_zones.get(block_id, {})
	block_zones[block_id] = now
	if announce:
		for zone_id in now:
			if not before.has(zone_id):
				block_entered_zone.emit(block_id, zone_id)


# ---- Construction -----------------------------------------------------------------------

func _mat(hex: String, emission: float = 0.0, alpha: float = 1.0) -> StandardMaterial3D:
	var key := "%s|%s|%s" % [hex, emission, alpha]
	if _materials.has(key):
		return _materials[key]
	var m := StandardMaterial3D.new()
	var c := Color(hex)
	c.a = alpha
	m.albedo_color = c
	m.roughness = 0.85
	if emission > 0.0:
		m.emission_enabled = true
		m.emission = Color(hex)
		m.emission_energy_multiplier = emission
	if alpha < 1.0:
		m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
		m.roughness = 0.15
		m.metallic = 0.2
	_materials[key] = m
	return m


func _mesh_node(mesh: Mesh, material: Material, pos: Vector3) -> MeshInstance3D:
	var mi := MeshInstance3D.new()
	mi.mesh = mesh
	mi.material_override = material
	mi.position = pos
	return mi


func _box_shape(size: Vector3, pos: Vector3) -> CollisionShape3D:
	var cs := CollisionShape3D.new()
	var box := BoxShape3D.new()
	box.size = size
	cs.shape = box
	cs.position = pos
	return cs


func _build_ground(width: float, depth: float) -> void:
	var ground := StaticBody3D.new()
	ground.name = "Ground"
	ground.add_child(_box_shape(Vector3(width, 1.0, depth), Vector3(0.0, -0.5, 0.0)))
	var plane := PlaneMesh.new()
	plane.size = Vector2(width, depth)
	ground_material = _ground_material(world.get("environment", {}), width, depth)
	ground.add_child(_mesh_node(plane, ground_material, Vector3.ZERO))
	add_child(ground)
	var bounds := StaticBody3D.new()
	bounds.name = "Bounds"
	bounds.add_child(_box_shape(Vector3(width + 2.0, 8.0, 1.0), Vector3(0.0, 3.0, -depth / 2.0 - 0.5)))
	bounds.add_child(_box_shape(Vector3(width + 2.0, 8.0, 1.0), Vector3(0.0, 3.0, depth / 2.0 + 0.5)))
	bounds.add_child(_box_shape(Vector3(1.0, 8.0, depth + 2.0), Vector3(-width / 2.0 - 0.5, 3.0, 0.0)))
	bounds.add_child(_box_shape(Vector3(1.0, 8.0, depth + 2.0), Vector3(width / 2.0 + 0.5, 3.0, 0.0)))
	add_child(bounds)


## The ground: its colour, or a tiled texture set (colour, optional normal and roughness maps) repeated
## every `tile` metres, with patches of drier and lusher ground (groundVariation). Falls back to the
## plain colour if the colour texture cannot be loaded.
func _ground_material(env: Dictionary, width: float, depth: float) -> ShaderMaterial:
	var m := ShaderMaterial.new()
	m.shader = GroundShader
	m.set_shader_parameter("ground_color", Color(str(env.get("ground", "#5a7d3c"))))
	m.set_shader_parameter("variation", clampf(float(env.get("groundVariation", 0.0)), 0.0, 1.0))
	var gm = env.get("groundMaterial")
	if typeof(gm) != TYPE_DICTIONARY:
		return m
	var albedo := _texture(str(gm.get("albedo", "")))
	if albedo == null:
		model_errors["ground"] = "ground texture %s could not be loaded" % str(gm.get("albedo", ""))
		return m
	var tile := maxf(0.5, float(gm.get("tile", 4.0)))
	m.set_shader_parameter("use_texture", true)
	m.set_shader_parameter("albedo_tex", albedo)
	m.set_shader_parameter("uv_scale", Vector2(width / tile, depth / tile))
	var normal := _texture(str(gm.get("normal", "")))
	if normal != null:
		m.set_shader_parameter("use_normal", true)
		m.set_shader_parameter("normal_tex", normal)
	var rough := _texture(str(gm.get("roughness", "")))
	if rough != null:
		m.set_shader_parameter("use_roughness", true)
		m.set_shader_parameter("roughness_tex", rough)
	return m


## Gives every plain part of an object (not its glowing or see-through parts) the texture set.
func _apply_texture(node: Node, surface: Dictionary, id: String) -> void:
	if node is MeshInstance3D:
		var mi := node as MeshInstance3D
		var base := mi.material_override as StandardMaterial3D
		if base != null and not base.emission_enabled and base.transparency == BaseMaterial3D.TRANSPARENCY_DISABLED:
			var t := _textured(base, surface, id)
			if t != base:
				mi.material_override = t
				textured[id] = int(textured.get(id, 0)) + 1
	for child in node.get_children():
		_apply_texture(child, surface, id)


## A material from a texture set, projected from the three axes in world space and repeated every
## `tile` metres (the studio's 3D view draws it the same way: level3d.ts, triplanar).
func _textured(base: StandardMaterial3D, surface: Dictionary, id: String) -> StandardMaterial3D:
	var key := "tex|%s|%s|%s" % [base.albedo_color.to_html(), base.vertex_color_use_as_albedo, JSON.stringify(surface)]
	if _materials.has(key):
		return _materials[key]
	var albedo := _texture(str(surface.get("albedo", "")))
	if albedo == null:
		model_errors[id] = "texture %s could not be loaded" % str(surface.get("albedo", ""))
		return base
	var t := StandardMaterial3D.new()
	t.albedo_texture = albedo
	t.albedo_color = base.albedo_color if bool(surface.get("tint", false)) else Color.WHITE
	# Parts coloured by their mesh (nature.gd's bark and rocks) keep those colours when tinted.
	t.vertex_color_use_as_albedo = base.vertex_color_use_as_albedo and bool(surface.get("tint", false))
	t.vertex_color_is_srgb = base.vertex_color_is_srgb
	t.roughness = 1.0
	t.uv1_triplanar = true
	t.uv1_world_triplanar = true
	var k := 1.0 / maxf(0.1, float(surface.get("tile", 1.0)))
	t.uv1_scale = Vector3(k, k, k)
	t.texture_filter = BaseMaterial3D.TEXTURE_FILTER_LINEAR_WITH_MIPMAPS_ANISOTROPIC
	var normal := _texture(str(surface.get("normal", "")))
	if normal != null:
		t.normal_enabled = true
		t.normal_texture = normal
	var rough := _texture(str(surface.get("roughness", "")))
	if rough != null:
		t.roughness_texture = rough
		t.roughness_texture_channel = BaseMaterial3D.TEXTURE_CHANNEL_GRAYSCALE
	_materials[key] = t
	return t


func _texture(rel: String) -> Texture2D:
	if rel == "" or rel.contains(".."):
		return null
	var path := "res://" + rel
	if not ResourceLoader.exists(path):
		return null
	return load(path) as Texture2D


func _apply_environment(env: Dictionary) -> void:
	var main := get_parent()
	if main == null:
		return
	var we := main.get_node_or_null("WorldEnvironment") as WorldEnvironment
	if we != null and we.environment != null:
		var e: Environment = we.environment.duplicate(true)
		var fog := float(env.get("fogDensity", 0.008))
		e.fog_enabled = fog > 0.0
		e.fog_density = fog
		e.fog_light_color = Color(str(env.get("skyHorizon", "#b8d4ec")))
		# Fog covers the sky only as much as it is thick (Godot's default covers it all, a flat wash).
		e.fog_sky_affect = sky_fog(fog)
		if e.sky != null and e.sky.sky_material is ShaderMaterial:
			var sky: ShaderMaterial = e.sky.sky_material
			var horizon := Color(str(env.get("skyHorizon", "#b8d4ec")))
			sky.set_shader_parameter("sky_top_color", Color(str(env.get("skyTop", "#2f63a8"))))
			sky.set_shader_parameter("sky_horizon_color", horizon)
			sky.set_shader_parameter("ground_horizon_color", horizon)
			sky.set_shader_parameter("ground_bottom_color", Color(str(env.get("ground", "#5a7d3c"))).darkened(0.4))
			sky.set_shader_parameter("clouds", clampf(float(env.get("clouds", 0.0)), 0.0, 1.0))
			sky.set_shader_parameter("anime", 1.0 if bool(style.call("anime")) else 0.0)
			sky.set_shader_parameter("cloud_offset", Vector2(float(env.get("sunHeading", 35.0)) * 0.37, 11.0))
		sky_photo = false
		var sky_image := str(env.get("skyImage", ""))
		if sky_image != "" and e.sky != null:
			var photo := _texture(sky_image)
			if photo == null:
				model_errors["sky"] = "sky picture %s could not be loaded" % sky_image
			else:
				# A photographed sky lights the level and fills the background; distant things take on the
				# colour of the sky behind them, and the photo itself stays clear of fog.
				var pano := ShaderMaterial.new()
				pano.shader = PhotoSkyShader
				pano.set_shader_parameter("panorama", photo)
				pano.set_shader_parameter("energy", clampf(float(env.get("skyBrightness", 1.0)), 0.1, 4.0))
				pano.set_shader_parameter("encode_srgb", RenderingServer.get_current_rendering_method() == "gl_compatibility")
				e.sky.sky_material = pano
				e.fog_aerial_perspective = 0.85
				e.fog_sky_affect = 0.0
				sky_photo = true
		if bool(style.call("anime")):
			# Brighter, cleaner colours; the toon materials make the contrast themselves.
			e.adjustment_contrast = 1.06
			e.adjustment_saturation = 1.32
			if ground_material != null:
				ground_material.set_shader_parameter("crisp", 1.0)
		we.environment = e
	var sun := main.get_node_or_null("Sun") as DirectionalLight3D
	if sun != null:
		sun.rotation_degrees = Vector3(-float(env.get("sunElevation", 48.0)), float(env.get("sunHeading", 35.0)), 0.0)
		sun.light_color = Color(str(env.get("sunColor", "#ffffff")))
		if bool(style.call("anime")):
			sun.shadow_blur = 0.5
		web_shadows = RenderingServer.get_current_rendering_method() == "gl_compatibility"
		sun.shadow_enabled = not web_shadows
		_sun_dir = -sun.transform.basis.z
	if str(env.get("quality", "standard")) == "high" and RenderingServer.get_current_rendering_method() != "gl_compatibility":
		_apply_high_quality(main, sun)
	if str(style.get("style")) == "realistic":
		_apply_realistic(main, sun, env)


## The realistic style: a filmic tone curve made for photographs (AgX, with its contrast raised to
## 1.6 for a clean, deep sky: the user preferred that to AgX's default, which looked hazy) without the
## template's colour boost, and a sun with a soft edge; on the desktop renderer (Forward+) also light that
## bounces off the ground and objects (SDFGI), reflections (SSR, on water), ambient occlusion, soft
## four-split shadows and 4x anti-aliasing. The web renderer has the tone curve and colours only.
func _apply_realistic(main: Node, sun: DirectionalLight3D, env: Dictionary) -> void:
	var we := main.get_node_or_null("WorldEnvironment") as WorldEnvironment
	if we == null or we.environment == null:
		return
	var e: Environment = we.environment
	e.adjustment_enabled = false
	e.tonemap_mode = Environment.TONE_MAPPER_AGX
	e.tonemap_agx_contrast = 1.6
	if sun != null:
		sun.light_angular_distance = 0.5
	if RenderingServer.get_current_rendering_method() == "gl_compatibility":
		# The web renderer's AgX has no contrast setting; these bring its ground and grass within a few
		# units of the desktop renderer's (measured on Green Valley under a photographed sky).
		e.adjustment_enabled = true
		e.adjustment_brightness = 0.9
		e.adjustment_contrast = 1.1
		e.adjustment_saturation = 0.95
		return
	e.sdfgi_enabled = true
	e.sdfgi_use_occlusion = true
	e.ssr_enabled = true
	e.ssao_enabled = true
	e.ssao_intensity = 1.4
	e.ssil_enabled = true
	# No glow: a photographed sky is brighter than white in places, and glow would spread over all of it.
	e.glow_enabled = false
	if sun != null:
		sun.directional_shadow_mode = DirectionalLight3D.SHADOW_PARALLEL_4_SPLITS
		sun.shadow_blur = 1.0
	RenderingServer.directional_soft_shadow_filter_set_quality(RenderingServer.SHADOW_QUALITY_SOFT_HIGH)
	get_viewport().msaa_3d = Viewport.MSAA_4X
	realistic_effects = true


## Gives something added after the level was built (the player and its character) the level's style.
func apply_style(node: Node) -> void:
	style.call("apply", node)


## How much the fog covers the sky (fog_sky_affect): little in a clear level, most of it in thick fog.
## The studio's 3D view uses the same rule (level3d.ts, skyFog).
static func sky_fog(density: float) -> float:
	return clampf(density * 12.0, 0.0, 1.0)


## Desktop builds (Forward+) only: ambient occlusion, indirect light, glow on bright things,
## four-split soft sun shadows and 4x anti-aliasing. The tone curve and colours stay as in the
## standard look (a filmic curve such as AgX made this palette grey). The web renderer has none of these.
func _apply_high_quality(main: Node, sun: DirectionalLight3D) -> void:
	var we := main.get_node_or_null("WorldEnvironment") as WorldEnvironment
	if we != null and we.environment != null:
		var e: Environment = we.environment
		e.ssao_enabled = true
		e.ssao_intensity = 1.6
		e.ssil_enabled = true
		e.ssao_radius = 1.2
		e.glow_enabled = true
		e.glow_intensity = 0.4
		e.glow_hdr_threshold = 1.2
	if sun != null:
		sun.directional_shadow_mode = DirectionalLight3D.SHADOW_PARALLEL_4_SPLITS
		sun.shadow_blur = 0.5 if bool(style.call("anime")) else 1.5
		sun.light_angular_distance = 0.5
	RenderingServer.directional_soft_shadow_filter_set_quality(RenderingServer.SHADOW_QUALITY_SOFT_HIGH)
	get_viewport().msaa_3d = Viewport.MSAA_4X
	get_viewport().screen_space_aa = Viewport.SCREEN_SPACE_AA_DISABLED
	high_quality = true


func _build_object(o: Dictionary) -> void:
	var id := str(o.get("id", ""))
	var otype := str(o.get("type", ""))
	if id == "" or nodes.has(id):
		return
	var root: Node3D = null
	match otype:
		"tree":
			root = _tree(o)
		"rock":
			root = _rock(o)
		"collectible":
			root = _collectible(o)
		"npc":
			root = _npc(o)
		"gate":
			root = _gate(o)
		"zone":
			root = _zone(o)
		"water":
			root = _water(o)
		"sign":
			root = _sign(o)
		"torch":
			root = _torch()
		"model":
			root = _model(o)
		"enemy":
			root = _enemy(o)
		"crate":
			root = _crate(o)
		_:
			return
	root.name = id
	var surface = o.get("material")
	if typeof(surface) == TYPE_DICTIONARY and TEXTURED.has(otype):
		_apply_texture(root, surface, id)
	root.position = Vector3(float(o.get("x", 0.0)), 0.0, float(o.get("z", 0.0)))
	# Positive rotation is clockwise seen from above, matching the studio's top-down map.
	root.rotation_degrees = Vector3(0.0, -float(o.get("rotation", 0.0)), 0.0)
	var s := float(o.get("scale", 1.0))
	# Physics bodies that move keep scale 1 (Godot does not scale them); their shapes carry the size.
	root.scale = Vector3.ONE if MOVING.has(otype) else Vector3(s, s, s)
	add_child(root)
	nodes[id] = root
	types[id] = otype
	if otype == "zone":
		_zone_areas[id] = [root.global_position, float(o.get("radius", 3.0)) * s]
	elif otype == "crate":
		blocks[id] = root
		block_homes[id] = root.global_position
		block_zones[id] = {}


## An imported glTF model (res://assets/...glb or .gltf), placed by its own origin. With "collide" on,
## a box around its meshes blocks the player. A file that cannot be loaded shows as a red box and is
## reported in model_errors.
func _model(o: Dictionary) -> Node3D:
	var root := Node3D.new()
	var id := str(o.get("id", ""))
	var rel := str(o.get("asset", ""))
	var inst := Models.instance(rel)
	if inst == null:
		model_errors[id] = "%s could not be loaded" % (rel if rel != "" else "(no file chosen)")
		root.add_child(_mesh_node(_unit_box(), _mat("#e5484d", 0.0, 0.6), Vector3(0.0, 0.5, 0.0)))
		return root
	root.add_child(inst)
	var box := _bounds(inst, Transform3D.IDENTITY)
	if box.size == Vector3.ZERO:
		box = AABB(Vector3(-0.5, 0.0, -0.5), Vector3.ONE)
	model_bounds[id] = box
	if bool(o.get("collide", true)) and not Engine.is_editor_hint():
		var body := StaticBody3D.new()
		body.name = "Collision"
		body.add_child(_box_shape(box.size, box.get_center()))
		root.add_child(body)
	var clip := str(o.get("animation", ""))
	if clip != "":
		_loop(id, inst, clip, "")
	return root


## Loops an imported model's animation (the named one, or the one suggesting `state`). Problems are
## reported in model_errors; what plays is kept in `animations` for the self-test.
func _loop(id: String, inst: Node3D, clip: String, state: String) -> void:
	var ap := Models.animation_player(inst)
	var clip_name := Models.resolve(ap, clip, state)
	if clip_name == "":
		if clip != "":
			model_errors[id] = "%s has no animation called %s" % [id, clip]
		return
	animation_players[id] = ap
	if not Engine.is_editor_hint():
		Models.play(ap, clip_name, true, 0.0)


## The animation each animated object is playing now (object id -> animation name).
func playing_animations() -> Dictionary:
	var out := {}
	for id in animation_players:
		var ap: AnimationPlayer = animation_players[id]
		out[id] = ap.current_animation if is_instance_valid(ap) and ap.is_playing() else ""
	return out


func _unit_box() -> BoxMesh:
	var m := BoxMesh.new()
	m.size = Vector3.ONE
	return m


## The box around every mesh under `node`, in the coordinates of the node `xform` maps to.
func _bounds(node: Node, xform: Transform3D) -> AABB:
	return Models.bounds(node, xform)


func _make_interactable(node: Node3D, id: String, prompt: String, radius: float) -> void:
	node.add_to_group("gs_interactable")
	node.set_meta("target_id", id)
	node.set_meta("prompt", prompt)
	node.set_meta("interact_radius", radius)


func _billboard(text: String, height: float, font_size: int, color: Color) -> Label3D:
	var label := Label3D.new()
	label.text = text
	label.position = Vector3(0.0, height, 0.0)
	label.billboard = BaseMaterial3D.BILLBOARD_ENABLED
	label.font_size = font_size
	label.pixel_size = 0.005
	label.outline_size = 12
	label.modulate = color
	return label


func _tree(o: Dictionary) -> Node3D:
	var body := StaticBody3D.new()
	var variant := str(o.get("variant", "round"))
	var trunk_h := 2.2
	var trunk_r := 0.28
	if variant == "baobab":
		trunk_h = 3.6
		trunk_r = 0.85
	if _realistic():
		body.add_child(_nature(variant if variant == "tall" or variant == "baobab" else "round", str(o.get("id", ""))))
	else:
		_simple_tree(body, variant, trunk_h, trunk_r)
	var shape := CollisionShape3D.new()
	var cylinder := CylinderShape3D.new()
	cylinder.radius = trunk_r
	cylinder.height = trunk_h
	shape.shape = cylinder
	shape.position = Vector3(0.0, trunk_h / 2.0, 0.0)
	body.add_child(shape)
	return body


## The standard and anime styles' tree: a trunk under a ball, a cone or (baobab) a flat dome of leaves.
func _simple_tree(body: Node3D, variant: String, trunk_h: float, trunk_r: float) -> void:
	var trunk := CylinderMesh.new()
	trunk.top_radius = trunk_r * 0.8
	trunk.bottom_radius = trunk_r
	trunk.height = trunk_h
	body.add_child(_mesh_node(trunk, _mat("#7a5634"), Vector3(0.0, trunk_h / 2.0, 0.0)))
	var canopy := _mat("#4f8a3a" if variant == "baobab" else "#2f7d4a")
	if variant == "tall":
		var cone := CylinderMesh.new()
		cone.top_radius = 0.0
		cone.bottom_radius = 1.4
		cone.height = 4.0
		body.add_child(_mesh_node(cone, canopy, Vector3(0.0, trunk_h + 1.6, 0.0)))
	elif variant == "baobab":
		var crown := SphereMesh.new()
		crown.radius = 2.4
		crown.height = 1.6
		body.add_child(_mesh_node(crown, canopy, Vector3(0.0, trunk_h + 0.5, 0.0)))
	else:
		var ball := SphereMesh.new()
		ball.radius = 1.5
		ball.height = 2.8
		body.add_child(_mesh_node(ball, canopy, Vector3(0.0, trunk_h + 1.0, 0.0)))


func _rock(o: Dictionary) -> Node3D:
	var body := StaticBody3D.new()
	if _realistic():
		body.add_child(_nature("rock", str(o.get("id", ""))))
	else:
		var mesh := SphereMesh.new()
		mesh.radius = 0.9
		mesh.height = 1.2
		mesh.radial_segments = 10
		mesh.rings = 6
		body.add_child(_mesh_node(mesh, _mat("#8a8f96"), Vector3(0.0, 0.45, 0.0)))
	var shape := CollisionShape3D.new()
	var sphere := SphereShape3D.new()
	sphere.radius = 0.8
	shape.shape = sphere
	shape.position = Vector3(0.0, 0.4, 0.0)
	body.add_child(shape)
	return body


## Whether trees and rocks are drawn in detail: the realistic style (nature.gd).
func _realistic() -> bool:
	return str(style.get("style")) == "realistic"


## A detailed tree or rock (nature.gd): one of its shapes, picked by the object's id and turned by an
## amount of its own, so neighbours of one shape still differ. The studio's 3D view builds the same
## (level3d.ts, nature).
func _nature(kind: String, id: String) -> Node3D:
	var holder := Node3D.new()
	holder.name = "Nature"
	holder.rotation.y = Nature.turn_of(id)
	var parts: Array = Nature.meshes(kind, Nature.variant_of(id))
	var solid := MeshInstance3D.new()
	solid.name = "Rock" if kind == "rock" else "Bark"
	solid.mesh = parts[0]
	solid.material_override = Nature.solid_material()
	holder.add_child(solid)
	if parts.size() > 1:
		var leaves := MeshInstance3D.new()
		leaves.name = "Leaves"
		leaves.mesh = parts[1]
		leaves.material_override = Nature.leaf_material()
		holder.add_child(leaves)
	return holder


func _collectible(o: Dictionary) -> Node3D:
	var area := Area3D.new()
	var shape := CollisionShape3D.new()
	var sphere := SphereShape3D.new()
	sphere.radius = 1.1
	shape.shape = sphere
	shape.position = Vector3(0.0, 1.0, 0.0)
	area.add_child(shape)
	var visual := Node3D.new()
	visual.name = "Visual"
	visual.position = Vector3(0.0, 1.1, 0.0)
	var half := CylinderMesh.new()
	half.top_radius = 0.0
	half.bottom_radius = 0.32
	half.height = 0.55
	half.radial_segments = 6
	var crystal := _mat("#f2b84b", 2.2)
	visual.add_child(_mesh_node(half, crystal, Vector3(0.0, 0.27, 0.0)))
	var lower := _mesh_node(half, crystal, Vector3(0.0, -0.27, 0.0))
	lower.rotation_degrees = Vector3(180.0, 0.0, 0.0)
	visual.add_child(lower)
	var glow := OmniLight3D.new()
	glow.light_color = Color("#ffcf73")
	glow.light_energy = 0.8
	glow.omni_range = 3.5
	visual.add_child(glow)
	area.add_child(visual)
	if not Engine.is_editor_hint():
		area.set_script(CollectibleScript)
		area.call("setup", str(o.get("id", "")), str(o.get("kind", "crystal")), str(o.get("label", "")))
		area.connect("collected", _on_collectible_touched)
	return area


func _on_collectible_touched(item_id: String, _kind: String) -> void:
	collect_item(item_id)


func _npc(o: Dictionary) -> Node3D:
	var body := StaticBody3D.new()
	var color := str(o.get("color", "#c8873a"))
	var rel := str(o.get("model", ""))
	if rel != "":
		var inst := Models.instance(rel)
		if inst != null:
			return _character_npc(o, body, inst)
		model_errors[str(o.get("id", ""))] = "%s could not be loaded" % rel
	var torso := CapsuleMesh.new()
	torso.radius = 0.34
	torso.height = 1.5
	body.add_child(_mesh_node(torso, _mat(color), Vector3(0.0, 0.75, 0.0)))
	var head := SphereMesh.new()
	head.radius = 0.24
	head.height = 0.48
	body.add_child(_mesh_node(head, _mat("#6b4a32"), Vector3(0.0, 1.72, 0.0)))
	var headwrap := CylinderMesh.new()
	headwrap.top_radius = 0.2
	headwrap.bottom_radius = 0.26
	headwrap.height = 0.18
	body.add_child(_mesh_node(headwrap, _mat(color), Vector3(0.0, 1.92, 0.0)))
	var shape := CollisionShape3D.new()
	var capsule := CapsuleShape3D.new()
	capsule.radius = 0.36
	capsule.height = 1.9
	shape.shape = capsule
	shape.position = Vector3(0.0, 0.95, 0.0)
	body.add_child(shape)
	var npc_name := str(o.get("name", "Villager"))
	body.add_child(_billboard(npc_name, 2.4, 48, Color.WHITE))
	_make_interactable(body, str(o.get("id", "")), "Talk to %s" % npc_name, 2.6)
	return body


## A villager drawn from an imported character: scaled to its height, facing south at rotation 0
## (glTF characters face +Z) and looping its animation (the named one, or one that suggests idling).
func _character_npc(o: Dictionary, body: StaticBody3D, inst: Node3D) -> Node3D:
	var height := float(o.get("height", 1.8))
	body.add_child(inst)
	Models.fit_height(inst, height)
	var shape := CollisionShape3D.new()
	var capsule := CapsuleShape3D.new()
	capsule.radius = clampf(height * 0.2, 0.2, 1.5)
	capsule.height = maxf(height, capsule.radius * 2.0)
	shape.shape = capsule
	shape.position = Vector3(0.0, capsule.height / 2.0, 0.0)
	body.add_child(shape)
	var npc_name := str(o.get("name", "Villager"))
	body.add_child(_billboard(npc_name, height + 0.5, 48, Color.WHITE))
	var id := str(o.get("id", ""))
	_make_interactable(body, id, "Talk to %s" % npc_name, 2.6)
	_loop(id, inst, str(o.get("animation", "")), "idle")
	return body


## A gate: two pillars, a lintel and a door that sinks when it opens; or an imported gate model drawn in
## their place (its door pieces move with the door). The collision is the same either way.
func _gate(o: Dictionary) -> Node3D:
	var root := Node3D.new()
	var width := float(o.get("width", 5.0))
	var rel := str(o.get("model", ""))
	var inst: Node3D = Models.instance(rel) if rel != "" else null
	if rel != "" and inst == null:
		model_errors[str(o.get("id", ""))] = "%s could not be loaded" % rel
	var stone := _mat("#b9a27a")
	for side in [-1.0, 1.0]:
		var pillar_body := StaticBody3D.new()
		if inst == null:
			var pillar := BoxMesh.new()
			pillar.size = Vector3(0.9, 4.4, 0.9)
			pillar_body.add_child(_mesh_node(pillar, stone, Vector3(0.0, 2.2, 0.0)))
		pillar_body.add_child(_box_shape(Vector3(0.9, 4.4, 0.9), Vector3(0.0, 2.2, 0.0)))
		pillar_body.position = Vector3(float(side) * (width / 2.0 + 0.45), 0.0, 0.0)
		root.add_child(pillar_body)
	var door := StaticBody3D.new()
	door.name = "Door"
	if inst == null:
		var lintel := BoxMesh.new()
		lintel.size = Vector3(width + 1.8, 0.7, 1.0)
		root.add_child(_mesh_node(lintel, stone, Vector3(0.0, 4.75, 0.0)))
		var door_mesh := BoxMesh.new()
		door_mesh.size = Vector3(width, 4.0, 0.35)
		door.add_child(_mesh_node(door_mesh, _mat("#6b4a2a"), Vector3(0.0, 2.0, 0.0)))
		var emblem := CylinderMesh.new()
		emblem.top_radius = 0.6
		emblem.bottom_radius = 0.6
		emblem.height = 0.06
		var emblem_node := _mesh_node(emblem, _mat("#f2b84b", 1.2), Vector3(0.0, 2.4, 0.2))
		emblem_node.rotation_degrees = Vector3(90.0, 0.0, 0.0)
		door.add_child(emblem_node)
	door.add_child(_box_shape(Vector3(width, 4.0, 0.35), Vector3(0.0, 2.0, 0.0)))
	root.add_child(door)
	if inst != null:
		root.add_child(inst)
		Models.fit_gate(inst, width)
		models_used[str(o.get("id", ""))] = rel
		# The door's pieces move to the door (which stands at the gate's origin), keeping where they are.
		var pieces := Models.door_parts(inst)
		for piece in pieces:
			var where := Models.relative_transform(root, piece)
			# They leave the model's scene, so they no longer belong to it.
			_clear_owner(piece)
			piece.get_parent().remove_child(piece)
			door.add_child(piece)
			piece.transform = where
		door_pieces[str(o.get("id", ""))] = pieces.size()
	if not Engine.is_editor_hint():
		root.set_script(GateScript)
	return root


func _clear_owner(node: Node) -> void:
	node.owner = null
	for child in node.get_children():
		_clear_owner(child)


func _zone(o: Dictionary) -> Node3D:
	var area := Area3D.new()
	var radius := float(o.get("radius", 3.0))
	var shape := CollisionShape3D.new()
	var cylinder := CylinderShape3D.new()
	cylinder.radius = radius
	cylinder.height = 3.0
	shape.shape = cylinder
	shape.position = Vector3(0.0, 1.5, 0.0)
	area.add_child(shape)
	if o.get("visible", true) == true:
		var ring := TorusMesh.new()
		ring.inner_radius = maxf(radius - 0.18, 0.1)
		ring.outer_radius = radius
		area.add_child(_mesh_node(ring, _mat("#3cc9b4", 1.5), Vector3(0.0, 0.05, 0.0)))
		area.add_child(_billboard(str(o.get("label", "Zone")), 2.6, 40, Color("#c9fff6")))
	if not Engine.is_editor_hint():
		area.set_script(ZoneScript)
		area.call("setup", str(o.get("id", "")))
		area.connect("entered", _on_zone_touched)
	return area


func _on_zone_touched(zone_id: String) -> void:
	zone_entered.emit(zone_id)


func _water(o: Dictionary) -> Node3D:
	var root := Node3D.new()
	var r := float(o.get("radius", 6.0))
	var disc := CylinderMesh.new()
	disc.top_radius = r
	disc.bottom_radius = r
	disc.height = 0.08
	disc.radial_segments = 48
	root.add_child(_mesh_node(disc, _water_material(), Vector3(0.0, 0.03, 0.0)))
	return root


## Water's material (shaders/water.gdshader), shared by every pool in the level.
func _water_material() -> Material:
	var horizon := str((world.get("environment", {}) as Dictionary).get("skyHorizon", "#b8d4ec"))
	var key := "water|" + horizon
	if _materials.has(key):
		return _materials[key]
	var m := ShaderMaterial.new()
	m.shader = WaterShader
	m.set_shader_parameter("water_color", Color("#2f7fb8"))
	m.set_shader_parameter("sky_color", Color(horizon))
	_materials[key] = m
	return m


func _sign(o: Dictionary) -> Node3D:
	var body := StaticBody3D.new()
	var wood := _mat("#8a6239")
	var post := BoxMesh.new()
	post.size = Vector3(0.14, 1.6, 0.14)
	body.add_child(_mesh_node(post, wood, Vector3(0.0, 0.8, 0.0)))
	var board := BoxMesh.new()
	board.size = Vector3(1.5, 0.75, 0.1)
	body.add_child(_mesh_node(board, wood, Vector3(0.0, 1.55, 0.0)))
	body.add_child(_box_shape(Vector3(1.5, 1.9, 0.3), Vector3(0.0, 0.95, 0.0)))
	body.add_child(_billboard("Sign", 2.2, 32, Color("#ffe3a3")))
	_make_interactable(body, str(o.get("id", "")), "Read the sign", 2.4)
	body.set_meta("sign_text", str(o.get("text", "")))
	return body


func _torch() -> Node3D:
	var root := Node3D.new()
	var post := CylinderMesh.new()
	post.top_radius = 0.07
	post.bottom_radius = 0.09
	post.height = 1.8
	root.add_child(_mesh_node(post, _mat("#5a4030"), Vector3(0.0, 0.9, 0.0)))
	var flame := SphereMesh.new()
	flame.radius = 0.16
	flame.height = 0.36
	root.add_child(_mesh_node(flame, _mat("#ff9b3d", 3.0), Vector3(0.0, 1.95, 0.0)))
	var light := OmniLight3D.new()
	light.light_color = Color("#ffb46b")
	light.light_energy = 1.4
	light.omni_range = 7.0
	light.position = Vector3(0.0, 2.0, 0.0)
	root.add_child(light)
	return root


## An enemy: a thorn beetle drawn from simple shapes (or an imported character scaled to its height),
## on a CharacterBody3D that keeps scale 1. The behaviour (enemy.gd) is attached only in the game.
## Shapes and sizes match level3d.ts (the studio's 3D view).
func _enemy(o: Dictionary) -> Node3D:
	var s := float(o.get("scale", 1.0))
	var body := CharacterBody3D.new()
	var visual := Node3D.new()
	visual.name = "Visual"
	body.add_child(visual)
	var id := str(o.get("id", ""))
	var radius := 0.55 * s
	var height := 1.0 * s
	var rel := str(o.get("model", ""))
	var inst: Node3D = Models.instance(rel) if rel != "" else null
	if rel != "" and inst == null:
		model_errors[id] = "%s could not be loaded" % rel
	if inst != null:
		height = float(o.get("height", 1.8)) * s
		visual.add_child(inst)
		Models.fit_height(inst, height)
		# glTF characters face +Z; the enemy walks towards -Z.
		inst.rotation_degrees.y = 180.0
		# As wide as the model's narrower side (a beetle), but never narrower than a person (a quarter of its height).
		var fitted := Models.bounds(inst, Transform3D.IDENTITY)
		radius = clampf(maxf(height * 0.25, minf(fitted.size.x, fitted.size.z) * 0.5), 0.2, 1.5)
		models_used[id] = rel
	else:
		# Its own shell material (not the shared cache), so the hit squash and colour stay per enemy.
		var shell := StandardMaterial3D.new()
		shell.albedo_color = Color(str(o.get("color", "#5b3d7a")))
		shell.roughness = 0.45
		shell.metallic = 0.15
		var dome := SphereMesh.new()
		dome.radius = 0.55 * s
		dome.height = 0.7 * s
		visual.add_child(_mesh_node(dome, shell, Vector3(0.0, 0.45 * s, 0.05 * s)))
		var belly := SphereMesh.new()
		belly.radius = 0.45 * s
		belly.height = 0.4 * s
		visual.add_child(_mesh_node(belly, _mat("#2b2233"), Vector3(0.0, 0.25 * s, 0.05 * s)))
		var head := SphereMesh.new()
		head.radius = 0.26 * s
		head.height = 0.44 * s
		visual.add_child(_mesh_node(head, _mat("#2b2233"), Vector3(0.0, 0.42 * s, -0.5 * s)))
		var eye := SphereMesh.new()
		eye.radius = 0.07 * s
		eye.height = 0.14 * s
		for side in [-1.0, 1.0]:
			visual.add_child(_mesh_node(eye, _mat("#ffd23f", 2.5), Vector3(side * 0.11 * s, 0.5 * s, -0.7 * s)))
		var thorn := CylinderMesh.new()
		thorn.top_radius = 0.0
		thorn.bottom_radius = 0.09 * s
		thorn.height = 0.32 * s
		thorn.radial_segments = 6
		for z in [-0.15, 0.12, 0.38]:
			var spike := _mesh_node(thorn, _mat("#7bd36a"), Vector3(0.0, 0.88 * s - absf(float(z)) * 0.25 * s, float(z) * s))
			spike.rotation_degrees = Vector3(-20.0, 0.0, 0.0)
			visual.add_child(spike)
	var shape := CollisionShape3D.new()
	var capsule := CapsuleShape3D.new()
	capsule.radius = radius
	capsule.height = maxf(height, radius * 2.0)
	shape.shape = capsule
	shape.position = Vector3(0.0, capsule.height / 2.0, 0.0)
	body.add_child(shape)
	body.set_meta("radius", radius)
	if not Engine.is_editor_hint():
		body.set_script(EnemyScript)
		body.call("setup", o, s, visual, radius)
		body.connect("defeated", _on_enemy_defeated)
	return body


## A block the player pushes: a box on a RigidBody3D that cannot tip over (wood or stone look, or an
## imported model fitted to the block). Shapes and sizes match level3d.ts.
func _crate(o: Dictionary) -> Node3D:
	var size := BLOCK_SIZE * float(o.get("scale", 1.0))
	var body := RigidBody3D.new()
	body.mass = 30.0 * pow(size / BLOCK_SIZE, 3.0)
	body.axis_lock_angular_x = true
	body.axis_lock_angular_y = true
	body.axis_lock_angular_z = true
	body.linear_damp = 2.0
	body.can_sleep = true
	var surface := PhysicsMaterial.new()
	surface.friction = 0.5
	body.physics_material_override = surface
	var rel := str(o.get("model", ""))
	var inst: Node3D = Models.instance(rel) if rel != "" else null
	if rel != "" and inst == null:
		model_errors[str(o.get("id", ""))] = "%s could not be loaded" % rel
	if inst != null:
		body.add_child(inst)
		Models.fit_box(inst, size)
		models_used[str(o.get("id", ""))] = rel
	else:
		var stone := str(o.get("variant", "wood")) == "stone"
		var box := BoxMesh.new()
		box.size = Vector3(size, size, size)
		body.add_child(_mesh_node(box, _mat("#8d8a80" if stone else "#9a6b3c"), Vector3(0.0, size / 2.0, 0.0)))
		# A band around the middle: carved for stone, a plank for wood.
		var band := BoxMesh.new()
		band.size = Vector3(size * 1.02, size * 0.16, size * 1.02)
		body.add_child(_mesh_node(band, _mat("#6f6c63" if stone else "#6b4a2a"), Vector3(0.0, size / 2.0, 0.0)))
	body.add_child(_box_shape(Vector3(size, size, size), Vector3(0.0, size / 2.0, 0.0)))
	body.add_to_group("gs_pushable")
	body.set_meta("block_id", str(o.get("id", "")))
	if Engine.is_editor_hint():
		body.freeze = true
	return body


# ---- Grass (grass.gd) -------------------------------------------------------------------------

## Grass over the ground when the level asks for it (environment.grass, 0 to 1), kept out of water
## and visible zones.
func _add_grass(width: float, depth: float) -> void:
	var env: Dictionary = world.get("environment", {})
	var density := clampf(float(env.get("grass", 0.0)), 0.0, 1.0)
	if density <= 0.0:
		return
	var keep_out := []
	for o in world.get("objects", []):
		if typeof(o) != TYPE_DICTIONARY:
			continue
		var otype := str(o.get("type", ""))
		var s := float(o.get("scale", 1.0))
		if otype == "water":
			keep_out.append([float(o.get("x", 0.0)), float(o.get("z", 0.0)), float(o.get("radius", 6.0)) * s + 0.3])
		elif otype == "zone" and o.get("visible", true) == true:
			keep_out.append([float(o.get("x", 0.0)), float(o.get("z", 0.0)), float(o.get("radius", 3.0)) * s + 0.2])
	grass = GrassScript.new()
	add_child(grass)
	grass.call("build", width, depth, density, clampf(float(env.get("groundVariation", 0.0)), 0.0, 1.0), Color(str(env.get("ground", "#5a7d3c"))), keep_out)


# ---- Sun shadows in web builds (see web_shadows and sun_shadows.gd) ------------------------

func _add_sun_shadows(width: float, depth: float) -> void:
	var ground := get_node_or_null("Ground")
	if ground != null:
		SunShadows.exclude(ground)
	for id in nodes:
		if ["water", "zone"].has(str(types.get(id, ""))):
			SunShadows.exclude(nodes[id])
	SunShadows.exclude_non_casters(self)
	drawn_shadows = SunShadows.new()
	add_child(drawn_shadows)
	drawn_shadows.call("setup", _sun_dir, width, depth)
	if ground_material != null:
		drawn_shadows.call("apply_to", ground_material)
	if grass != null:
		drawn_shadows.call("apply_to", grass.get("material"))

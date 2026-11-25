extends Node3D
## Sun shadows for web builds. Godot 4.7's Compatibility renderer (the only one a web build has) draws a
## shadow-casting light in an extra pass that it converts for the screen before adding it to the first,
## so everything the sun lights comes out far too bright (see world_builder.gd, web_shadows). There the
## sun casts no shadows itself; instead a camera at the sun's position draws the level's objects into a
## picture, of which only the outline is kept, and the ground's material (shaders/ground.gdshader) takes
## away the sun's light wherever that outline covers it, keeping the sky's. Things that move (the
## player, villagers, enemies, blocks) cast theirs as they go. Shadows fall on the ground only.

## Layer 20: drawn by the game's camera but not by the sun's (the ground, water, zones, labels, and
## anything that casts no shadow in the desktop renderer).
const NO_SHADOW_LAYER := 1 << 19

var viewport: SubViewport
var camera: Camera3D
var extent := 100.0
var pixels := 2048


func _enter_tree() -> void:
	if not get_tree().node_added.is_connected(_on_node_added):
		get_tree().node_added.connect(_on_node_added)


## Things added while the game runs (a staff swing, an enemy's health bar) follow the same rule.
func _on_node_added(node: Node) -> void:
	if node is Label3D or (node is GeometryInstance3D and (node as GeometryInstance3D).cast_shadow == GeometryInstance3D.SHADOW_CASTING_SETTING_OFF):
		(node as VisualInstance3D).layers = NO_SHADOW_LAYER


## sun_dir: the direction the sunlight travels. width, depth: the ground's size in metres.
func setup(sun_dir: Vector3, width: float, depth: float, size: int = 2048) -> void:
	name = "SunShadows"
	pixels = size
	var d := sun_dir.normalized()
	extent = sqrt(width * width + depth * depth) + 24.0
	viewport = SubViewport.new()
	viewport.name = "SunView"
	viewport.size = Vector2i(pixels, pixels)
	viewport.transparent_bg = true
	viewport.msaa_3d = Viewport.MSAA_DISABLED
	viewport.debug_draw = Viewport.DEBUG_DRAW_UNSHADED
	viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	viewport.positional_shadow_atlas_size = 0
	add_child(viewport)
	camera = Camera3D.new()
	camera.projection = Camera3D.PROJECTION_ORTHOGONAL
	camera.size = extent
	camera.near = 1.0
	camera.far = 600.0
	camera.cull_mask = 0xFFFFF & ~NO_SHADOW_LAYER
	var env := Environment.new()
	env.background_mode = Environment.BG_CLEAR_COLOR
	camera.environment = env
	# A camera inside a SubViewport is placed in that viewport's own space: its transform is global.
	var up := Vector3.UP if absf(d.y) < 0.99 else Vector3.FORWARD
	camera.transform = Transform3D(Basis.looking_at(d, up), -d * 250.0)
	camera.current = true
	viewport.add_child(camera)


## Hands the outline to the ground's material (shaders/ground.gdshader), which darkens where it falls.
func apply_to(material: ShaderMaterial) -> void:
	material.set_shader_parameter("outline_shadows", true)
	material.set_shader_parameter("outline", viewport.get_texture())
	material.set_shader_parameter("to_sun", Projection(camera.transform.affine_inverse()))
	material.set_shader_parameter("extent", extent)
	material.set_shader_parameter("texel", 1.0 / float(pixels))


## Leaves everything under node out of the sun's picture: it casts no shadow.
static func exclude(node: Node) -> void:
	if node is VisualInstance3D:
		(node as VisualInstance3D).layers = NO_SHADOW_LAYER
	for child in node.get_children():
		exclude(child)


## Leaves out of the sun's picture what casts no shadow in the desktop renderer, and labels.
static func exclude_non_casters(node: Node) -> void:
	if node is Label3D or (node is GeometryInstance3D and (node as GeometryInstance3D).cast_shadow == GeometryInstance3D.SHADOW_CASTING_SETTING_OFF):
		(node as VisualInstance3D).layers = NO_SHADOW_LAYER
	for child in node.get_children():
		exclude_non_casters(child)

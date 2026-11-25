extends Node3D
## One footballer, drawn in the team's colours with a number over the head. match.gd decides where it
## runs (the player's input for the one you control, the computer's choices for the rest) and calls
## move(); this script keeps it on the pitch and animates the run.

const Ball := preload("res://scripts/ball.gd")
const RADIUS := 0.35
const SKINS := [Color("#8d5524"), Color("#c68642"), Color("#e0ac69"), Color("#5c3a21"), Color("#f1c27d")]

var team := "home"
## Place in the line-up (0 keeps goal), which sets the kick-off spot; the shirt number is separate.
var slot := 0
var number := 1
var player_name := ""
var keeper := false
## Skills from the squad (1 to 10, 5 standard): running speed, shot power and aim, tackles won.
var pace := 5
var shooting := 5
var tackling := 5
## Where it lines up for a kick-off.
var spot := Vector3.ZERO
var velocity := Vector3.ZERO
var facing := Vector3.RIGHT
## Seconds before it may touch the ball again (after kicking it), tackle again, or move again (after a failed tackle).
var kick_wait := 0.0
var tackle_wait := 0.0
var stunned := 0.0
## The computer's next decision time and its current plan (match.gd).
var think := 0.0
var aim := Vector3.ZERO
var controlled := false

var _body: Node3D
var _legs: Array = []
var _ring: MeshInstance3D
var _label: Label3D
var _stride := 0.0


func build(shirt: Color, shorts: Color, keeper_shirt: Color, skin_index: int) -> void:
	_body = Node3D.new()
	_body.name = "Body"
	add_child(_body)
	var top := keeper_shirt if keeper else shirt
	var socks := top.darkened(0.25)
	var skin: Color = SKINS[skin_index % SKINS.size()]
	_part(_capsule(0.3, 0.75), _mat(top), Vector3(0.0, 1.12, 0.0))
	_part(_cylinder(0.31, 0.27, 0.32), _mat(shorts), Vector3(0.0, 0.78, 0.0))
	for side in [-1.0, 1.0]:
		var leg := Node3D.new()
		leg.position = Vector3(0.0, 0.66, side * 0.13)
		_body.add_child(leg)
		var shin := MeshInstance3D.new()
		shin.mesh = _capsule(0.09, 0.62)
		shin.material_override = _mat(socks)
		shin.position = Vector3(0.0, -0.3, 0.0)
		leg.add_child(shin)
		_legs.append(leg)
	_part(_sphere(0.17), _mat(skin), Vector3(0.0, 1.62, 0.0))
	for side in [-1.0, 1.0]:
		var arm := _part(_capsule(0.07, 0.55), _mat(skin), Vector3(0.0, 1.15, side * 0.36))
		arm.rotation_degrees = Vector3(side * 8.0, 0.0, 0.0)
	_label = Label3D.new()
	_label.text = str(number)
	_label.position = Vector3(0.0, 2.15, 0.0)
	_label.billboard = BaseMaterial3D.BILLBOARD_ENABLED
	_label.font_size = 40
	_label.pixel_size = 0.006
	_label.outline_size = 10
	_label.modulate = top.lightened(0.35)
	_label.no_depth_test = true
	add_child(_label)
	var ring := TorusMesh.new()
	ring.inner_radius = 0.5
	ring.outer_radius = 0.62
	_ring = MeshInstance3D.new()
	_ring.mesh = ring
	_ring.material_override = _mat(Color("#ffd23f"), 1.5)
	_ring.scale = Vector3(1.0, 0.1, 1.0)
	_ring.position = Vector3(0.0, 0.03, 0.0)
	_ring.visible = false
	add_child(_ring)
	add_child(Ball.Shade.make(0.42))


func set_controlled(on: bool) -> void:
	controlled = on
	if _ring != null:
		_ring.visible = on
	if _label != null:
		# The footballer you control shows its name too.
		_label.text = "%d %s" % [number, player_name] if on and player_name != "" else str(number)
		_label.font_size = 44 if on else 40


## Pace as a factor of the standard running speed: 0.88 at 1, 1.0 at 5, 1.15 at 10.
func pace_factor() -> float:
	return 0.85 + 0.03 * float(pace)


## Shooting as a factor of the standard shot speed: 0.92 at 1, 1.0 at 5, 1.1 at 10.
func shot_factor() -> float:
	return 0.9 + 0.02 * float(shooting)


## Tackling as a factor of the standard chance of winning a tackle: 0.6 at 1, 1.0 at 5, 1.5 at 10.
func tackle_factor() -> float:
	return 0.5 + 0.1 * float(tackling)


## Moves by `velocity` for `delta` seconds, kept inside the boards, and turns to face where it runs.
func move(delta: float, half_length: float, half_width: float) -> void:
	position += velocity * delta
	position.x = clampf(position.x, -half_length + RADIUS, half_length - RADIUS)
	position.z = clampf(position.z, -half_width + RADIUS, half_width - RADIUS)
	position.y = 0.0
	var flat := Vector3(velocity.x, 0.0, velocity.z)
	if flat.length() > 0.3:
		facing = facing.slerp(flat.normalized(), clampf(delta * 12.0, 0.0, 1.0)).normalized()
	rotation.y = atan2(-facing.z, facing.x)
	var shade := get_node_or_null("Shade") as Node3D
	if shade != null:
		shade.global_position = Vector3(global_position.x, 0.015, global_position.z)
	_animate(delta, flat.length())


func _animate(delta: float, speed: float) -> void:
	if _body == null:
		return
	_stride += delta * speed * 2.2
	var swing := sin(_stride) * clampf(speed / 6.0, 0.0, 1.0) * 0.7
	if _legs.size() == 2:
		(_legs[0] as Node3D).rotation.z = swing
		(_legs[1] as Node3D).rotation.z = -swing
	_body.position.y = absf(sin(_stride)) * 0.05 * clampf(speed / 6.0, 0.0, 1.0)
	_body.rotation.z = -clampf(speed / 6.0, 0.0, 1.0) * 0.12


func _part(mesh: Mesh, material: Material, pos: Vector3) -> MeshInstance3D:
	var mi := MeshInstance3D.new()
	mi.mesh = mesh
	mi.material_override = material
	mi.position = pos
	_body.add_child(mi)
	return mi


static func _mat(c: Color, emission: float = 0.0) -> StandardMaterial3D:
	var m := StandardMaterial3D.new()
	m.albedo_color = c
	m.roughness = 0.75
	if emission > 0.0:
		m.emission_enabled = true
		m.emission = c
		m.emission_energy_multiplier = emission
	return m


static func _capsule(radius: float, height: float) -> CapsuleMesh:
	var m := CapsuleMesh.new()
	m.radius = radius
	m.height = height
	return m


static func _cylinder(top: float, bottom: float, height: float) -> CylinderMesh:
	var m := CylinderMesh.new()
	m.top_radius = top
	m.bottom_radius = bottom
	m.height = height
	return m


static func _sphere(radius: float) -> SphereMesh:
	var m := SphereMesh.new()
	m.radius = radius
	m.height = radius * 2.0
	return m

extends Node3D
## The ball. It rolls with friction, can be lifted (a chip or a deflection), bounces off the boards and
## the posts, and reports when it crosses a goal line between the posts and under the crossbar. While a
## player holds it (dribbling), match.gd moves it and nothing here runs.

signal goal_crossed(side: String)
signal bounced()

const RADIUS := 0.22
const GRAVITY := 9.8
## Rolling: speed falls by a constant amount plus a share of itself every second.
const ROLL_DECEL := 1.1
const ROLL_DRAG := 0.45
const BOARD_BOUNCE := 0.65
const CROSSBAR := 2.0
const GOAL_DEPTH := 1.2

var velocity := Vector3.ZERO
## The footballer dribbling it (null while it is loose), and the last one to touch it.
var holder: Node3D = null
var last_touch: Node3D = null
## "" while in play; "left" or "right" once it has gone into that goal.
var in_goal := ""
var half_length := 20.0
var half_width := 12.0
var goal_half := 2.0
var bounces := 0
var _visual: Node3D
var _shade: MeshInstance3D


func _ready() -> void:
	_visual = Node3D.new()
	_visual.name = "Visual"
	add_child(_visual)
	var sphere := SphereMesh.new()
	sphere.radius = RADIUS
	sphere.height = RADIUS * 2.0
	var white := StandardMaterial3D.new()
	white.albedo_color = Color("#f6f6f2")
	white.roughness = 0.5
	var leather := MeshInstance3D.new()
	leather.mesh = sphere
	leather.material_override = white
	_visual.add_child(leather)
	# Dark patches, so the ball is seen to roll.
	var patch := SphereMesh.new()
	patch.radius = RADIUS * 0.38
	patch.height = RADIUS * 0.76
	var dark := StandardMaterial3D.new()
	dark.albedo_color = Color("#1e2533")
	for dir in [Vector3.UP, Vector3.DOWN, Vector3.LEFT, Vector3.RIGHT, Vector3.FORWARD, Vector3.BACK]:
		var p := MeshInstance3D.new()
		p.mesh = patch
		p.material_override = dark
		p.position = dir * RADIUS * 0.72
		_visual.add_child(p)
	_shade = Shade.make(RADIUS * 1.6)
	add_child(_shade)


func setup(length: float, width: float, goal_width: float) -> void:
	half_length = length / 2.0
	half_width = width / 2.0
	goal_half = goal_width / 2.0


## Puts the ball still at a spot on the ground (kick-offs).
func place(at: Vector3) -> void:
	position = Vector3(at.x, RADIUS, at.z)
	velocity = Vector3.ZERO
	holder = null
	in_goal = ""


func kick(by: Node3D, direction: Vector3, speed: float, lift: float = 0.0) -> void:
	holder = null
	last_touch = by
	var flat := Vector3(direction.x, 0.0, direction.z)
	if flat.length() < 0.001:
		flat = Vector3.RIGHT
	velocity = flat.normalized() * speed + Vector3.UP * lift


func speed_on_ground() -> float:
	return Vector2(velocity.x, velocity.z).length()


func step(delta: float) -> void:
	if holder != null:
		_roll(delta, holder.get("velocity"))
		_shade_at()
		return
	if in_goal != "":
		# In the net: slow to a stop inside the goal.
		velocity = velocity * maxf(0.0, 1.0 - 6.0 * delta)
		position += velocity * delta
		var back := half_length + GOAL_DEPTH - RADIUS
		position.x = clampf(position.x, -back, back)
		position.z = clampf(position.z, -goal_half + RADIUS, goal_half - RADIUS)
		position.y = maxf(position.y, RADIUS)
		_shade_at()
		return
	if position.y > RADIUS + 0.001 or velocity.y > 0.0:
		velocity.y -= GRAVITY * delta
	position += velocity * delta
	if position.y < RADIUS:
		position.y = RADIUS
		velocity.y = -velocity.y * 0.45 if velocity.y < -1.5 else 0.0
	if position.y <= RADIUS + 0.01:
		var flat := Vector2(velocity.x, velocity.z)
		var speed := flat.length()
		if speed > 0.0:
			var slower := maxf(0.0, speed - (ROLL_DECEL + speed * ROLL_DRAG) * delta)
			flat *= slower / speed
			velocity.x = flat.x
			velocity.z = flat.y
	# The side boards.
	if absf(position.z) > half_width - RADIUS:
		position.z = signf(position.z) * (half_width - RADIUS)
		velocity.z = -velocity.z * BOARD_BOUNCE
		_bounce()
	# The end boards, or the goal between the posts.
	if absf(position.x) > half_length - RADIUS:
		var mouth := absf(position.z) < goal_half - RADIUS * 0.5 and position.y < CROSSBAR
		if not mouth:
			position.x = signf(position.x) * (half_length - RADIUS)
			velocity.x = -velocity.x * BOARD_BOUNCE
			_bounce()
		elif absf(position.x) > half_length + RADIUS:
			in_goal = "right" if position.x > 0.0 else "left"
			goal_crossed.emit(in_goal)
	_roll(delta, velocity)
	_shade_at()


func _bounce() -> void:
	if Vector2(velocity.x, velocity.z).length() > 2.0:
		bounces += 1
		bounced.emit()


func _roll(delta: float, v) -> void:
	var flat := Vector3(float(v.x), 0.0, float(v.z))
	var speed := flat.length()
	if speed < 0.01:
		return
	var axis := Vector3.UP.cross(flat / speed)
	_visual.rotate(axis, speed * delta / RADIUS)


func _shade_at() -> void:
	_shade.global_position = Vector3(global_position.x, 0.02, global_position.z)


## A soft dark disc on the grass under something (the template draws no real shadows).
class Shade:
	static func make(radius: float) -> MeshInstance3D:
		var disc := CylinderMesh.new()
		disc.top_radius = radius
		disc.bottom_radius = radius
		disc.height = 0.01
		disc.radial_segments = 20
		var m := StandardMaterial3D.new()
		m.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
		m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
		m.albedo_color = Color(0.02, 0.06, 0.02, 0.35)
		var mi := MeshInstance3D.new()
		mi.name = "Shade"
		mi.mesh = disc
		mi.material_override = m
		mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
		mi.top_level = true
		return mi

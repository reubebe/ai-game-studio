extends CharacterBody3D
## Third-person explorer: moves relative to the camera, mouse look, sprint, jump, interact, and in
## levels with enemies hearts and a staff attack (F or a click). Walking into a block pushes it.

signal interact_requested(target_id: String)
signal focus_changed(prompt: String)
## An enemy took hearts (the rules' Hurt Player does not send this).
signal hurt(source_id: String, amount: int)
## No hearts left; the player is already back at the spawn point with full health.
signal defeated(source_id: String)
signal health_changed(health: int, max_health: int)
signal swung(hit_ids: Array)

const InputSetup := preload("res://scripts/input_setup.gd")
const Models := preload("res://scripts/models.gd")
## Seconds the player blinks and cannot be hurt after a hit (and after starting again).
const INVULNERABLE := 1.0
const SWING_COOLDOWN := 0.4
const SWING_SECONDS := 0.22
## The staff reaches this far beyond the enemy's body, within this angle either side of straight ahead.
const SWING_REACH := 2.0
const SWING_HALF_ANGLE := 65.0
## How fast a pushed block slides (metres per second).
const PUSH_SPEED := 2.4

@export var speed := 6.0
@export var sprint_multiplier := 1.7
@export var jump_velocity := 5.5
@export var mouse_sensitivity := 0.0025

@onready var camera_arm: SpringArm3D = $CameraArm
@onready var body_visual: Node3D = $Body

var gravity := 9.8
var yaw := 0.0
var pitch := -0.32
var controls_enabled := true
var spawn_point := Vector3(0.0, 1.0, 0.0)
var focus: Node3D = null
## The imported character drawn instead of the capsule (null without one), why it could not be
## loaded, its AnimationPlayer, the animation for each state and the state shown now.
var character: Node3D = null
var character_error := ""
var anim: AnimationPlayer = null
var clips := {}
var anim_state := ""
var _air_time := 0.0
## Hearts: max_health from the level (3 when it does not say), health now.
var max_health := 3
var health := 3
## Seconds left blinking after a hit; nothing hurts the player meanwhile.
var invulnerable := 0.0
## The block being pushed this frame ("" for none), swings made, and when the next swing may start.
var pushing := ""
var swings := 0
var _swing_wait := 0.0
var _swing_time := 0.0
var _slash: MeshInstance3D = null
var _knock := Vector3.ZERO


func _ready() -> void:
	InputSetup.ensure_actions()
	gravity = float(ProjectSettings.get_setting("physics/3d/default_gravity", 9.8))
	camera_arm.add_excluded_object(get_rid())
	spawn_point = global_position
	_slash = _make_slash()
	_slash.visible = false
	body_visual.add_child(_slash)


func configure(settings: Dictionary) -> void:
	speed = float(settings.get("speed", speed))
	sprint_multiplier = float(settings.get("sprintMultiplier", sprint_multiplier))
	jump_velocity = float(settings.get("jumpVelocity", jump_velocity))
	camera_arm.spring_length = float(settings.get("cameraDistance", camera_arm.spring_length))
	var spawn: Dictionary = settings.get("spawn", {})
	spawn_point = Vector3(float(spawn.get("x", 0.0)), 1.0, float(spawn.get("z", 0.0)))
	max_health = clampi(int(settings.get("health", 3)), 1, 20)
	health = max_health
	set_character(settings.get("character", null))
	respawn()
	health_changed.emit(health, max_health)


## Shows an imported character instead of the capsule (or the capsule again for null). The model is
## scaled to its height, turned (glTF characters face +Z; the body faces -Z) and animated by state.
func set_character(c) -> void:
	if character != null:
		character.queue_free()
	character = null
	anim = null
	clips = {}
	anim_state = ""
	character_error = ""
	var capsule := true
	if typeof(c) == TYPE_DICTIONARY:
		var rel := str(c.get("asset", ""))
		var inst := Models.instance(rel)
		if inst == null:
			character_error = "%s could not be loaded" % rel
		else:
			inst.name = "Character"
			body_visual.add_child(inst)
			character = inst
			Models.fit_height(inst, float(c.get("height", 1.8)))
			inst.rotation_degrees.y = float(c.get("turn", 180.0))
			capsule = false
			anim = Models.animation_player(inst)
			for state in ["idle", "walk", "run", "jump"]:
				clips[state] = Models.resolve(anim, str(c.get(state, "")), state)
	$Body/Mesh.visible = capsule
	$Body/Visor.visible = capsule
	_animate("idle")


## Plays the animation for a state. Running falls back to walking and the reverse; with no jump
## animation the current one carries on in the air.
func _animate(state: String) -> void:
	if anim == null or state == anim_state:
		return
	var clip := str(clips.get(state, ""))
	if clip == "" and state == "run":
		clip = str(clips.get("walk", ""))
	elif clip == "" and state == "walk":
		clip = str(clips.get("run", ""))
	if clip == "" and state == "jump":
		return
	if clip == "":
		clip = str(clips.get("idle", ""))
	if Models.play(anim, clip, state != "jump", 0.18):
		anim_state = state


func respawn() -> void:
	global_position = spawn_point
	velocity = Vector3.ZERO
	_knock = Vector3.ZERO
	yaw = 0.0


## An enemy's touch: takes `amount` hearts unless the player is still blinking from the last hit, and
## knocks the player away from `from`. True when it hurt.
func hurt_by(amount: int, source_id: String, from: Vector3) -> bool:
	if invulnerable > 0.0 or health <= 0:
		return false
	var away := (global_position - from) * Vector3(1.0, 0.0, 1.0)
	_knock = (away.normalized() if away.length() > 0.01 else Vector3.BACK) * 7.0
	velocity.y = 3.0
	invulnerable = INVULNERABLE
	_set_health(health - maxi(amount, 0))
	hurt.emit(source_id, amount)
	if health <= 0:
		_fall(source_id)
	return true


## The rules' Hurt Player: takes hearts even while blinking, without On Player Hurt.
func hurt_by_rules(amount: int) -> void:
	if amount <= 0 or health <= 0:
		return
	_set_health(health - amount)
	if health <= 0:
		_fall("rules")


func heal(amount: int) -> void:
	if amount > 0:
		_set_health(mini(max_health, health + amount))


## Sets hearts directly (restoring saved progress).
func set_health(value: int) -> void:
	_set_health(clampi(value, 1, max_health))


func _set_health(value: int) -> void:
	value = clampi(value, 0, max_health)
	if value == health:
		return
	health = value
	health_changed.emit(health, max_health)


## Out of hearts: back to the spawn point with full health, blinking for a moment.
func _fall(source_id: String) -> void:
	respawn()
	invulnerable = INVULNERABLE * 1.5
	_set_health(max_health)
	defeated.emit(source_id)


## Swings the staff where the camera looks: every enemy within reach in front takes a hit. Returns
## the ids hit ([] while the last swing is still recovering).
func swing() -> Array:
	if _swing_wait > 0.0 or not controls_enabled:
		return []
	_swing_wait = SWING_COOLDOWN
	_swing_time = SWING_SECONDS
	swings += 1
	body_visual.rotation.y = yaw
	var forward := Basis(Vector3.UP, yaw) * Vector3.FORWARD
	var hits: Array = []
	for node in get_tree().get_nodes_in_group("gs_enemy"):
		var enemy := node as Node3D
		if enemy == null or not enemy.is_visible_in_tree() or enemy.get("is_defeated") == true:
			continue
		var to := (enemy.global_position - global_position) * Vector3(1.0, 0.0, 1.0)
		if to.length() > SWING_REACH + float(enemy.get("radius")):
			continue
		if to.length() > 0.3 and rad_to_deg(forward.angle_to(to)) > SWING_HALF_ANGLE:
			continue
		if enemy.call("take_hit", global_position) == true:
			hits.append(str(enemy.get("enemy_id")))
	swung.emit(hits)
	return hits


func _unhandled_input(event: InputEvent) -> void:
	# Mouse look with the mouse captured (a click captures it), or by dragging where it cannot be
	# captured, such as a browser frame that does not allow pointer lock.
	if event is InputEventMouseMotion and (Input.mouse_mode == Input.MOUSE_MODE_CAPTURED or ((event as InputEventMouseMotion).button_mask != 0 and controls_enabled)):
		var motion := event as InputEventMouseMotion
		yaw -= motion.relative.x * mouse_sensitivity
		pitch = clampf(pitch - motion.relative.y * mouse_sensitivity, -1.25, 0.35)
	elif event is InputEventMouseButton and event.is_pressed() and Input.mouse_mode != Input.MOUSE_MODE_CAPTURED and controls_enabled:
		Input.mouse_mode = Input.MOUSE_MODE_CAPTURED
	elif event is InputEventMouseButton and event.is_pressed() and (event as InputEventMouseButton).button_index == MOUSE_BUTTON_LEFT and controls_enabled:
		swing()
	elif event.is_action_pressed("ui_cancel"):
		Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
	elif event.is_action_pressed("interact") and controls_enabled and focus != null:
		interact_requested.emit(str(focus.get_meta("target_id", "")))
	elif event.is_action_pressed("attack") and controls_enabled:
		swing()


func _physics_process(delta: float) -> void:
	camera_arm.rotation = Vector3(pitch, yaw, 0.0)
	if not is_on_floor():
		velocity.y -= gravity * delta
	var input := Vector2.ZERO
	if controls_enabled:
		input = Input.get_vector("move_left", "move_right", "move_forward", "move_back")
		if Input.is_action_just_pressed("jump") and is_on_floor():
			velocity.y = jump_velocity
	var direction := Basis(Vector3.UP, yaw) * Vector3(input.x, 0.0, input.y)
	if direction.length() > 1.0:
		direction = direction.normalized()
	var sprinting := controls_enabled and Input.is_action_pressed("sprint")
	var target_speed := speed * (sprint_multiplier if sprinting else 1.0)
	if direction.length() > 0.05:
		velocity.x = direction.x * target_speed
		velocity.z = direction.z * target_speed
		if _swing_time <= 0.0:
			body_visual.rotation.y = lerp_angle(body_visual.rotation.y, atan2(-direction.x, -direction.z), clampf(delta * 12.0, 0.0, 1.0))
	else:
		velocity.x = move_toward(velocity.x, 0.0, target_speed * 10.0 * delta)
		velocity.z = move_toward(velocity.z, 0.0, target_speed * 10.0 * delta)
	# A hit knocks the player back for a moment.
	_knock = _knock.move_toward(Vector3.ZERO, 20.0 * delta)
	velocity.x += _knock.x
	velocity.z += _knock.z
	move_and_slide()
	_push_blocks(direction)
	_update_combat(delta)
	if anim != null:
		_air_time = 0.0 if is_on_floor() else _air_time + delta
		var moving := Vector2(velocity.x, velocity.z).length()
		if _air_time > 0.12 or velocity.y > 1.0:
			_animate("jump")
		elif moving > 0.3:
			_animate("run" if sprinting and moving > speed * 1.05 else "walk")
		else:
			_animate("idle")
	if global_position.y < -25.0:
		respawn()
	_update_focus()


## Walking into a block slides it straight along the side the player pushes (the block cannot turn,
## so it moves the way its faces point).
func _push_blocks(direction: Vector3) -> void:
	pushing = ""
	for i in range(get_slide_collision_count()):
		var c := get_slide_collision(i)
		var block := c.get_collider() as RigidBody3D
		if block == null or not block.is_in_group("gs_pushable"):
			continue
		var n := c.get_normal() * Vector3(1.0, 0.0, 1.0)
		if n.length() < 0.5 or direction.dot(-n.normalized()) < 0.5:
			continue
		var local := block.global_transform.basis.inverse() * (-n.normalized())
		var axis := Vector3(signf(local.x), 0.0, 0.0) if absf(local.x) > absf(local.z) else Vector3(0.0, 0.0, signf(local.z))
		var push := (block.global_transform.basis * axis) * Vector3(1.0, 0.0, 1.0)
		block.sleeping = false
		block.linear_velocity = Vector3(push.normalized().x * PUSH_SPEED, block.linear_velocity.y, push.normalized().z * PUSH_SPEED)
		pushing = str(block.get_meta("block_id", ""))


func _update_combat(delta: float) -> void:
	_swing_wait = maxf(0.0, _swing_wait - delta)
	if _swing_time > 0.0:
		_swing_time -= delta
		var t := 1.0 - clampf(_swing_time / SWING_SECONDS, 0.0, 1.0)
		_slash.visible = _swing_time > 0.0
		_slash.rotation.y = lerpf(deg_to_rad(55.0), deg_to_rad(-55.0), t)
		var trail := _slash.material_override as StandardMaterial3D
		var tint := trail.albedo_color
		tint.a = 0.75 * (1.0 - t * 0.6)
		trail.albedo_color = tint
	if invulnerable > 0.0:
		invulnerable = maxf(0.0, invulnerable - delta)
		body_visual.visible = invulnerable <= 0.0 or int(invulnerable * 12.0) % 2 == 0
	elif not body_visual.visible:
		body_visual.visible = true


## The swing's trail: a flat, glowing quarter-ring in front of the player at chest height.
static func _make_slash() -> MeshInstance3D:
	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)
	var steps := 12
	var inner := 0.55
	var outer := 1.9
	for i in range(steps):
		var a0 := deg_to_rad(-30.0 + 60.0 * float(i) / float(steps))
		var a1 := deg_to_rad(-30.0 + 60.0 * float(i + 1) / float(steps))
		var p0 := Vector3(sin(a0) * inner, 0.0, -cos(a0) * inner)
		var p1 := Vector3(sin(a0) * outer, 0.0, -cos(a0) * outer)
		var p2 := Vector3(sin(a1) * outer, 0.0, -cos(a1) * outer)
		var p3 := Vector3(sin(a1) * inner, 0.0, -cos(a1) * inner)
		for p in [p0, p1, p2, p0, p2, p3]:
			st.set_normal(Vector3.UP)
			st.add_vertex(p)
	var m := StandardMaterial3D.new()
	m.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	m.cull_mode = BaseMaterial3D.CULL_DISABLED
	m.albedo_color = Color(1.0, 0.92, 0.6, 0.75)
	var mi := MeshInstance3D.new()
	mi.name = "Slash"
	mi.mesh = st.commit()
	mi.material_override = m
	mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	mi.position = Vector3(0.0, 1.05, 0.0)
	return mi


func _update_focus() -> void:
	var best: Node3D = null
	var best_distance := INF
	for candidate in get_tree().get_nodes_in_group("gs_interactable"):
		var node := candidate as Node3D
		if node == null or not node.is_visible_in_tree():
			continue
		var d := global_position.distance_to(node.global_position)
		var reach := float(node.get_meta("interact_radius", 2.5))
		if d <= reach and d < best_distance:
			best = node
			best_distance = d
	if best != focus:
		focus = best
		focus_changed.emit(str(best.get_meta("prompt", "")) if best != null else "")

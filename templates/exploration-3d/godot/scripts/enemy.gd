extends CharacterBody3D
## An enemy from the level layout. It wanders within `roam` metres of its spot, chases the player who
## comes within `sight` metres (and gives up beyond one and a half times that), costs `damage` hearts
## when it touches the player, and is defeated after `health` hits from the player's attack.
## world_builder.gd builds its body; an imported character walks or stands with its own animations.

signal defeated(enemy_id: String, kind: String)

const Models := preload("res://scripts/models.gd")
## Extra metres between the two bodies that still count as a touch.
const TOUCH := 0.35
## Seconds between two touches that hurt.
const TOUCH_COOLDOWN := 1.0
const PLAYER_RADIUS := 0.35

var enemy_id := ""
var kind := "beetle"
var max_health := 2
var health := 2
var damage := 1
var speed := 3.0
var sight := 8.0
var roam := 4.0
## Body radius in metres (after the object's scale).
var radius := 0.55
var home := Vector3.ZERO
var player: Node3D = null
## wander, chase, return or defeated.
var state := "wander"
var is_defeated := false
## Hits taken and touches that hurt the player (the self-test reads them).
var hits_taken := 0
var touches := 0

var visual: Node3D = null
var anim: AnimationPlayer = null
var clips := {}
var anim_state := ""
var _gravity := 9.8
var _wander_to := Vector3.ZERO
var _wait := 0.0
var _knock := Vector3.ZERO
var _cooldown := 0.0
var _squash := 0.0
var _time := 0.0
var _stuck := 0.0
var _rng := RandomNumberGenerator.new()
var _bar: Node3D = null
var _bar_fill: MeshInstance3D = null


## Called by world_builder.gd before the enemy enters the tree.
func setup(o: Dictionary, s: float, body_visual: Node3D, body_radius: float) -> void:
	enemy_id = str(o.get("id", ""))
	kind = str(o.get("kind", "beetle"))
	max_health = maxi(1, int(o.get("health", 2)))
	health = max_health
	damage = maxi(1, int(o.get("damage", 1)))
	speed = maxf(0.0, float(o.get("speed", 3.0)))
	sight = maxf(0.0, float(o.get("sight", 8.0)))
	roam = maxf(0.0, float(o.get("roam", 4.0)))
	radius = body_radius
	visual = body_visual
	# The same wandering every run: the generator is seeded from the enemy's id.
	_rng.seed = hash(enemy_id)
	_wait = _rng.randf_range(0.2, 1.5)
	anim = Models.animation_player(body_visual)
	if anim != null:
		for st in ["idle", "walk", "run"]:
			clips[st] = Models.resolve(anim, "", st)
	_make_bar(s)


func _ready() -> void:
	_gravity = float(ProjectSettings.get_setting("physics/3d/default_gravity", 9.8))
	home = global_position
	_wander_to = home
	add_to_group("gs_enemy")
	if player == null:
		player = get_tree().get_first_node_in_group("gs_player") as Node3D
	_animate("idle")


func _physics_process(delta: float) -> void:
	if is_defeated:
		return
	_time += delta
	_cooldown = maxf(0.0, _cooldown - delta)
	if not is_on_floor():
		velocity.y -= _gravity * delta
	var to_player := Vector3.ZERO
	var distance := INF
	if player != null and is_instance_valid(player) and player.is_visible_in_tree():
		to_player = (player.global_position - global_position) * Vector3(1.0, 0.0, 1.0)
		distance = to_player.length()
	var player_free := player != null and float(player.get("invulnerable")) <= 0.0 and int(player.get("health")) > 0
	# Decide what to do.
	if speed > 0.0 and distance <= sight and player_free:
		state = "chase"
	elif state == "chase" and (distance > sight * 1.5 or not player_free):
		state = "return"
	elif state == "return" and (global_position - home).length() < 1.0:
		state = "wander"
	var want := Vector3.ZERO
	match state:
		"chase":
			if distance > radius + PLAYER_RADIUS + 0.1:
				want = to_player.normalized() * speed
		"return":
			want = ((home - global_position) * Vector3(1.0, 0.0, 1.0)).normalized() * speed
		"wander":
			want = _wander(delta)
	# A hit pushes the enemy back for a moment.
	_knock = _knock.move_toward(Vector3.ZERO, 18.0 * delta)
	velocity.x = want.x + _knock.x
	velocity.z = want.z + _knock.z
	move_and_slide()
	var flat := Vector2(velocity.x, velocity.z)
	if want.length() > 0.1 and visual != null:
		visual.rotation.y = lerp_angle(visual.rotation.y, atan2(-want.x, -want.z), clampf(delta * 8.0, 0.0, 1.0))
	if state == "wander" and want.length() > 0.1 and flat.length() < 0.2:
		_stuck += delta
	else:
		_stuck = 0.0
	# Touching the player hurts it (the player ignores touches while it blinks).
	if distance <= radius + PLAYER_RADIUS + TOUCH and _cooldown <= 0.0 and player != null:
		if player.call("hurt_by", damage, enemy_id, global_position) == true:
			touches += 1
			_cooldown = TOUCH_COOLDOWN
			_knock = -to_player.normalized() * 3.0
	if global_position.y < -25.0:
		global_position = home + Vector3(0.0, 1.0, 0.0)
		velocity = Vector3.ZERO
	_show(delta, flat.length())


## Strolls to a spot near home, waits a moment, picks another (none when roam is 0).
func _wander(delta: float) -> Vector3:
	if roam <= 0.0 or speed <= 0.0:
		return Vector3.ZERO
	var to := (_wander_to - global_position) * Vector3(1.0, 0.0, 1.0)
	if to.length() < 0.4 or _stuck > 1.0:
		_wait -= delta
		if _wait <= 0.0:
			var angle := _rng.randf_range(0.0, TAU)
			var reach := _rng.randf_range(0.3, 1.0) * roam
			_wander_to = home + Vector3(cos(angle) * reach, 0.0, sin(angle) * reach)
			_wait = _rng.randf_range(0.8, 2.4)
			_stuck = 0.0
		return Vector3.ZERO
	return to.normalized() * speed * 0.45


## Bobbing and squashing for the built-in body; walk or idle for an imported character.
func _show(delta: float, moving: float) -> void:
	_squash = maxf(0.0, _squash - delta * 4.0)
	if visual != null:
		var bob := 1.0 + (sin(_time * 14.0) * 0.06 if moving > 0.3 and anim == null else 0.0)
		visual.scale = Vector3(1.0 + _squash * 0.35, (1.0 - _squash * 0.35) * bob, 1.0 + _squash * 0.35)
	if anim != null:
		_animate("walk" if moving > 0.3 else "idle")


func _animate(st: String) -> void:
	if anim == null or st == anim_state:
		return
	var clip := str(clips.get(st, ""))
	if clip == "" and st == "walk":
		clip = str(clips.get("run", ""))
	if clip == "":
		clip = str(clips.get("idle", ""))
	if Models.play(anim, clip, true, 0.15):
		anim_state = st


## The player's attack: one health point, a squash and a push away from `from`. True when it landed.
func take_hit(from: Vector3) -> bool:
	if is_defeated:
		return false
	health -= 1
	hits_taken += 1
	_squash = 1.0
	var away := (global_position - from) * Vector3(1.0, 0.0, 1.0)
	_knock = (away.normalized() if away.length() > 0.01 else Vector3.FORWARD) * 7.0
	velocity.y = 2.5
	state = "chase"
	_update_bar()
	if health <= 0:
		_defeat()
	return true


func _defeat() -> void:
	is_defeated = true
	state = "defeated"
	_disable()
	var tween := create_tween()
	tween.tween_property(self, "scale", Vector3(0.05, 0.05, 0.05), 0.3).set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_IN)
	tween.tween_callback(func(): visible = false)
	defeated.emit(enemy_id, kind)


## Defeated already (restoring saved progress): gone at once, and the rules are not told again.
func defeat_now() -> void:
	if is_defeated:
		return
	is_defeated = true
	health = 0
	state = "defeated"
	_disable()
	visible = false


func _disable() -> void:
	velocity = Vector3.ZERO
	for child in get_children():
		if child is CollisionShape3D:
			(child as CollisionShape3D).set_deferred("disabled", true)
	if _bar != null:
		_bar.visible = false


# ---- Health bar: two flat bars that face the camera, shown once the enemy has been hit ----------

func _make_bar(s: float) -> void:
	_bar = Node3D.new()
	_bar.name = "HealthBar"
	var top := 0.0
	if visual != null:
		top = Models.bounds(visual, visual.transform).end.y
	_bar.position = Vector3(0.0, maxf(top, 0.6 * s) + 0.35, 0.0)
	_bar.visible = false
	add_child(_bar)
	_bar.add_child(_bar_quad(Vector2(0.9, 0.14), Color(0.05, 0.05, 0.08, 0.85), 0))
	_bar_fill = _bar_quad(Vector2(0.84, 0.08), Color("#ff5a5a"), 1)
	_bar.add_child(_bar_fill)


static func _bar_quad(size: Vector2, color: Color, priority: int) -> MeshInstance3D:
	var quad := QuadMesh.new()
	quad.size = size
	var m := StandardMaterial3D.new()
	m.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	m.billboard_mode = BaseMaterial3D.BILLBOARD_ENABLED
	m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	m.albedo_color = color
	m.render_priority = priority
	var mi := MeshInstance3D.new()
	mi.mesh = quad
	mi.material_override = m
	mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	return mi


func _update_bar() -> void:
	if _bar == null or _bar_fill == null:
		return
	_bar.visible = health > 0 and health < max_health
	_bar_fill.scale = Vector3(clampf(float(health) / float(max_health), 0.0, 1.0), 1.0, 1.0)

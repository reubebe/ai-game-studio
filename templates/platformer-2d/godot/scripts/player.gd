extends CharacterBody2D
## The runner: A/D or arrows run, Space (or W/Up) jumps and holding it jumps higher. Jumps forgive a
## late press just after leaving a ledge (coyote time) and an early press just before landing (buffer).
## The self-test drives it through scripted_dir, scripted_jump and scripted_hold instead of the keyboard.

signal jumped

const TILE := 32.0
const COYOTE := 0.1
const BUFFER := 0.12

var speed := 8.0 * TILE
var gravity := 60.0 * TILE
var jump_velocity := 700.0
var controls_enabled := true
var facing := 1.0
var scripted_dir = null
var scripted_jump := false
var scripted_hold := false
var _coyote := 0.0
var _buffer := 0.0
var _squash := 0.0
## The player's sprite sheet (null without one, then the runner is drawn), why it could not be
## loaded, and the animation shown now: idle, run or jump.
var sprite: AnimatedSprite2D = null
var sprite_error := ""
var anim_state := ""
var _sprite_scale := 1.0
var _sprite_faces_left := false


func _ready() -> void:
	var shape := CollisionShape2D.new()
	var rect := RectangleShape2D.new()
	rect.size = Vector2(22, 44)
	shape.shape = rect
	shape.position = Vector2(0, -22)
	add_child(shape)
	floor_snap_length = 6.0


## Speed, jump height and gravity come from the level file (tiles, tiles per second).
func configure(settings: Dictionary) -> void:
	speed = float(settings.get("speed", 8)) * TILE
	gravity = float(settings.get("gravity", 60)) * TILE
	jump_velocity = sqrt(2.0 * gravity * float(settings.get("jumpHeight", 4)) * TILE)
	set_sprite(settings.get("sprite", null))


## Draws the player from a sprite sheet: equal frames in `columns` x `rows`, numbered from the top
## left, with frame lists for idle, run and jump, scaled to `height` tiles with the feet on the ground.
func set_sprite(cfg) -> void:
	if sprite != null:
		sprite.queue_free()
	sprite = null
	sprite_error = ""
	anim_state = ""
	if typeof(cfg) != TYPE_DICTIONARY:
		queue_redraw()
		return
	var rel := str(cfg.get("asset", ""))
	var tex: Texture2D = null
	if rel != "" and not rel.contains("..") and ResourceLoader.exists("res://" + rel):
		tex = load("res://" + rel) as Texture2D
	if tex == null:
		sprite_error = "%s could not be loaded" % rel
		queue_redraw()
		return
	var cols := maxi(1, int(cfg.get("columns", 4)))
	var rows := maxi(1, int(cfg.get("rows", 1)))
	var fw := float(tex.get_width()) / cols
	var fh := float(tex.get_height()) / rows
	var frames := SpriteFrames.new()
	var fps := float(cfg.get("fps", 10))
	for state in ["idle", "run", "jump"]:
		var list: Array = cfg.get(state, [0] if state == "idle" else [])
		var added := 0
		for v in list:
			var i := int(v)
			if i < 0 or i >= cols * rows:
				continue
			if added == 0:
				frames.add_animation(state)
				frames.set_animation_speed(state, fps)
				frames.set_animation_loop(state, state != "jump")
			var region := AtlasTexture.new()
			region.atlas = tex
			region.region = Rect2((i % cols) * fw, floorf(i / cols) * fh, fw, fh)
			frames.add_frame(state, region)
			added += 1
	if frames.has_animation("default"):
		frames.remove_animation("default")
	if not frames.has_animation("idle"):
		sprite_error = "%s has no idle frames" % rel
		return
	sprite = AnimatedSprite2D.new()
	sprite.name = "Sprite"
	sprite.sprite_frames = frames
	sprite.centered = true
	sprite.offset = Vector2(0.0, -fh / 2.0)
	if bool(cfg.get("pixelArt", true)):
		sprite.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	_sprite_scale = float(cfg.get("height", 1.5)) * TILE / fh
	_sprite_faces_left = str(cfg.get("facing", "right")) == "left"
	sprite.scale = Vector2.ONE * _sprite_scale
	add_child(sprite)
	_animate("idle")
	queue_redraw()


func _animate(state: String) -> void:
	if sprite == null or state == anim_state:
		return
	var name_now := state if sprite.sprite_frames.has_animation(state) else ("idle" if state == "run" else "")
	if name_now == "":
		return
	anim_state = state
	sprite.play(name_now)


func respawn(point: Vector2) -> void:
	global_position = point
	velocity = Vector2.ZERO


func bounce() -> void:
	velocity.y = -jump_velocity * 0.7


func _physics_process(delta: float) -> void:
	var dir := 0.0
	var pressed := false
	var held := false
	if scripted_dir != null:
		dir = float(scripted_dir)
		pressed = scripted_jump
		held = scripted_hold
		scripted_jump = false
	elif controls_enabled:
		dir = Input.get_axis("move_left", "move_right")
		pressed = Input.is_action_just_pressed("jump")
		held = Input.is_action_pressed("jump")
	_coyote = COYOTE if is_on_floor() else _coyote - delta
	_buffer = BUFFER if pressed else _buffer - delta
	velocity.y = minf(velocity.y + gravity * delta, 20.0 * TILE)
	if _buffer > 0.0 and _coyote > 0.0:
		velocity.y = -jump_velocity
		_buffer = 0.0
		_coyote = 0.0
		_squash = 1.0
		jumped.emit()
	# Letting go of jump early cuts the rise short, so taps give small hops.
	if not held and velocity.y < -jump_velocity * 0.4:
		velocity.y = -jump_velocity * 0.4
	var accel := (12.0 if is_on_floor() else 7.0) * speed * delta
	velocity.x = move_toward(velocity.x, dir * speed, accel)
	var was_floor := is_on_floor()
	move_and_slide()
	if is_on_floor() and not was_floor:
		_squash = -1.0
	if absf(dir) > 0.1:
		facing = signf(dir)
	_squash = move_toward(_squash, 0.0, delta * 6.0)
	if sprite != null:
		if not is_on_floor() and absf(velocity.y) > 40.0:
			_animate("jump")
		elif absf(velocity.x) > 20.0:
			_animate("run")
		else:
			_animate("idle")
		var stretch := 1.0 + _squash * 0.12
		sprite.scale = Vector2(_sprite_scale / stretch, _sprite_scale * stretch)
		sprite.flip_h = (facing < 0.0) != _sprite_faces_left
	else:
		queue_redraw()


func _draw() -> void:
	if sprite != null:
		return
	var stretch := 1.0 + _squash * 0.12
	var w := 24.0 / stretch
	var h := 44.0 * stretch
	draw_rect(Rect2(-w / 2.0, -h, w, h), Color("#ff7b54"))
	draw_rect(Rect2(-w / 2.0, -h, w, 8), Color("#ffb38a"))
	draw_rect(Rect2(-w / 2.0, -h * 0.45, w, 6), Color("#3d5a80"))
	var eye := Vector2(5.0 * facing, -h + 16)
	draw_circle(eye, 5.0, Color.WHITE)
	draw_circle(eye + Vector2(1.5 * facing, 0), 2.4, Color("#1b1b2f"))

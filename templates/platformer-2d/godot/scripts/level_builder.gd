extends Node2D
## Builds the level from res://gamestudio_data/level.json, which Game Studio writes when the project is
## saved (edit the level in Game Studio's level editor). Units in the file are tiles: x to the right,
## y upwards from the bottom of the level. One tile is TILE pixels; Godot's y points down.

signal coin_collected(item_id: String, kind: String)
signal checkpoint_reached(checkpoint_id: String)
signal goal_reached(goal_id: String)
signal hazard(cause: String)
signal enemy_stomped(enemy_id: String)
signal sign_touched(text: String)

const LEVEL_PATH := "res://gamestudio_data/level.json"
const TILE := 32.0
const STYLE_COLOURS := {
	"grass": [Color("#7a4e2d"), Color("#5cb84a"), Color("#4a3020")],
	"stone": [Color("#7d8290"), Color("#a3a9b5"), Color("#5c616d")],
	"wood": [Color("#9c6b3d"), Color("#c08a52"), Color("#6e4a28")],
}

var level: Dictionary = {}
## Platforms drawn with a picture, and pictures that could not be loaded (platform id -> reason).
var textured_platforms: Array = []
var texture_errors: Dictionary = {}
var load_error := ""
## id -> the object's node; id -> type.
var nodes: Dictionary = {}
var types: Dictionary = {}
## Collected coin id -> kind; reached checkpoint ids; stomped enemy ids; open door ids.
var collected: Dictionary = {}
var reached: Dictionary = {}
var stomped: Dictionary = {}
var doors_open: Dictionary = {}
var player: CharacterBody2D
var _enemies: Array = []
var _coins: Array = []
var _time := 0.0


static func px(x: float, y: float) -> Vector2:
	return Vector2(x * TILE, -y * TILE)


func build() -> void:
	textured_platforms.clear()
	texture_errors.clear()
	level = _load_level()
	if level.is_empty():
		return
	for o in level.get("objects", []):
		if typeof(o) == TYPE_DICTIONARY:
			_build_object(o)


func _load_level() -> Dictionary:
	if not FileAccess.file_exists(LEVEL_PATH):
		load_error = "No level found. Save the project in Game Studio to write gamestudio_data/level.json."
		return {}
	var data = JSON.parse_string(FileAccess.get_file_as_string(LEVEL_PATH))
	if typeof(data) != TYPE_DICTIONARY or str(data.get("kind", "")) != "platformer-level":
		load_error = "level.json is not a platformer level."
		return {}
	return data


func size_tiles() -> Vector2:
	var s: Dictionary = level.get("size", {})
	return Vector2(float(s.get("width", 60)), float(s.get("height", 20)))


func player_settings() -> Dictionary:
	return level.get("player", {})


func object_ids_of_type(object_type: String) -> Array:
	var out: Array = []
	for id in types:
		if types[id] == object_type:
			out.append(id)
	return out


func object_data(id: String) -> Dictionary:
	for o in level.get("objects", []):
		if typeof(o) == TYPE_DICTIONARY and str(o.get("id", "")) == id:
			return o
	return {}


# ---- What the rules and the game ask for ---------------------------------------------------

func collect_item(item_id: String, notify := true) -> bool:
	if types.get(item_id) != "coin" or collected.has(item_id):
		return false
	var kind := str(object_data(item_id).get("kind", "coin"))
	collected[item_id] = kind
	_disable(nodes[item_id])
	if notify:
		coin_collected.emit(item_id, kind)
	return true


func collected_count(kind: String) -> int:
	var n := 0
	for id in collected:
		if collected[id] == kind:
			n += 1
	return n


func total_count(kind: String) -> int:
	var n := 0
	for o in level.get("objects", []):
		if typeof(o) == TYPE_DICTIONARY and str(o.get("type", "")) == "coin" and str(o.get("kind", "coin")) == kind:
			n += 1
	return n


func has_door(door_id: String) -> bool:
	return types.get(door_id) == "door"


func open_door(door_id: String, at_once := false) -> void:
	if not has_door(door_id) or doors_open.has(door_id):
		return
	doors_open[door_id] = true
	var door: Node2D = nodes[door_id]
	for child in door.get_children():
		if child is CollisionShape2D:
			child.set_deferred("disabled", true)
	var art: Node2D = door.get_node("Art")
	var height := float(object_data(door_id).get("height", 3)) * TILE
	if at_once:
		art.position.y = -height
		art.modulate.a = 0.25
	else:
		var tween := create_tween().set_parallel(true)
		tween.tween_property(art, "position:y", -height, 1.4).set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_IN_OUT)
		tween.tween_property(art, "modulate:a", 0.25, 1.4)


func is_door_open(door_id: String) -> bool:
	return doors_open.has(door_id)


func set_object_visible(object_id: String, visible_now: bool) -> bool:
	if not nodes.has(object_id):
		return false
	var node: Node2D = nodes[object_id]
	node.visible = visible_now
	node.set_deferred("process_mode", Node.PROCESS_MODE_INHERIT if visible_now else Node.PROCESS_MODE_DISABLED)
	return true


## Marks a checkpoint reached without telling the rules (restoring saved progress).
func restore_checkpoint(checkpoint_id: String) -> void:
	if types.get(checkpoint_id) == "checkpoint":
		reached[checkpoint_id] = true
		_raise_flag(nodes[checkpoint_id])


func stomp(enemy_id: String, notify := true) -> void:
	if types.get(enemy_id) != "enemy" or stomped.has(enemy_id):
		return
	stomped[enemy_id] = true
	_disable(nodes[enemy_id])
	if notify:
		enemy_stomped.emit(enemy_id)


## Where the player comes back after being hurt: the furthest checkpoint reached, else the start.
func respawn_point() -> Vector2:
	var best := -1.0
	var point := Vector2.ZERO
	for id in reached:
		var o := object_data(id)
		if float(o.get("x", 0)) > best:
			best = float(o.get("x", 0))
			point = px(float(o.get("x", 0)), float(o.get("y", 0)))
	if best >= 0.0:
		return point
	var spawn: Dictionary = player_settings().get("spawn", {})
	return px(float(spawn.get("x", 2)), float(spawn.get("y", 3)))


func _disable(node: Node2D) -> void:
	node.visible = false
	node.set_deferred("process_mode", Node.PROCESS_MODE_DISABLED)


# ---- Construction ------------------------------------------------------------------------

func _build_object(o: Dictionary) -> void:
	var id := str(o.get("id", ""))
	if id == "" or nodes.has(id):
		return
	var otype := str(o.get("type", ""))
	var node: Node2D
	match otype:
		"platform":
			node = _platform(o)
		"coin":
			node = _coin(o)
		"spike":
			node = _spike(o)
		"checkpoint":
			node = _flag(o, false)
		"goal":
			node = _flag(o, true)
		"enemy":
			node = _enemy(o)
		"door":
			node = _door(o)
		"sign":
			node = _sign(o)
		_:
			push_warning("Unknown level object type '%s' (%s)" % [otype, id])
			return
	node.name = id
	add_child(node)
	nodes[id] = node
	types[id] = otype


func _rect(parent: Node, pos: Vector2, size: Vector2, colour: Color) -> ColorRect:
	var r := ColorRect.new()
	r.position = pos
	r.size = size
	r.color = colour
	r.mouse_filter = Control.MOUSE_FILTER_IGNORE
	parent.add_child(r)
	return r


func _shape(parent: Node, size: Vector2, centre: Vector2) -> CollisionShape2D:
	var s := CollisionShape2D.new()
	var rect := RectangleShape2D.new()
	rect.size = size
	s.shape = rect
	s.position = centre
	parent.add_child(s)
	return s


func _platform(o: Dictionary) -> Node2D:
	var w := float(o.get("width", 4)) * TILE
	var h := float(o.get("height", 1)) * TILE
	var style := str(o.get("style", "grass"))
	var colours: Array = STYLE_COLOURS.get(style, STYLE_COLOURS["grass"])
	var body := StaticBody2D.new()
	body.position = px(float(o.get("x", 0)), float(o.get("y", 0)) + float(o.get("height", 1)))
	var shape := _shape(body, Vector2(w, h), Vector2(w, h) / 2.0)
	# Wooden ledges can be jumped through from below.
	shape.one_way_collision = style == "wood"
	var picture := str(o.get("texture", ""))
	if picture != "":
		var tex: Texture2D = null
		if not picture.contains("..") and ResourceLoader.exists("res://" + picture):
			tex = load("res://" + picture) as Texture2D
		if tex != null:
			# The picture repeats every `tile` tiles from the platform's top left (the studio's side view
			# draws the same pattern).
			var poly := Polygon2D.new()
			poly.name = "Picture"
			poly.polygon = PackedVector2Array([Vector2.ZERO, Vector2(w, 0), Vector2(w, h), Vector2(0, h)])
			poly.texture = tex
			poly.texture_repeat = CanvasItem.TEXTURE_REPEAT_ENABLED
			var span := maxf(0.25, float(o.get("tile", 1.0))) * TILE
			poly.texture_scale = Vector2(tex.get_width() / span, tex.get_height() / span)
			body.add_child(poly)
			textured_platforms.append(str(o.get("id", "")))
			return body
		texture_errors[str(o.get("id", ""))] = "%s could not be loaded" % picture
	_rect(body, Vector2.ZERO, Vector2(w, h), colours[0])
	_rect(body, Vector2(0, h - 6), Vector2(w, 6), colours[2])
	var top := minf(10.0, h)
	_rect(body, Vector2(0, 0), Vector2(w, top), colours[1])
	if style == "grass":
		for i in range(int(w / 12.0)):
			_rect(body, Vector2(i * 12 + 4, top), Vector2(4, 4), colours[1].darkened(0.2))
	elif style == "wood":
		for i in range(1, int(w / TILE)):
			_rect(body, Vector2(i * TILE - 1, 0), Vector2(2, h), colours[2])
	else:
		for i in range(int(w / TILE)):
			for j in range(int(h / TILE)):
				_rect(body, Vector2(i * TILE + 2, j * TILE + 2), Vector2(TILE - 4, TILE - 4), colours[0].lightened(0.06 if (i + j) % 2 == 0 else 0.0))
	return body


class CoinArt extends Node2D:
	func _draw() -> void:
		draw_circle(Vector2.ZERO, 11.0, Color("#b8860b"))
		draw_circle(Vector2.ZERO, 9.0, Color("#ffd23f"))
		draw_circle(Vector2(-3, -3), 3.0, Color("#fff3b0"))


func _coin(o: Dictionary) -> Node2D:
	var area := Area2D.new()
	area.position = px(float(o.get("x", 0)), float(o.get("y", 0)))
	var shape := CollisionShape2D.new()
	var circle := CircleShape2D.new()
	circle.radius = 0.42 * TILE
	shape.shape = circle
	area.add_child(shape)
	var art := CoinArt.new()
	art.name = "Art"
	area.add_child(art)
	var id := str(o.get("id", ""))
	area.body_entered.connect(func(body: Node) -> void:
		if body == player:
			collect_item(id))
	_coins.append(area)
	return area


func _spike(o: Dictionary) -> Node2D:
	var w := float(o.get("width", 2)) * TILE
	var area := Area2D.new()
	area.position = px(float(o.get("x", 0)), float(o.get("y", 0)))
	_shape(area, Vector2(w - 6, 12), Vector2(w / 2.0, -6))
	var count := maxi(1, int(w / 16.0))
	for i in range(count):
		var tri := Polygon2D.new()
		var x0 := i * (w / count)
		tri.polygon = PackedVector2Array([Vector2(x0, 0), Vector2(x0 + w / count / 2.0, -18), Vector2(x0 + w / count, 0)])
		tri.color = Color("#d9dde6") if i % 2 == 0 else Color("#b9bfcc")
		area.add_child(tri)
	area.body_entered.connect(func(body: Node) -> void:
		if body == player:
			hazard.emit("spike"))
	return area


func _flag(o: Dictionary, is_goal: bool) -> Node2D:
	var area := Area2D.new()
	area.position = px(float(o.get("x", 0)), float(o.get("y", 0)))
	_shape(area, Vector2(TILE, 3 * TILE), Vector2(0, -1.5 * TILE))
	_rect(area, Vector2(-3, -3 * TILE), Vector2(6, 3 * TILE), Color("#e8e2d0"))
	var flag := Polygon2D.new()
	flag.name = "Flag"
	var w := 52.0 if is_goal else 34.0
	flag.polygon = PackedVector2Array([Vector2(3, -3 * TILE), Vector2(3 + w, -3 * TILE + 12), Vector2(3, -3 * TILE + 26)])
	flag.color = Color("#ff5d73") if is_goal else Color("#8a8f99")
	area.add_child(flag)
	var label := Label.new()
	label.text = str(o.get("label", "Goal" if is_goal else "Checkpoint"))
	label.position = Vector2(-60, -3 * TILE - 30)
	label.custom_minimum_size = Vector2(120, 0)
	label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	label.add_theme_font_size_override("font_size", 13)
	label.add_theme_color_override("font_outline_color", Color(0, 0, 0, 0.7))
	label.add_theme_constant_override("outline_size", 4)
	area.add_child(label)
	var id := str(o.get("id", ""))
	area.body_entered.connect(func(body: Node) -> void:
		if body != player:
			return
		if is_goal:
			goal_reached.emit(id)
		elif not reached.has(id):
			reached[id] = true
			_raise_flag(area)
			checkpoint_reached.emit(id))
	return area


func _raise_flag(area: Node2D) -> void:
	var flag := area.get_node_or_null("Flag") as Polygon2D
	if flag != null:
		flag.color = Color("#3ddc97")


class BeetleArt extends Node2D:
	var phase := 0.0
	func _draw() -> void:
		var leg := sin(phase * 10.0) * 3.0
		for i in range(3):
			var x := -10.0 + i * 10.0
			draw_line(Vector2(x, -6), Vector2(x - 4 + leg, 0), Color("#2a1b3d"), 3.0)
		draw_circle(Vector2(0, -12), 14.0, Color("#6a3fb5"))
		draw_rect(Rect2(-14, -12, 28, 12), Color("#6a3fb5"))
		draw_line(Vector2(0, -26), Vector2(0, -1), Color("#4b2a87"), 2.0)
		draw_circle(Vector2(11, -14), 4.0, Color.WHITE)
		draw_circle(Vector2(12, -14), 2.0, Color.BLACK)


func _enemy(o: Dictionary) -> Node2D:
	var area := Area2D.new()
	area.position = px(float(o.get("x", 0)), float(o.get("y", 0)))
	_shape(area, Vector2(TILE * 0.9, TILE * 0.8), Vector2(0, -TILE * 0.4))
	var art := BeetleArt.new()
	art.name = "Art"
	area.add_child(art)
	var id := str(o.get("id", ""))
	area.set_meta("start_x", area.position.x)
	area.set_meta("range", float(o.get("range", 4)) * TILE)
	area.set_meta("speed", float(o.get("speed", 2)) * TILE)
	area.set_meta("dir", 1.0)
	area.body_entered.connect(func(body: Node) -> void:
		if body != player or stomped.has(id):
			return
		# Landing on top (falling, feet above the beetle's middle) stomps it; anything else hurts.
		var p := body as CharacterBody2D
		if p.velocity.y > 0.0 and p.global_position.y < area.global_position.y - TILE * 0.25:
			stomp(id)
			if p.has_method("bounce"):
				p.call("bounce")
		else:
			hazard.emit("enemy"))
	_enemies.append(area)
	return area


func _door(o: Dictionary) -> Node2D:
	var h := float(o.get("height", 3)) * TILE
	var body := StaticBody2D.new()
	body.position = px(float(o.get("x", 0)), float(o.get("y", 0)))
	_shape(body, Vector2(TILE, h), Vector2(0, -h / 2.0))
	var art := Node2D.new()
	art.name = "Art"
	body.add_child(art)
	_rect(art, Vector2(-TILE / 2.0, -h), Vector2(TILE, h), Color("#5b3a29"))
	for i in range(int(h / TILE)):
		_rect(art, Vector2(-TILE / 2.0, -h + i * TILE + TILE / 2.0 - 2), Vector2(TILE, 4), Color("#3a2418"))
	_rect(art, Vector2(4, -h / 2.0 - 4), Vector2(6, 8), Color("#ffd23f"))
	return body


func _sign(o: Dictionary) -> Node2D:
	var area := Area2D.new()
	area.position = px(float(o.get("x", 0)), float(o.get("y", 0)))
	_shape(area, Vector2(TILE * 1.4, TILE * 1.4), Vector2(0, -TILE * 0.7))
	_rect(area, Vector2(-3, -TILE * 1.4), Vector2(6, TILE * 1.4), Color("#6e4a28"))
	_rect(area, Vector2(-TILE * 0.6, -TILE * 1.45), Vector2(TILE * 1.2, TILE * 0.7), Color("#c08a52"))
	var text := str(o.get("text", ""))
	area.body_entered.connect(func(body: Node) -> void:
		if body == player:
			sign_touched.emit(text))
	return area


func _physics_process(delta: float) -> void:
	_time += delta
	for e in _enemies:
		var area := e as Area2D
		if not area.visible:
			continue
		var start_x: float = area.get_meta("start_x")
		var reach: float = area.get_meta("range")
		var dir: float = area.get_meta("dir")
		area.position.x += dir * float(area.get_meta("speed")) * delta
		if area.position.x > start_x + reach:
			area.position.x = start_x + reach
			area.set_meta("dir", -1.0)
		elif area.position.x < start_x:
			area.position.x = start_x
			area.set_meta("dir", 1.0)
		var art := area.get_node("Art") as BeetleArt
		art.scale.x = area.get_meta("dir")
		art.phase = _time
		art.queue_redraw()
	for c in _coins:
		var coin := c as Area2D
		if coin.visible:
			var art := coin.get_node("Art") as Node2D
			art.scale.x = absf(cos(_time * 3.0 + coin.position.x * 0.05))
			art.position.y = sin(_time * 2.0 + coin.position.x * 0.03) * 3.0

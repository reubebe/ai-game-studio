@tool
extends Node2D
## The farm from res://gamestudio_data/farm.json, the settings edited in Game Studio's farm editor: a grid
## of tiles (grass, soil, paths, water, trees, fences, the house and the market stall) drawn from simple
## shapes, and the crops growing on the soil. It also keeps the crops' state (what grows where, for how
## many days, and whether it was watered today). In the Godot editor it draws a preview.

const FARM_PATH := "res://gamestudio_data/farm.json"
const TILE := 48.0
const TILES := {"g": "grass", "s": "soil", "p": "path", "w": "water", "t": "tree", "f": "fence", "h": "house", "m": "market"}
## Tiles the farmer cannot walk onto (packages/farm: BLOCKING).
const BLOCKING := ["w", "t", "f", "h", "m"]

var farm: Dictionary = {}
var load_error := ""
var width := 20
var height := 12
var rows: Array = []
## Crop settings by id, in the settings' order.
var crops: Dictionary = {}
var crop_order: Array = []
## What grows where: cell -> {"crop": id, "grown": days, "watered": bool}.
var plots: Dictionary = {}
var raining := false
## The tile the farmer faces (outlined), or (-1, -1).
var target := Vector2i(-1, -1)
var house_rect := Rect2i()
var market_rect := Rect2i()
var _time := 0.0


func _ready() -> void:
	build()


func build() -> void:
	load_error = ""
	farm = _load()
	var m: Dictionary = farm.get("map", {})
	width = int(m.get("width", 20))
	height = int(m.get("height", 12))
	rows = m.get("rows", [])
	crops.clear()
	crop_order.clear()
	for c in farm.get("crops", []):
		if typeof(c) == TYPE_DICTIONARY:
			crops[str(c.get("id", ""))] = c
			crop_order.append(str(c.get("id", "")))
	plots.clear()
	house_rect = _bounds("h")
	market_rect = _bounds("m")
	queue_redraw()


func _load() -> Dictionary:
	if not FileAccess.file_exists(FARM_PATH):
		load_error = "Missing %s" % FARM_PATH
		return {}
	var parsed = JSON.parse_string(FileAccess.get_file_as_string(FARM_PATH))
	if typeof(parsed) != TYPE_DICTIONARY:
		load_error = "farm.json is not valid JSON"
		return {}
	if str(parsed.get("kind", "")) != "farm-sim":
		load_error = "farm.json is not a farm"
		return {}
	return parsed


func _process(delta: float) -> void:
	# Water ripples and rain move, so the farm is drawn again every frame.
	_time += delta
	queue_redraw()


# ---- Tiles ------------------------------------------------------------------------------------

func tile(cell: Vector2i) -> String:
	if cell.y < 0 or cell.y >= rows.size():
		return ""
	var row := str(rows[cell.y])
	if cell.x < 0 or cell.x >= row.length():
		return ""
	return row[cell.x]


func walkable(cell: Vector2i) -> bool:
	var t := tile(cell)
	return t != "" and not BLOCKING.has(t)


func cell_at(pos: Vector2) -> Vector2i:
	return Vector2i(int(floor(pos.x / TILE)), int(floor(pos.y / TILE)))


func center(cell: Vector2i) -> Vector2:
	return Vector2((float(cell.x) + 0.5) * TILE, (float(cell.y) + 0.5) * TILE)


func spawn_position() -> Vector2:
	var s: Dictionary = (farm.get("map", {}) as Dictionary).get("spawn", {})
	return center(Vector2i(int(s.get("x", 1)), int(s.get("y", 1))))


func cells_of(letter: String) -> Array:
	var out: Array = []
	for y in range(rows.size()):
		var row := str(rows[y])
		for x in range(row.length()):
			if row[x] == letter:
				out.append(Vector2i(x, y))
	return out


func _bounds(letter: String) -> Rect2i:
	var cells := cells_of(letter)
	if cells.is_empty():
		return Rect2i()
	var r := Rect2i(cells[0], Vector2i.ONE)
	for c in cells:
		r = r.expand(c).expand(c + Vector2i.ONE)
	return r


# ---- Crops ------------------------------------------------------------------------------------

func crop(id: String) -> Dictionary:
	return crops.get(id, {})


func is_ready(cell: Vector2i) -> bool:
	if not plots.has(cell):
		return false
	var p: Dictionary = plots[cell]
	return int(p["grown"]) >= int(crop(str(p["crop"])).get("days", 1))


## Plants a seed on bare soil. False when the tile is not bare soil or the crop is unknown.
func plant(cell: Vector2i, crop_id: String) -> bool:
	if tile(cell) != "s" or plots.has(cell) or not crops.has(crop_id):
		return false
	plots[cell] = {"crop": crop_id, "grown": 0, "watered": raining}
	return true


func water(cell: Vector2i) -> bool:
	if not plots.has(cell) or bool(plots[cell]["watered"]):
		return false
	plots[cell]["watered"] = true
	return true


## Harvests a ready tile: {"crop", "amount"}, or {} when nothing is ready there. A crop that regrows
## stays planted and needs its regrow days again; others leave bare soil.
func harvest(cell: Vector2i) -> Dictionary:
	if not is_ready(cell):
		return {}
	var p: Dictionary = plots[cell]
	var c := crop(str(p["crop"]))
	var regrow := int(c.get("regrow", 0))
	if regrow > 0:
		p["grown"] = maxi(int(c.get("days", 1)) - regrow, 0)
	else:
		plots.erase(cell)
	return {"crop": str(c.get("id", "")), "amount": int(c.get("yield", 1))}


## The night: crops that were watered (or rained on, or need no water) grow a day; then today's
## watering is over and the new day's weather waters them if it rains.
func grow_overnight(rain_tomorrow: bool) -> void:
	for cell in plots:
		var p: Dictionary = plots[cell]
		var c := crop(str(p["crop"]))
		if bool(p["watered"]) or raining or not bool(c.get("needsWater", true)):
			p["grown"] = mini(int(p["grown"]) + 1, int(c.get("days", 1)))
		p["watered"] = rain_tomorrow
	raining = rain_tomorrow


func set_rain(on: bool) -> void:
	raining = on
	if on:
		for cell in plots:
			plots[cell]["watered"] = true


# ---- Drawing ----------------------------------------------------------------------------------

func _hash(cell: Vector2i) -> int:
	return absi((cell.x * 73856093) ^ (cell.y * 19349663))


func _draw() -> void:
	for y in range(rows.size()):
		for x in range(str(rows[y]).length()):
			_draw_tile(Vector2i(x, y))
	if house_rect.size != Vector2i.ZERO:
		_draw_house(Rect2(Vector2(house_rect.position) * TILE, Vector2(house_rect.size) * TILE))
	if market_rect.size != Vector2i.ZERO:
		_draw_market(Rect2(Vector2(market_rect.position) * TILE, Vector2(market_rect.size) * TILE))
	for cell in plots:
		_draw_crop(cell, plots[cell])
	if target.x >= 0:
		draw_rect(Rect2(Vector2(target) * TILE + Vector2(2, 2), Vector2(TILE - 4, TILE - 4)), Color(1.0, 0.92, 0.45, 0.9), false, 3.0)


func _draw_tile(cell: Vector2i) -> void:
	var t := tile(cell)
	var r := Rect2(Vector2(cell) * TILE, Vector2(TILE, TILE))
	var h := _hash(cell)
	var grass := Color("#6aa84f") if (cell.x + cell.y) % 2 == 0 else Color("#64a04a")
	match t:
		"s":
			var watered := plots.has(cell) and bool(plots[cell]["watered"])
			draw_rect(r, Color("#5e4630") if watered else Color("#8d6e4a"))
			for i in range(3):
				var fy := r.position.y + TILE * (0.25 + 0.25 * float(i))
				draw_line(Vector2(r.position.x + 5, fy), Vector2(r.end.x - 5, fy), Color(0, 0, 0, 0.18), 2.0)
		"p":
			draw_rect(r, Color("#d8c39a"))
			for i in range(3):
				var px := r.position.x + float((h >> (i * 4)) % 40) + 4.0
				var py := r.position.y + float((h >> (i * 4 + 2)) % 40) + 4.0
				draw_circle(Vector2(px, py), 2.0, Color("#b9a479"))
		"w":
			draw_rect(r, Color("#3b82c4"))
			for i in range(2):
				var wy := r.position.y + TILE * (0.3 + 0.4 * float(i))
				var shift := sin(_time * 1.6 + float(cell.x) + float(i) * 1.7) * 6.0
				draw_arc(Vector2(r.position.x + TILE * 0.5 + shift, wy), 9.0, PI * 1.15, PI * 1.85, 8, Color(1, 1, 1, 0.45), 2.0)
		"t":
			draw_rect(r, grass)
			draw_rect(Rect2(r.position + Vector2(TILE * 0.42, TILE * 0.55), Vector2(TILE * 0.16, TILE * 0.4)), Color("#6b4a2f"))
			draw_circle(r.position + Vector2(TILE * 0.5, TILE * 0.42), TILE * 0.36, Color("#2f6b3a"))
			draw_circle(r.position + Vector2(TILE * 0.38, TILE * 0.34), TILE * 0.18, Color("#3d8048"))
		"f":
			draw_rect(r, grass)
			for fx in [0.15, 0.85]:
				draw_rect(Rect2(r.position + Vector2(TILE * float(fx) - 3, TILE * 0.25), Vector2(6, TILE * 0.6)), Color("#8a6239"))
			for fy in [0.4, 0.68]:
				draw_rect(Rect2(r.position + Vector2(0, TILE * float(fy)), Vector2(TILE, 5)), Color("#a3784a"))
		_:
			draw_rect(r, grass)
			if t == "g" and h % 5 == 0:
				var tx := r.position.x + float(h % 30) + 8.0
				var ty := r.position.y + float((h >> 3) % 30) + 10.0
				for dx in [-3.0, 0.0, 3.0]:
					draw_line(Vector2(tx + dx, ty), Vector2(tx + dx * 1.6, ty - 7.0), Color("#4f8a3a"), 1.5)


func _draw_house(r: Rect2) -> void:
	var wall := Rect2(r.position + Vector2(4, r.size.y * 0.38), Vector2(r.size.x - 8, r.size.y * 0.6))
	draw_rect(wall, Color("#efe3c8"))
	draw_colored_polygon(PackedVector2Array([r.position + Vector2(-4, r.size.y * 0.42), r.position + Vector2(r.size.x * 0.5, 2), r.position + Vector2(r.size.x + 4, r.size.y * 0.42)]), Color("#b5523b"))
	draw_rect(Rect2(wall.position + Vector2(wall.size.x * 0.4, wall.size.y * 0.35), Vector2(wall.size.x * 0.22, wall.size.y * 0.65)), Color("#6b4a2f"))
	draw_rect(Rect2(wall.position + Vector2(wall.size.x * 0.1, wall.size.y * 0.2), Vector2(wall.size.x * 0.2, wall.size.y * 0.3)), Color("#8ec5e8"))


func _draw_market(r: Rect2) -> void:
	var counter := Rect2(r.position + Vector2(2, r.size.y * 0.45), Vector2(r.size.x - 4, r.size.y * 0.5))
	draw_rect(counter, Color("#a3784a"))
	var stripes := 6
	for i in range(stripes):
		var sx := r.position.x + r.size.x * float(i) / float(stripes)
		draw_rect(Rect2(Vector2(sx, r.position.y + 4), Vector2(r.size.x / float(stripes), r.size.y * 0.3)), Color("#e5484d") if i % 2 == 0 else Color("#f6f1e7"))
	for i in range(crop_order.size()):
		var c := crop(str(crop_order[i]))
		var cx := counter.position.x + counter.size.x * (float(i) + 0.5) / float(maxi(crop_order.size(), 1))
		draw_circle(Vector2(cx, counter.position.y + 10), 7.0, Color(str(c.get("color", "#ffffff"))))


func _draw_crop(cell: Vector2i, p: Dictionary) -> void:
	var c := crop(str(p["crop"]))
	var days := maxf(float(c.get("days", 1)), 1.0)
	var f := clampf(float(p["grown"]) / days, 0.0, 1.0)
	var base := center(cell) + Vector2(0, TILE * 0.3)
	var fruit := Color(str(c.get("color", "#5aa832")))
	if f <= 0.0:
		for dx in [-8.0, 0.0, 8.0]:
			draw_circle(base + Vector2(dx, -4), 2.5, Color("#3d2b1c"))
		return
	var top := base + Vector2(0, -TILE * (0.2 + 0.45 * f))
	draw_line(base, top, Color("#3f7d2b"), 3.0)
	for i in range(int(2 + f * 3)):
		var side := -1.0 if i % 2 == 0 else 1.0
		var at := base.lerp(top, 0.3 + 0.18 * float(i))
		draw_circle(at + Vector2(side * 6.0 * (0.6 + f), 0), 4.0 + 3.0 * f, Color("#4c9a35"))
	if f >= 1.0:
		for i in range(3):
			draw_circle(top + Vector2((float(i) - 1.0) * 8.0, 6.0 + float(i % 2) * 4.0), 6.0, fruit)
		draw_circle(top + Vector2(10, -6), 2.0 + sin(_time * 4.0) * 1.0, Color(1, 1, 0.8, 0.8))

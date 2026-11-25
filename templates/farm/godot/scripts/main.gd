extends Node2D
## Runs the farm: the day clock, the farmer's walking and work (planting, watering, harvesting, selling
## at the stall, sleeping in the house), the weather, the money and the compiled rule programs.
##
## Command-line options (after "--"):
##   --studio-telemetry   print one JSON line per rule run and twice a second for performance
##   --studio-smoke       run the headless self-test and quit (see smoke_test.gd)
## Progress is saved every morning and when the game closes (progress.gd); F9 starts over.

const RulesVM := preload("res://addons/gamestudio_runtime/rules_vm.gd")
const FarmHost := preload("res://scripts/farm_host.gd")
const SoundBank := preload("res://scripts/sound_bank.gd")
const InputSetup := preload("res://scripts/input_setup.gd")
const SmokeTest := preload("res://scripts/smoke_test.gd")
const Progress := preload("res://scripts/progress.gd")
const FarmMap := preload("res://scripts/farm_map.gd")
const RULES_INDEX := "res://gamestudio_data/rules_index.json"
const FARM_PATH := "res://gamestudio_data/farm.json"
const MAX_CHAINED_EVENTS := 32
## Walking speed in pixels a second (a tile is 48).
const SPEED := 170.0
const RADIUS := 13.0

@onready var map: Node2D = $Farm
@onready var farmer: Node2D = $Farmer
@onready var camera: Camera2D = $Camera
@onready var hud: CanvasLayer = $HUD
@onready var daylight: CanvasModulate = $Daylight

var programs: Array = []
var rule_errors: Array = []
var host: RefCounted
var sounds: Node
var telemetry := false
var keep_progress := false
var money := 0
var day := 1
## Seconds into today, and how long a day lasts.
var day_time := 0.0
var day_length := 90.0
var rain_chance := 0.25
var currency := "coins"
## Today's market price of each crop, what is in the basket waiting to be sold, and totals so far.
var prices: Dictionary = {}
var basket: Dictionary = {}
var harvested: Dictionary = {}
var sold: Dictionary = {}
var seed_index := 0
var ended := false
## Events the rules were sent, in order (for the self-test).
var events_seen: Array = []
var _firing := false
var _queued: Array = []
var _rng := RandomNumberGenerator.new()
var _rain: CPUParticles2D
var _stats_time := 0.0
var _level_id := ""


func _ready() -> void:
	InputSetup.ensure_actions()
	var args := OS.get_cmdline_user_args()
	telemetry = args.has("--studio-telemetry")
	# The weather comes from a seeded generator, so the same choices give the same season.
	_rng.seed = 2026
	sounds = SoundBank.new()
	sounds.name = "Sounds"
	add_child(sounds)
	var f: Dictionary = map.get("farm")
	var problem := str(map.get("load_error"))
	if problem != "":
		hud.call("show_error", "Farm data problem: %s" % problem)
	money = int(f.get("startMoney", 0))
	day_length = maxf(float(f.get("dayLength", 90.0)), 5.0)
	rain_chance = clampf(float(f.get("rainChance", 0.25)), 0.0, 1.0)
	currency = str(f.get("currency", "coins"))
	for id in map.get("crop_order"):
		prices[id] = int((map.call("crop", id) as Dictionary).get("price", 0))
		basket[id] = 0
		harvested[id] = 0
		sold[id] = 0
	var who: Dictionary = f.get("farmer", {})
	farmer.call("setup", str(who.get("name", "Farmer")), Color(str(who.get("shirt", "#e8833a"))))
	farmer.position = map.call("spawn_position")
	var map_size := Vector2(float(map.get("width")), float(map.get("height"))) * FarmMap.TILE
	camera.limit_left = 0
	camera.limit_top = 0
	camera.limit_right = int(map_size.x)
	camera.limit_bottom = int(map_size.y)
	camera.position_smoothing_enabled = true
	_make_rain()
	host = FarmHost.new(self)
	_load_programs()
	hud.call("set_currency", currency)
	_refresh_hud()
	var ids: Array = []
	for entry in programs:
		ids.append(entry["id"])
	_emit({"type": "ready", "programs": ids, "farmError": problem, "ruleErrors": rule_errors})
	fire("start", {})
	if args.has("--studio-smoke"):
		var smoke := SmokeTest.new()
		smoke.name = "SmokeTest"
		add_child(smoke)
		smoke.call("run", self)
	else:
		keep_progress = true
		_restore_progress()


func _load_programs() -> void:
	programs.clear()
	if not FileAccess.file_exists(RULES_INDEX):
		rule_errors.append("No compiled rules found. Save the project in Game Studio to compile them.")
		hud.call("show_error", rule_errors[-1])
		return
	var index = JSON.parse_string(FileAccess.get_file_as_string(RULES_INDEX))
	if typeof(index) != TYPE_DICTIONARY:
		rule_errors.append("rules_index.json is not valid JSON")
		hud.call("show_error", rule_errors[-1])
		return
	var name_check := RegEx.create_from_string("^[a-z0-9][a-z0-9-]*\\.ir\\.json$")
	for entry in index.get("programs", []):
		var file_name := str(entry)
		if name_check.search(file_name) == null:
			rule_errors.append("Ignored rule file with an unexpected name: %s" % file_name)
			continue
		var path := "res://gamestudio_data/rules/%s" % file_name
		var raw := FileAccess.get_file_as_string(path)
		_level_id += raw.md5_text()
		var data = JSON.parse_string(raw)
		if typeof(data) != TYPE_DICTIONARY:
			rule_errors.append("Cannot read %s" % path)
			continue
		var vm = RulesVM.new()
		var problem: String = vm.load_program(data)
		if problem != "":
			rule_errors.append("%s: %s" % [file_name, problem])
			continue
		programs.append({"id": str(data.get("graphId", file_name)), "vm": vm})
	if not rule_errors.is_empty():
		hud.call("show_error", "\n".join(PackedStringArray(rule_errors)))


## Sends a farm event to every rule program that handles it. Events raised while rules run wait until
## the running one has finished (the rules VM runs one handler at a time).
func fire(event: String, payload: Dictionary) -> void:
	if _firing:
		_queued.append([event, payload])
		return
	_firing = true
	_run_event(event, payload)
	var chained := 0
	while not _queued.is_empty() and chained < MAX_CHAINED_EVENTS:
		var next: Array = _queued.pop_front()
		_run_event(str(next[0]), next[1])
		chained += 1
	_firing = false
	if not _queued.is_empty():
		var rest := _queued.duplicate()
		_queued.clear()
		for item in rest:
			call_deferred("fire", str(item[0]), item[1])


func _run_event(event: String, payload: Dictionary) -> void:
	events_seen.append(event)
	for entry in programs:
		var vm = entry["vm"]
		if not vm.has_handler(event):
			continue
		var result: Dictionary = vm.run(event, payload, host)
		if result["error"] != null:
			var message := "Rule error in %s: %s" % [entry["id"], str(result["error"])]
			push_warning(message)
			rule_errors.append(message)
			hud.call("show_error", message)
		for line in result["logs"]:
			print("[rules] %s" % str(line))
		_emit({"type": "rule", "program": entry["id"], "event": event, "payload": payload, "trace": result["trace"], "logs": result["logs"], "error": result["error"], "errorNode": result["errorNode"], "halted": result["halted"]})
	_refresh_hud()


# ---- What the rules can do (farm_host.gd) --------------------------------------------------------

func change_money(amount: int) -> void:
	money = maxi(0, money + amount)
	_refresh_hud()


func set_price(crop_id: String, price: int) -> void:
	prices[crop_id] = maxi(0, price)
	_refresh_hud()


func make_rain() -> void:
	map.call("set_rain", true)
	_rain.emitting = true


func end_season(text: String) -> void:
	if ended:
		return
	ended = true
	hud.call("show_result", text)
	_save_progress()


# ---- The day ----------------------------------------------------------------------------------

func _physics_process(delta: float) -> void:
	if Input.is_action_just_pressed("toggle_stats"):
		hud.call("toggle_stats")
	if Input.is_action_just_pressed("new_game"):
		_start_over()
		return
	if ended:
		farmer.set("moving", false)
		return
	day_time += delta
	if day_time >= day_length:
		hud.call("show_message", "Night falls; %s heads home to sleep." % str(farmer.get("farmer_name")), 3.0)
		new_day()
		return
	_walk(delta)
	var target := facing_cell()
	map.set("target", target)
	hud.call("set_prompt", prompt_for(target))
	if Input.is_action_just_pressed("use"):
		act(target)
	if Input.is_action_just_pressed("next_seed"):
		select_seed(seed_index + 1)
	_light()
	_refresh_clock()


func _walk(delta: float) -> void:
	var input := Input.get_vector("move_left", "move_right", "move_up", "move_down")
	farmer.set("moving", input.length() > 0.1)
	if input.length() <= 0.1:
		return
	farmer.set("facing", input.normalized())
	var step := input.limit_length(1.0) * SPEED * delta
	# Each axis on its own, so the farmer slides along a fence or the pond.
	var p: Vector2 = farmer.position
	if _free(Vector2(p.x + step.x, p.y)):
		p.x += step.x
	if _free(Vector2(p.x, p.y + step.y)):
		p.y += step.y
	farmer.position = p
	camera.position = p


## Whether the farmer's round shape fits at `p` without touching a tile it cannot walk on.
func _free(p: Vector2) -> bool:
	for corner in [Vector2(-RADIUS, -RADIUS), Vector2(RADIUS, -RADIUS), Vector2(-RADIUS, RADIUS), Vector2(RADIUS, RADIUS)]:
		if not bool(map.call("walkable", map.call("cell_at", p + corner))):
			return false
	return true


## The tile in front of the farmer (up, down, left or right, whichever way it mostly faces).
func facing_cell() -> Vector2i:
	var f: Vector2 = farmer.get("facing")
	var dir := Vector2(signf(f.x), 0.0) if absf(f.x) > absf(f.y) else Vector2(0.0, signf(f.y))
	return map.call("cell_at", farmer.position + dir * FarmMap.TILE * 0.7)


func selected_crop() -> Dictionary:
	var order: Array = map.get("crop_order")
	if order.is_empty():
		return {}
	return map.call("crop", str(order[seed_index % order.size()]))


func select_seed(index: int) -> void:
	var order: Array = map.get("crop_order")
	seed_index = 0 if order.is_empty() else posmod(index, order.size())
	_refresh_hud()


func prompt_for(cell: Vector2i) -> String:
	var t := str(map.call("tile", cell))
	var plots: Dictionary = map.get("plots")
	match t:
		"s":
			if not plots.has(cell):
				var c := selected_crop()
				if c.is_empty():
					return ""
				var cost := int(c.get("seedCost", 0))
				return ("E  plant %s (%d %s)" % [str(c.get("name", "")), cost, currency]) if money >= cost else ("%s seed: %d %s (you have %d)" % [str(c.get("name", "")), cost, currency, money])
			var p: Dictionary = plots[cell]
			var growing: Dictionary = map.call("crop", str(p["crop"]))
			if bool(map.call("is_ready", cell)):
				return "E  harvest %s" % str(growing.get("name", ""))
			if not bool(p["watered"]) and bool(growing.get("needsWater", true)):
				return "E  water the %s" % str(growing.get("name", ""))
			return "%s: %d of %d days grown%s" % [str(growing.get("name", "")), int(p["grown"]), int(growing.get("days", 1)), ", watered" if bool(p["watered"]) else ""]
		"m":
			var count := 0
			var coins := 0
			for id in basket:
				count += int(basket[id])
				coins += int(basket[id]) * int(prices.get(id, 0))
			return ("E  sell %d for %d %s" % [count, coins, currency]) if count > 0 else "Market stall: harvest something to sell"
		"h":
			return "E  sleep until morning"
	return ""


## E on the tile in front: plant bare soil, water a dry crop, harvest a ripe one, sell at the stall,
## sleep in the house. Returns what happened ("" for nothing).
func act(cell: Vector2i) -> String:
	var t := str(map.call("tile", cell))
	var plots: Dictionary = map.get("plots")
	if t == "s":
		if not plots.has(cell):
			var c := selected_crop()
			var cost := int(c.get("seedCost", 0))
			if c.is_empty() or money < cost:
				hud.call("show_message", "Not enough %s for a %s seed (%d)." % [currency, str(c.get("name", "")), cost], 2.5)
				return ""
			if not bool(map.call("plant", cell, str(c.get("id", "")))):
				return ""
			money -= cost
			sounds.call("play", "plant")
			fire("planted", {"crop": str(c.get("id", "")), "cropName": str(c.get("name", ""))})
			return "planted"
		if bool(map.call("is_ready", cell)):
			var got: Dictionary = map.call("harvest", cell)
			var id := str(got["crop"])
			basket[id] = int(basket.get(id, 0)) + int(got["amount"])
			harvested[id] = int(harvested.get(id, 0)) + int(got["amount"])
			sounds.call("play", "harvest")
			fire("harvested", {"crop": id, "cropName": str((map.call("crop", id) as Dictionary).get("name", id)), "amount": float(got["amount"])})
			return "harvested"
		if bool(map.call("water", cell)):
			sounds.call("play", "water")
			return "watered"
		return ""
	if t == "m":
		return "sold" if sell_all() > 0 else ""
	if t == "h":
		new_day()
		return "slept"
	return ""


## Sells everything in the basket at today's prices, one crop at a time. Returns the coins made.
func sell_all() -> int:
	var total := 0
	for id in map.get("crop_order"):
		var count := int(basket.get(id, 0))
		if count <= 0:
			continue
		var coins := count * int(prices.get(id, 0))
		money += coins
		total += coins
		basket[id] = 0
		sold[id] = int(sold.get(id, 0)) + count
		fire("sold", {"crop": str(id), "amount": float(count), "coins": float(coins)})
	if total == 0:
		hud.call("show_message", "Nothing to sell yet: harvest ripe crops first.", 2.5)
	_refresh_hud()
	return total


## The night passes: crops grow, the weather turns, the farmer wakes at home, and the rules hear of it.
func new_day() -> void:
	if ended:
		return
	var rain := _rng.randf() < rain_chance
	map.call("grow_overnight", rain)
	day += 1
	day_time = 0.0
	farmer.position = map.call("spawn_position")
	camera.position = farmer.position
	camera.reset_smoothing()
	_rain.emitting = rain
	fire("newDay", {"day": float(day), "rain": rain})
	_save_progress()


func _light() -> void:
	# Morning gold, bright midday, evening orange, dusk blue at the end of the day.
	var t := clampf(day_time / day_length, 0.0, 1.0)
	var c: Color
	if t < 0.15:
		c = Color(1.0, 0.9, 0.78).lerp(Color.WHITE, t / 0.15)
	elif t < 0.7:
		c = Color.WHITE
	elif t < 0.9:
		c = Color.WHITE.lerp(Color(1.0, 0.78, 0.6), (t - 0.7) / 0.2)
	else:
		c = Color(1.0, 0.78, 0.6).lerp(Color(0.55, 0.6, 0.85), (t - 0.9) / 0.1)
	if bool(map.get("raining")):
		c = c.darkened(0.15)
	daylight.color = c


func _refresh_clock() -> void:
	# The day runs from 6:00 to 20:00.
	var minutes := int(360.0 + 840.0 * clampf(day_time / day_length, 0.0, 1.0))
	hud.call("set_clock", "%d:%02d" % [minutes / 60, (minutes % 60) / 10 * 10])


func _refresh_hud() -> void:
	if hud == null:
		return
	hud.call("set_money", money)
	hud.call("set_day", day, bool(map.get("raining")))
	var c := selected_crop()
	hud.call("set_seed", str(c.get("name", "")), int(c.get("seedCost", 0)), Color(str(c.get("color", "#ffffff"))))
	var lines: Array = []
	for id in map.get("crop_order"):
		if int(basket.get(id, 0)) > 0:
			lines.append("%s %d" % [str((map.call("crop", id) as Dictionary).get("name", id)), int(basket[id])])
	hud.call("set_basket", lines)


func _make_rain() -> void:
	_rain = CPUParticles2D.new()
	_rain.name = "Rain"
	_rain.amount = 220
	_rain.lifetime = 0.9
	_rain.emission_shape = CPUParticles2D.EMISSION_SHAPE_RECTANGLE
	var size := Vector2(float(map.get("width")), float(map.get("height"))) * FarmMap.TILE
	_rain.emission_rect_extents = Vector2(size.x / 2.0, 10.0)
	_rain.position = Vector2(size.x / 2.0, -20.0)
	_rain.direction = Vector2(-0.2, 1.0)
	_rain.spread = 4.0
	_rain.gravity = Vector2.ZERO
	_rain.initial_velocity_min = size.y * 1.1
	_rain.initial_velocity_max = size.y * 1.3
	_rain.scale_amount_min = 1.0
	_rain.scale_amount_max = 2.0
	_rain.color = Color(0.75, 0.85, 1.0, 0.6)
	_rain.emitting = false
	add_child(_rain)


func _process(delta: float) -> void:
	_stats_time += delta
	if _stats_time < 0.5:
		return
	_stats_time = 0.0
	var stats := {
		"type": "perf",
		"fps": Engine.get_frames_per_second(),
		"processMs": Performance.get_monitor(Performance.TIME_PROCESS) * 1000.0,
		"physicsMs": Performance.get_monitor(Performance.TIME_PHYSICS_PROCESS) * 1000.0,
		"nodes": Performance.get_monitor(Performance.OBJECT_NODE_COUNT),
		"drawCalls": Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME),
		"memoryMb": Performance.get_monitor(Performance.MEMORY_STATIC) / 1048576.0,
		# Where the farmer stands, in tiles, as x, height, y (Game Studio reads three numbers, as from the 3D games).
		"player": [snappedf(farmer.position.x / FarmMap.TILE, 0.01), 0.0, snappedf(farmer.position.y / FarmMap.TILE, 0.01)],
		"money": money,
		"day": day,
	}
	hud.call("update_stats", stats)
	_emit(stats)


func _notification(what: int) -> void:
	if what == NOTIFICATION_WM_CLOSE_REQUEST:
		_save_progress()


# ---- Progress (see progress.gd) ----------------------------------------------------------------

func _fingerprint() -> String:
	return (FileAccess.get_file_as_string(FARM_PATH) + _level_id).md5_text()


func _progress_state() -> Dictionary:
	var plots: Dictionary = map.get("plots")
	var saved_plots: Array = []
	for cell in plots:
		var p: Dictionary = plots[cell]
		saved_plots.append([cell.x, cell.y, str(p["crop"]), int(p["grown"]), bool(p["watered"])])
	var rules := {}
	for entry in programs:
		rules[entry["id"]] = entry["vm"].variables
	return {
		"level": _fingerprint(),
		"money": money,
		"day": day,
		"raining": map.get("raining"),
		"prices": prices,
		"basket": basket,
		"harvested": harvested,
		"sold": sold,
		"plots": saved_plots,
		"ended": ended,
		"rules": rules,
		# As text: the generator's state is a 64-bit number, which JSON numbers cannot hold exactly.
		"rng": str(_rng.state),
	}


func _save_progress() -> void:
	if keep_progress and not Progress.write(_progress_state()):
		push_warning("Could not save progress to %s" % Progress.PATH)


func _restore_progress() -> void:
	var saved := Progress.read()
	if saved.is_empty():
		return
	if str(saved.get("level", "")) != _fingerprint():
		hud.call("show_message", "The farm has changed since you last played, so the season starts again.", 5.0)
		return
	money = int(saved.get("money", money))
	day = int(saved.get("day", day))
	map.call("set_rain", bool(saved.get("raining", false)))
	_rain.emitting = bool(saved.get("raining", false))
	for table in ["prices", "basket", "harvested", "sold"]:
		var from = saved.get(table, {})
		if typeof(from) == TYPE_DICTIONARY:
			var into: Dictionary = get(table)
			for id in from:
				if into.has(id):
					into[id] = int(from[id])
	var plots: Dictionary = map.get("plots")
	for p in saved.get("plots", []):
		if typeof(p) == TYPE_ARRAY and (p as Array).size() == 5 and (map.get("crops") as Dictionary).has(str(p[2])):
			plots[Vector2i(int(p[0]), int(p[1]))] = {"crop": str(p[2]), "grown": int(p[3]), "watered": bool(p[4])}
	var rules = saved.get("rules", {})
	if typeof(rules) == TYPE_DICTIONARY:
		for entry in programs:
			if typeof(rules.get(entry["id"])) == TYPE_DICTIONARY:
				entry["vm"].variables = (rules[entry["id"]] as Dictionary).duplicate(true)
	if saved.has("rng"):
		_rng.state = str(saved["rng"]).to_int()
	_refresh_hud()
	hud.call("show_message", "Welcome back: day %d. Press F9 to start the season over." % day, 4.0)
	if bool(saved.get("ended", false)):
		ended = true
		hud.call("show_result", "This season is over. Press F9 to start a new one.")


func _start_over() -> void:
	keep_progress = false
	Progress.clear()
	get_tree().reload_current_scene()


func _emit(data: Dictionary) -> void:
	if telemetry:
		print("GSTUDIO " + JSON.stringify(data))

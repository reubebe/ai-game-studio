extends Node
## Headless self-test:
##   godot --headless --path <project> -- --studio-smoke
## Plays scripted moments of a season: walking, the fences, planting, watering, growing overnight, a dry
## crop waiting, the harvest, selling at the stall, rain, sleeping, the day running out, market day and
## the end of the season. Prints one line starting with GSTUDIO_SMOKE (JSON) and quits with 0 on success
## or 1 on failure. What the rules made of it is reported under "observations" for the caller to judge.

const FarmMap := preload("res://scripts/farm_map.gd")

var checks: Array = []
var failed := false
## Each morning's market prices (day -> {crop id: price}), for the caller to judge market days.
var prices_by_day := {}
var main: Node
var map: Node
var farmer: Node2D
var hud: Node


func _check(check_name: String, ok: bool, detail: String = "") -> void:
	checks.append({"name": check_name, "ok": ok, "detail": detail})
	if not ok:
		failed = true


func _frames(count: int) -> void:
	for i in range(count):
		await get_tree().physics_frame


## Stands the farmer on a walkable tile next to `cell`, facing it. False when no side of it is walkable.
func _stand_by(cell: Vector2i) -> bool:
	for side in [Vector2i.UP, Vector2i.LEFT, Vector2i.RIGHT, Vector2i.DOWN]:
		var spot: Vector2i = cell + side
		if bool(map.call("walkable", spot)):
			farmer.position = map.call("center", spot)
			farmer.set("facing", Vector2(-side))
			return true
	return false


## Sleeps through the night (as the house does) and notes the new morning's prices.
func _next_day() -> void:
	main.call("new_day")
	prices_by_day[str(main.get("day"))] = (main.get("prices") as Dictionary).duplicate()


func _soil_cells() -> Array:
	return (map.call("cells_of", "s") as Array).filter(func(c): return _neighbour_free(c))


func _neighbour_free(cell: Vector2i) -> bool:
	for side in [Vector2i.UP, Vector2i.LEFT, Vector2i.RIGHT, Vector2i.DOWN]:
		if bool(map.call("walkable", cell + side)):
			return true
	return false


func run(m: Node) -> void:
	main = m
	map = main.get("map")
	farmer = main.get("farmer")
	hud = main.get("hud")
	await _frames(3)
	_check("farm data loads", str(map.get("load_error")) == "", str(map.get("load_error")))
	var programs: Array = main.get("programs")
	_check("rule programs load", programs.size() > 0, "%d program(s)" % programs.size())
	_check("the start rules set a goal", str(hud.get("goal")) != "", str(hud.get("goal")))
	# The weather is set by each check below, so dry days stay dry.
	main.set("rain_chance", 0.0)

	# Walking, and the trees, fences and water stopping the farmer.
	var from := farmer.position
	Input.action_press("move_right")
	await _frames(30)
	Input.action_release("move_right")
	await _frames(2)
	_check("the farmer walks where the keys say", farmer.position.x - from.x > 40.0, "%.0f px to the right" % (farmer.position.x - from.x))
	var start_cell: Vector2i = map.call("cell_at", farmer.position)
	Input.action_press("move_up")
	await _frames(240)
	Input.action_release("move_up")
	await _frames(2)
	var stood: Vector2i = map.call("cell_at", farmer.position)
	_check("trees, fences and water stop the farmer", bool(map.call("walkable", stood)) and stood.y < start_cell.y, "walked up from row %d to row %d (%s)" % [start_cell.y, stood.y, str(map.call("tile", stood))])

	# Planting, watering, growing overnight, the harvest.
	var soil := _soil_cells()
	_check("the farm has soil the farmer can reach", soil.size() >= 2, "%d reachable soil tiles" % soil.size())
	if soil.size() < 2:
		_finish()
		return
	var first: Vector2i = soil[0]
	var second: Vector2i = soil[1]
	main.call("select_seed", 0)
	var crop: Dictionary = main.call("selected_crop")
	var crop_id := str(crop.get("id", ""))
	var days := int(crop.get("days", 1))
	var money_before := int(main.get("money"))
	_stand_by(first)
	var planted := str(main.call("act", first))
	var plots: Dictionary = map.get("plots")
	_check("planting a seed pays for it and the rules hear of it", planted == "planted" and plots.has(first) and int(main.get("money")) == money_before - int(crop.get("seedCost", 0)) and (main.get("events_seen") as Array).has("planted"), "%s %s; %d -> %d" % [planted, crop_id, money_before, int(main.get("money"))])
	var watered := str(main.call("act", first))
	_check("watering a planted tile", watered == "watered" and bool(plots[first]["watered"]), watered)
	_stand_by(second)
	main.call("act", second)
	_next_day()
	_check("a watered crop grows overnight; a dry one waits", int(plots[first]["grown"]) == 1 and int(plots[second]["grown"]) == 0, "watered %d day(s), dry %d" % [int(plots[first]["grown"]), int(plots[second]["grown"])])
	for i in range(days - 1):
		_stand_by(first)
		main.call("act", first)
		_next_day()
	_stand_by(first)
	var basket_before := int((main.get("basket") as Dictionary).get(crop_id, 0))
	var harvested := str(main.call("act", first))
	var basket_now := int((main.get("basket") as Dictionary).get(crop_id, 0))
	_check("a grown crop is harvested into the basket", harvested == "harvested" and basket_now == basket_before + int(crop.get("yield", 1)) and (main.get("events_seen") as Array).has("harvested"), "%s: basket %d -> %d" % [harvested, basket_before, basket_now])

	# Selling at the stall.
	var stall: Array = map.call("cells_of", "m")
	var sold_ok := false
	var detail := "no market stall"
	if not stall.is_empty():
		for cell in stall:
			if _stand_by(cell):
				money_before = int(main.get("money"))
				var price := int((main.get("prices") as Dictionary).get(crop_id, 0))
				var result := str(main.call("act", cell))
				sold_ok = result == "sold" and int(main.get("money")) == money_before + basket_now * price and int((main.get("basket") as Dictionary).get(crop_id, 0)) == 0
				detail = "%s: %d -> %d (%d x %d)" % [result, money_before, int(main.get("money")), basket_now, price]
				break
	_check("the stall buys the harvest at today's price", sold_ok and (main.get("events_seen") as Array).has("sold"), detail)

	# Rain: the dry crop grows without watering.
	var dry_before := int(plots[second]["grown"]) if plots.has(second) else -1
	main.set("rain_chance", 1.0)
	_next_day()
	_next_day()
	main.set("rain_chance", 0.0)
	var dry_after := int(plots[second]["grown"]) if plots.has(second) else -1
	_check("rain waters every crop", dry_after > dry_before and dry_before >= 0, "dry crop %d -> %d days" % [dry_before, dry_after])

	# Sleeping in the house, and the day running out.
	var day_before := int(main.get("day"))
	var slept := ""
	for cell in map.call("cells_of", "h"):
		if _stand_by(cell):
			slept = str(main.call("act", cell))
			break
	prices_by_day[str(main.get("day"))] = (main.get("prices") as Dictionary).duplicate()
	_check("sleeping in the house starts the next day", slept == "slept" and int(main.get("day")) == day_before + 1, "%s: day %d -> %d" % [slept, day_before, int(main.get("day"))])
	day_before = int(main.get("day"))
	main.set("day_time", float(main.get("day_length")) - 0.05)
	await _frames(10)
	prices_by_day[str(main.get("day"))] = (main.get("prices") as Dictionary).duplicate()
	_check("the day ends by itself when its time runs out", int(main.get("day")) == day_before + 1, "day %d -> %d" % [day_before, int(main.get("day"))])

	# The season: run the days to the end until the rules end it (or 30 days pass).
	var guard := 0
	while not bool(main.get("ended")) and guard < 30:
		_next_day()
		guard += 1
	_check("the rules end the season", bool(main.get("ended")) and str(hud.get("ended_text")) != "", "day %d: %s" % [int(main.get("day")), str(hud.get("ended_text"))])
	_finish()


func _finish() -> void:
	var rule_errors: Array = main.get("rule_errors")
	_check("rules run without errors", rule_errors.is_empty(), "; ".join(PackedStringArray(rule_errors)))
	var sounds: Node = main.get("sounds")
	var observations := {
		"money": main.get("money"),
		"day": main.get("day"),
		"harvested": main.get("harvested"),
		"sold": main.get("sold"),
		"prices": prices_by_day,
		"goal": hud.get("goal"),
		"ended": hud.get("ended_text"),
		"messages": hud.get("messages_shown"),
		"events": main.get("events_seen"),
		"sounds": sounds.get("played"),
	}
	print("GSTUDIO_SMOKE " + JSON.stringify({"pass": not failed, "checks": checks, "observations": observations}))
	sounds.call("stop_all")
	await _frames(30)
	get_tree().quit(1 if failed else 0)

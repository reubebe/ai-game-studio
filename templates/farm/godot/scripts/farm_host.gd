extends RefCounted
## Connects compiled rule programs to the farm.
## Mirrors FarmSimHost in packages/farm/src/sim-host.ts (the studio's simulator).

## main.gd: money, prices, the weather, the day and the HUD.
var main: Node


func _init(main_node: Node) -> void:
	main = main_node


func _amount(value, what: String) -> Variant:
	var n := float(value)
	if not (n >= 0.0):
		return {"__error": "%s needs a number of 0 or more" % what}
	return int(round(n))


func _crop(id) -> Dictionary:
	return main.get("map").call("crop", str(id))


func call_action(fn: String, args: Dictionary) -> Variant:
	var hud: Node = main.get("hud")
	match fn:
		"farm.message":
			hud.call("show_message", str(args.get("text", "")), float(args.get("seconds", 4.0)))
			return null
		"farm.goal":
			hud.call("set_goal", str(args.get("text", "")))
			return null
		"farm.sound":
			main.get("sounds").call("play", str(args.get("sound", "")))
			return null
		"farm.giveMoney", "farm.takeMoney":
			var n = _amount(args.get("amount", 0), "Give Money" if fn == "farm.giveMoney" else "Take Money")
			if typeof(n) == TYPE_DICTIONARY:
				return n
			main.call("change_money", int(n) if fn == "farm.giveMoney" else -int(n))
			return null
		"farm.setPrice":
			var c := _crop(args.get("crop", ""))
			if c.is_empty():
				return {"__error": "There is no crop '%s' on this farm" % str(args.get("crop", ""))}
			var price = _amount(args.get("price", 0), "Set Crop Price")
			if typeof(price) == TYPE_DICTIONARY:
				return price
			main.call("set_price", str(c.get("id", "")), int(price))
			return null
		"farm.rain":
			main.call("make_rain")
			return null
		"farm.endSeason":
			main.call("end_season", str(args.get("text", "")))
			return null
	return {"__error": "Unknown farm action '%s'" % fn}


func _count(table: Dictionary, crop: String) -> Variant:
	if crop.strip_edges() == "":
		var total := 0
		for id in table:
			total += int(table[id])
		return float(total)
	if not table.has(crop):
		return {"__error": "There is no crop '%s' on this farm" % crop}
	return float(table[crop])


func query(fn: String, args: Dictionary) -> Variant:
	match fn:
		"farm.money":
			return float(main.get("money"))
		"farm.day":
			return float(main.get("day"))
		"farm.harvestedCount":
			return _count(main.get("harvested"), str(args.get("crop", "")))
		"farm.soldCount":
			return _count(main.get("sold"), str(args.get("crop", "")))
		"farm.price", "farm.basePrice":
			var c := _crop(args.get("crop", ""))
			if c.is_empty():
				return {"__error": "There is no crop '%s' on this farm" % str(args.get("crop", ""))}
			if fn == "farm.basePrice":
				return float(c.get("price", 0))
			return float((main.get("prices") as Dictionary).get(str(c.get("id", "")), 0))
		"farm.growing":
			return float((main.get("map").get("plots") as Dictionary).size())
		"farm.raining":
			return main.get("map").get("raining") == true
	return {"__error": "Unknown farm query '%s'" % fn}

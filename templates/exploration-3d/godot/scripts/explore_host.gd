extends RefCounted
## Connects compiled rule programs to the running level.
## Mirrors ExploreSimHost in packages/explore/src/sim-host.ts (the studio's simulator).

var world: Node
var hud: Node
var sounds: Node
## main.gd: the player and the timers.
var main: Node


func _init(world_node: Node, hud_node: Node, sound_node: Node, main_node: Node) -> void:
	world = world_node
	hud = hud_node
	sounds = sound_node
	main = main_node


func _hearts(value) -> int:
	return maxi(0, int(floor(float(value))))


func call_action(fn: String, args: Dictionary) -> Variant:
	match fn:
		"explore.message":
			hud.call("show_message", str(args.get("text", "")), float(args.get("seconds", 4.0)))
			return null
		"explore.objective":
			hud.call("set_objective", str(args.get("text", "")))
			return null
		"explore.openGate":
			var gate_id := str(args.get("gateId", ""))
			if world.call("has_gate", gate_id) != true:
				return {"__error": "There is no gate '%s' in this level" % gate_id}
			world.call("open_gate", gate_id)
			return null
		"explore.sound":
			sounds.call("play", str(args.get("sound", "")))
			return null
		"explore.setVisible":
			var object_id := str(args.get("objectId", ""))
			if world.call("set_object_visible", object_id, args.get("visible") == true) != true:
				return {"__error": "There is no object '%s' in this level" % object_id}
			return null
		"explore.win":
			hud.call("show_win", str(args.get("text", "")))
			return null
		"explore.hurtPlayer":
			main.get("player").call("hurt_by_rules", _hearts(args.get("amount", 1)))
			return null
		"explore.healPlayer":
			main.get("player").call("heal", _hearts(args.get("amount", 1)))
			return null
		"explore.startTimer":
			var timer_id := str(args.get("timerId", "")).strip_edges()
			var seconds := float(args.get("seconds", 0.0))
			if timer_id == "":
				return {"__error": "A timer needs a name"}
			if not (seconds > 0.0):
				return {"__error": "Timer '%s' needs a number of seconds above 0" % timer_id}
			main.call("start_timer", timer_id, seconds, args.get("repeat") == true, str(args.get("countdown", "")))
			return null
		"explore.stopTimer":
			main.call("stop_timer", str(args.get("timerId", "")))
			return null
	return {"__error": "Unknown exploration action '%s'" % fn}


func query(fn: String, args: Dictionary) -> Variant:
	match fn:
		"explore.collectedCount":
			return float(world.call("collected_count", str(args.get("kind", ""))))
		"explore.totalCount":
			return float(world.call("total_count", str(args.get("kind", ""))))
		"explore.isGateOpen":
			return world.call("is_gate_open", str(args.get("gateId", ""))) == true
		"explore.playerHealth":
			return float(main.get("player").get("health"))
		"explore.defeatedCount":
			return float(world.call("defeated_count", str(args.get("kind", ""))))
		"explore.enemyCount":
			return float(world.call("enemy_count", str(args.get("kind", ""))))
		"explore.blocksInZone":
			return float(world.call("blocks_in_zone", str(args.get("zoneId", ""))))
		"explore.timeLeft":
			return maxf(float(main.call("time_left", str(args.get("timerId", "")))), 0.0)
	return {"__error": "Unknown exploration query '%s'" % fn}

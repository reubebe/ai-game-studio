extends RefCounted
## Connects compiled rule programs to the running level.
## Mirrors PlatformerSimHost in packages/platformer/src/sim-host.ts (the studio's simulator).

var level: Node
var hud: Node
var sounds: Node
var hurts := 0


func _init(level_node: Node, hud_node: Node, sound_node: Node) -> void:
	level = level_node
	hud = hud_node
	sounds = sound_node


func call_action(fn: String, args: Dictionary) -> Variant:
	match fn:
		"platformer.message":
			hud.call("show_message", str(args.get("text", "")), float(args.get("seconds", 3.0)))
			return null
		"platformer.objective":
			hud.call("set_objective", str(args.get("text", "")))
			return null
		"platformer.openDoor":
			var door_id := str(args.get("doorId", ""))
			if level.call("has_door", door_id) != true:
				return {"__error": "There is no door '%s' in this level" % door_id}
			level.call("open_door", door_id)
			return null
		"platformer.sound":
			sounds.call("play", str(args.get("sound", "")))
			return null
		"platformer.setVisible":
			var object_id := str(args.get("objectId", ""))
			if level.call("set_object_visible", object_id, args.get("visible") == true) != true:
				return {"__error": "There is no object '%s' in this level" % object_id}
			return null
		"platformer.win":
			hud.call("show_win", str(args.get("text", "")))
			return null
	return {"__error": "Unknown platformer action '%s'" % fn}


func query(fn: String, args: Dictionary) -> Variant:
	match fn:
		"platformer.collectedCount":
			return float(level.call("collected_count", str(args.get("kind", ""))))
		"platformer.totalCount":
			return float(level.call("total_count", str(args.get("kind", ""))))
		"platformer.isDoorOpen":
			return level.call("is_door_open", str(args.get("doorId", ""))) == true
		"platformer.hurtCount":
			return float(hurts)
	return {"__error": "Unknown platformer query '%s'" % fn}

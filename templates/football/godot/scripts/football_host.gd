extends RefCounted
## Connects compiled rule programs to the match.
## Mirrors FootballSimHost in packages/football/src/sim-host.ts (the studio's simulator).

## main.gd: the score, the clock, the teams and the HUD.
var main: Node


func _init(main_node: Node) -> void:
	main = main_node


func _side(value) -> String:
	var t := str(value).strip_edges().to_lower()
	return t if t == "home" or t == "away" else ""


func call_action(fn: String, args: Dictionary) -> Variant:
	var hud: Node = main.get("hud")
	match fn:
		"football.message":
			hud.call("show_message", str(args.get("text", "")), float(args.get("seconds", 3.0)))
			return null
		"football.caption":
			hud.call("set_caption", str(args.get("text", "")))
			return null
		"football.sound":
			main.get("sounds").call("play", str(args.get("sound", "")))
			return null
		"football.addTime":
			var seconds := float(args.get("seconds", 0.0))
			if not (seconds > 0.0):
				return {"__error": "Add Time needs a number of seconds above 0"}
			main.call("add_time", seconds)
			return null
		"football.changeScore":
			var team := _side(args.get("team", ""))
			if team == "":
				return {"__error": "Team must be home or away, not '%s'" % str(args.get("team", ""))}
			main.call("change_score", team, int(float(args.get("amount", 0))))
			return null
		"football.endMatch":
			main.call("end_match", str(args.get("text", "")))
			return null
	return {"__error": "Unknown football action '%s'" % fn}


func query(fn: String, args: Dictionary) -> Variant:
	match fn:
		"football.score":
			var team := _side(args.get("team", ""))
			if team == "":
				return {"__error": "Team must be home or away, not '%s'" % str(args.get("team", ""))}
			return float((main.get("score") as Dictionary)[team])
		"football.timeLeft":
			return maxf(float(main.get("clock")), 0.0)
		"football.teamName":
			var team := _side(args.get("team", ""))
			if team == "":
				return {"__error": "Team must be home or away, not '%s'" % str(args.get("team", ""))}
			return str((main.get("stadium").call("team", team) as Dictionary).get("name", team))
	return {"__error": "Unknown football query '%s'" % fn}

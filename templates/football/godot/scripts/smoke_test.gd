extends Node
## Headless self-test:
##   godot --headless --path <project> -- --studio-smoke
## Plays scripted moments of a match: the kick-off, running, taking the ball, a shot past the keeper and
## the restart, a save, the computer chasing a loose ball, shooting and tackling, a pass, a bounce off the
## boards, a minute of play, and full time with whatever the rules decide. Prints one line starting with
## GSTUDIO_SMOKE (JSON) and quits with 0 on success or 1 on failure. What the rules made of it is
## reported under "observations" for the caller to judge.

const Ball := preload("res://scripts/ball.gd")

var checks: Array = []
var failed := false
var main: Node
var ball: Node3D
var hud: Node


func _check(check_name: String, ok: bool, detail: String = "") -> void:
	checks.append({"name": check_name, "ok": ok, "detail": detail})
	if not ok:
		failed = true


func _frames(count: int) -> void:
	for i in range(count):
		await get_tree().physics_frame


## Holds a team (or everyone) still: stunned players neither move nor touch the ball.
func _freeze(side: String, seconds: float) -> void:
	for p in main.get("players"):
		if side == "" or p.get("team") == side:
			p.set("stunned", seconds)
			p.set("velocity", Vector3.ZERO)


func _give(p: Node3D, at: Vector3, facing: Vector3) -> void:
	p.position = at
	p.set("facing", facing)
	p.set("velocity", Vector3.ZERO)
	p.set("stunned", 0.0)
	p.set("kick_wait", 0.0)
	ball.set("holder", p)
	ball.set("last_touch", p)
	ball.position = at + facing * 0.55 + Vector3(0.0, Ball.RADIUS, 0.0)


func _until(condition: Callable, max_frames: int) -> bool:
	var waited := 0
	while not condition.call() and waited < max_frames:
		await _frames(3)
		waited += 3
	return condition.call()


func run(m: Node) -> void:
	main = m
	ball = main.get("ball")
	hud = main.get("hud")
	var stadium: Node = main.get("stadium")
	var hl := float(stadium.get("half_length"))
	var hw := float(stadium.get("half_width"))
	await _frames(3)
	# The scripted moments below need you on the home team, whatever the match settings say.
	if main.get("human") != "home":
		main.call("reset_match", "home")
		await _frames(2)
	_check("match data loads", str(stadium.get("load_error")) == "", str(stadium.get("load_error")))
	var programs: Array = main.get("programs")
	_check("rule programs load", programs.size() > 0, "%d program(s)" % programs.size())
	_check("the start rules set a caption", str(hud.get("caption")) != "", str(hud.get("caption")))
	var lined := true
	for p in main.get("players"):
		if (p.get("team") == "home" and p.position.x > 0.01) or (p.get("team") == "away" and p.position.x < -0.01):
			lined = false
	_check("both teams line up in their own halves, the ball on the centre spot", lined and Vector2(ball.position.x, ball.position.z).length() < 0.05, "%d players" % (main.get("players") as Array).size())

	await _until(func(): return main.get("phase") == "play", 120)
	var clock_before := float(main.get("clock"))
	await _frames(30)
	_check("after the kick-off the match is in play and the clock runs", main.get("phase") == "play" and float(main.get("clock")) < clock_before, "%.2f s -> %.2f s" % [clock_before, float(main.get("clock"))])

	# You: the keys move the footballer you control; a loose ball at your feet becomes yours and stays with you.
	_freeze("away", 4.0)
	var me: Node3D = main.get("controlled")
	ball.set("holder", null)
	ball.call("place", me.position + Vector3(0.0, 0.0, 3.0))
	var from := me.position
	Input.action_press("move_right")
	await _frames(30)
	Input.action_release("move_right")
	await _frames(2)
	_check("the footballer you control runs where the keys say", me.position.x - from.x > 1.5, "%.2f m to the right" % (me.position.x - from.x))
	ball.call("place", me.position + Vector3(0.4, 0.0, 0.0))
	me.set("kick_wait", 0.0)
	await _frames(3)
	var took: bool = ball.get("holder") == me
	Input.action_press("move_up")
	await _frames(30)
	Input.action_release("move_up")
	await _frames(2)
	var at_feet := Vector2(ball.position.x - me.position.x, ball.position.z - me.position.z).length()
	_check("you take a loose ball and it stays at your feet as you run", took and ball.get("holder") == me and at_feet < 0.8, "took %s, %.2f m from your feet" % [str(took), at_feet])

	# A shot past the keeper (held still) is a goal, the rules announce it, and the other side kicks off.
	_freeze("away", 4.0)
	_give(me, Vector3(hl - 7.0, 0.0, 0.0), Vector3.RIGHT)
	await _frames(2)
	var shot: bool = main.call("human_shoot", Vector3.ZERO)
	await _until(func(): return main.get("phase") != "play", 90)
	var score: Dictionary = main.get("score")
	var announced := (hud.get("messages_shown") as Array).any(func(t): return str(t).begins_with("GOAL!"))
	_check("a shot past the keeper is a goal and the rules announce it", shot and int(score["home"]) == 1 and announced, "shot %s, score %s, messages %s" % [str(shot), JSON.stringify(score), JSON.stringify(hud.get("messages_shown"))])
	await _until(func(): return main.get("phase") == "kickoff", 240)
	var taker_ok: bool = main.get("kickoff_team") == "away" and Vector2(ball.position.x, ball.position.z).length() < 0.05
	_check("after a goal the other side kicks off from the centre", main.get("phase") == "kickoff" and taker_ok, "%s kicks off" % str(main.get("kickoff_team")))
	await _until(func(): return main.get("phase") == "play", 120)

	# A shot struck at the keeper is stopped (caught, or pushed away when too hard).
	var keeper: Node3D = main.call("keeper_of", "away")
	for p in main.call("team_players", "away"):
		if p != keeper:
			p.set("stunned", 3.0)
	_freeze("home", 3.0)
	me = main.get("controlled")
	_give(me, Vector3(hl - 9.0, 0.0, keeper.position.z), Vector3.RIGHT)
	await _frames(2)
	var saves_before := int(main.get("saves"))
	main.call("kick", me, keeper.position - ball.position, 12.0, 0.0)
	await _frames(60)
	_check("the goalkeeper stops a shot struck at him", int(main.get("saves")) > saves_before and int((main.get("score") as Dictionary)["home"]) == 1, "saves %d -> %d" % [saves_before, int(main.get("saves"))])

	# The computer: its players go for a loose ball.
	_freeze("", 0.0)
	_freeze("home", 2.0)
	ball.set("holder", null)
	ball.call("place", Vector3(hl * 0.4, 0.0, 3.0))
	var chaser_before := _nearest("away", ball.position)
	await _frames(30)
	var holder: Node3D = ball.get("holder")
	var chaser_after := _nearest("away", ball.position)
	_check("the computer's players go for a loose ball", (holder != null and holder.get("team") == "away") or chaser_after < chaser_before - 1.0, "nearest %.2f m -> %.2f m, holder %s" % [chaser_before, chaser_after, holder.name if holder != null else "none"])

	# The computer's forward, 9 m out with the home keeper beaten, shoots and scores.
	var level: Dictionary = main.get("level")
	var stray := float(level["stray"])
	level["stray"] = 0.0
	_freeze("home", 4.0)
	_freeze("away", 0.0)
	var striker: Node3D = (main.call("team_players", "away") as Array).back()
	_give(striker, Vector3(-hl + 9.0, 0.0, 0.0), Vector3.LEFT)
	striker.set("think", 0.0)
	await _until(func(): return main.get("phase") != "play", 150)
	level["stray"] = stray
	_check("the computer's forward shoots and scores past a beaten keeper", int((main.get("score") as Dictionary)["away"]) == 1, "score %s, shots %d" % [JSON.stringify(main.get("score")), int(main.get("shots"))])
	await _until(func(): return main.get("phase") == "play", 300)

	# A tackle: the computer's defender next to you takes the ball (every tackle wins, for this check).
	var tackle := float(level["tackle"])
	level["tackle"] = 10.0
	_freeze("", 0.0)
	me = main.get("controlled")
	_give(me, Vector3(0.0, 0.0, 5.0), Vector3.RIGHT)
	var defender: Node3D = (main.call("team_players", "away") as Array)[1]
	defender.position = Vector3(1.0, 0.0, 5.0)
	var tackles_before := int(main.get("tackles_won"))
	await _until(func(): return ball.get("holder") != null and (ball.get("holder") as Node3D).get("team") == "away", 60)
	level["tackle"] = tackle
	holder = ball.get("holder")
	_check("an opponent's tackle takes the ball from you", holder != null and holder.get("team") == "away" and int(main.get("tackles_won")) > tackles_before, "holder %s" % (holder.name if holder != null else "none"))

	# A pass: from midfield to a team-mate, who then becomes the footballer you control.
	_freeze("away", 4.0)
	me = main.get("controlled")
	if me == null or me.get("keeper") == true:
		me = (main.call("team_players", "home") as Array).back()
	_give(me, Vector3(-6.0, 0.0, 0.0), Vector3.RIGHT)
	var mate: Node3D = null
	for p in main.call("team_players", "home"):
		if p != me and p.get("keeper") != true:
			mate = p
			break
	mate.position = Vector3(2.0, 0.0, 3.0)
	mate.set("velocity", Vector3.ZERO)
	await _frames(1)
	var passed: bool = main.call("human_pass", Vector3(1.0, 0.0, 0.4))
	await _until(func(): return ball.get("holder") != null, 90)
	holder = ball.get("holder")
	_check("a pass reaches a team-mate, who you then control", passed and holder != null and holder != me and holder.get("team") == "home" and main.get("controlled") == holder, "passed %s, holder %s, you control %s" % [str(passed), holder.name if holder != null else "none", (main.get("controlled") as Node3D).name])

	# The ball comes back off the boards.
	_freeze("", 1.0)
	ball.set("holder", null)
	ball.call("place", Vector3(0.0, 0.0, hw - 1.0))
	ball.set("velocity", Vector3(0.0, 0.0, 10.0))
	await _frames(15)
	var bounced_back := (ball.get("velocity") as Vector3).z < 0.0 and absf(ball.position.z) <= hw
	_check("the ball bounces back off the boards", bounced_back, "velocity z %.2f, z %.2f" % [(ball.get("velocity") as Vector3).z, ball.position.z])

	# A minute of play runs On Minute.
	var minutes_before := (main.get("events_seen") as Array).count("minute")
	main.set("played_seconds", float(int(main.get("minutes_played")) + 1) * 60.0 - 0.2)
	await _frames(20)
	_check("each full minute of play runs On Minute", (main.get("events_seen") as Array).count("minute") == minutes_before + 1, "%d -> %d" % [minutes_before, (main.get("events_seen") as Array).count("minute")])

	# Full time: the clock runs out; the rules decide what happens (the cup's rules add a golden-goal
	# minute when level). Then the final whistle.
	var level_score := int((main.get("score") as Dictionary)["home"]) == int((main.get("score") as Dictionary)["away"])
	_freeze("", 3.0)
	main.set("clock", 0.3)
	await _frames(30)
	var after_first := {"phase": main.get("phase"), "clock": snappedf(float(main.get("clock")), 0.1), "caption": hud.get("caption")}
	_check("at full time the rules run, and the match ends or plays on as they say", (main.get("events_seen") as Array).count("fullTime") == 1 and (main.get("phase") == "ended" or float(main.get("clock")) > 1.0), JSON.stringify(after_first))
	if main.get("phase") != "ended":
		main.set("clock", 0.3)
		await _frames(30)
	_check("the final whistle shows the result", main.get("phase") == "ended" and bool(hud.get("ended")) and str(hud.get("ended_text")) != "", str(hud.get("ended_text")))

	var sounds: Node = main.get("sounds")
	var observations := {
		"score": main.get("score"),
		"goals": main.get("goals"),
		"levelAtFullTime": level_score,
		"afterFirstFullTime": after_first,
		"caption": hud.get("caption"),
		"ended": hud.get("ended_text"),
		"messages": hud.get("messages_shown"),
		"events": main.get("events_seen"),
		"passes": main.get("passes"),
		"shots": main.get("shots"),
		"tackles": main.get("tackles_won"),
		"saves": main.get("saves"),
		"sounds": sounds.get("played"),
		"players": (main.get("players") as Array).size(),
	}

	# Watching: a fresh match with the computer playing both sides. In 30 seconds both sides pass, and
	# someone shoots.
	main.call("reset_match", "")
	await _until(func(): return main.get("phase") == "play", 120)
	var passes_before: Dictionary = (main.get("passes_by") as Dictionary).duplicate()
	var shots_before := int(main.get("shots"))
	await _frames(1800)
	var passes_now: Dictionary = main.get("passes_by")
	var watched := {
		"homePasses": int(passes_now["home"]) - int(passes_before["home"]),
		"awayPasses": int(passes_now["away"]) - int(passes_before["away"]),
		"shots": int(main.get("shots")) - shots_before,
		"score": (main.get("score") as Dictionary).duplicate(),
		"youControl": main.get("controlled") != null,
	}
	observations["watched"] = watched
	_check("watching, the computer plays both sides: each side passes and shots are taken", int(watched["homePasses"]) > 0 and int(watched["awayPasses"]) > 0 and int(watched["shots"]) > 0 and not bool(watched["youControl"]), JSON.stringify(watched))

	var rule_errors: Array = main.get("rule_errors")
	_check("rules run without errors", rule_errors.is_empty(), "; ".join(PackedStringArray(rule_errors)))
	print("GSTUDIO_SMOKE " + JSON.stringify({"pass": not failed, "checks": checks, "observations": observations}))
	sounds.call("stop_all")
	await _frames(30)
	get_tree().quit(1 if failed else 0)


func _nearest(side: String, to: Vector3) -> float:
	var best := INF
	for p in main.call("team_players", side):
		if p.get("keeper") == true:
			continue
		best = minf(best, Vector2(p.position.x - to.x, p.position.z - to.z).length())
	return best

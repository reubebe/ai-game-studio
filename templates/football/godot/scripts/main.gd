extends Node3D
## Runs the match: kick-offs, the clock, the footballer you control, the computer's choices for every
## other player, the ball, goals, full time and the compiled rule programs.
##
## Command-line options (after "--"):
##   --studio-telemetry   print one JSON line per rule run and twice a second for performance
##   --studio-smoke       run the headless self-test and quit (see smoke_test.gd)
## Matches are short, so nothing is saved; F9 plays the match again.

const RulesVM := preload("res://addons/gamestudio_runtime/rules_vm.gd")
const FootballHost := preload("res://scripts/football_host.gd")
const SoundBank := preload("res://scripts/sound_bank.gd")
const InputSetup := preload("res://scripts/input_setup.gd")
const SmokeTest := preload("res://scripts/smoke_test.gd")
const Ball := preload("res://scripts/ball.gd")
const Footballer := preload("res://scripts/footballer.gd")
const RULES_INDEX := "res://gamestudio_data/rules_index.json"
## Events one event may lead to before the rest wait for the next frame.
const MAX_CHAINED_EVENTS := 32

## Kick-off spots as fractions of a team's half: from its own goal line (0) to halfway (1), and across
## the pitch from -1 to 1. The first is the goalkeeper. Same table as FORMATIONS in packages/football.
const FORMATIONS := {
	2: [[0.04, 0.0], [0.8, 0.0]],
	3: [[0.04, 0.0], [0.45, -0.35], [0.8, 0.35]],
	4: [[0.04, 0.0], [0.4, -0.45], [0.4, 0.45], [0.85, 0.0]],
	5: [[0.04, 0.0], [0.35, -0.45], [0.35, 0.45], [0.75, -0.35], [0.85, 0.35]],
}
## The computer's players by difficulty: running speed (m/s), seconds between decisions, the chance a
## tackle wins the ball, how far shots stray at the goal (m), the keeper's extra reach (m) and the
## fastest shot a keeper catches (m/s; faster ones are pushed away).
const LEVELS := {
	"easy": {"speed": 4.6, "think": 0.45, "tackle": 0.25, "stray": 1.4, "reach": 0.8, "catch": 13.0},
	"normal": {"speed": 5.3, "think": 0.28, "tackle": 0.4, "stray": 0.9, "reach": 1.0, "catch": 15.0},
	"hard": {"speed": 5.9, "think": 0.15, "tackle": 0.55, "stray": 0.5, "reach": 1.2, "catch": 17.0},
}
const PLAYER_SPEED := 5.6
const SPRINT := 1.35
## How close (m, middle to middle) a player must be to take the ball, and the fastest ball an outfield player can stop.
const CONTROL_RANGE := 0.65
const CONTROL_SPEED := 14.0
const SHOT_SPEED := 19.0
const KICK_WAIT := 0.35
const TACKLE_WAIT := 0.8
const GOAL_PAUSE := 2.6
const KICKOFF_PAUSE := 1.2

@onready var stadium: Node3D = $Stadium
@onready var hud: CanvasLayer = $HUD
@onready var camera: Camera3D = $Camera

var programs: Array = []
var rule_errors: Array = []
var host: RefCounted
var sounds: Node
var ball: Node3D
var players: Array = []
var team_size := 5
var level: Dictionary = {}
var controlled: Node3D = null
## The side you control ("home" or "away"), or "" while you watch the computer play both.
var human := "home"
var score := {"home": 0, "away": 0}
## Seconds of play left, and how many full minutes have been played (On Minute).
var clock := 240.0
var minutes_played := 0
var played_seconds := 0.0
## kickoff, play, goal or ended.
var phase := "kickoff"
var phase_time := 0.0
var kickoff_team := "home"
var telemetry := false
## What happened, for the self-test: goals ({team, scorer, own}), events the rules were sent, passes,
## shots, tackles won and keeper saves.
var goals: Array = []
var events_seen: Array = []
var passes := 0
var shots := 0
## Passes and shots by each side (the self-test checks that both sides play when the computer has both).
var passes_by := {"home": 0, "away": 0}
var shots_by := {"home": 0, "away": 0}
var tackles_won := 0
var saves := 0
## The team-mate a pass is meant for while the ball travels (it comes to meet the ball).
var pass_target: Node3D = null
var _pass_time := 0.0
var _firing := false
var _queued: Array = []
var _rng := RandomNumberGenerator.new()
var _switch_wait := 0.0
var _stats_time := 0.0


func _ready() -> void:
	InputSetup.ensure_actions()
	var args := OS.get_cmdline_user_args()
	telemetry = args.has("--studio-telemetry")
	# The same match every run for the same moves: the computer's choices come from a seeded generator.
	_rng.seed = 2026
	sounds = SoundBank.new()
	sounds.name = "Sounds"
	add_child(sounds)
	var m: Dictionary = stadium.get("match_data")
	var problem := str(stadium.get("load_error"))
	if problem != "":
		hud.call("show_error", "Match data problem: %s" % problem)
	level = (LEVELS.get(str(m.get("difficulty", "normal")), LEVELS["normal"]) as Dictionary).duplicate()
	team_size = clampi(int(m.get("teamSize", 5)), 2, 5)
	clock = maxf(float(m.get("minutes", 4.0)), 1.0) * 60.0
	var control := str(m.get("control", "home"))
	human = control if control == "home" or control == "away" else ""
	hud.call("set_watching", human == "")
	hud.call("set_teams", stadium.call("team", "home"), stadium.call("team", "away"))
	hud.call("set_score", 0, 0)
	hud.call("set_clock", clock)
	ball = Ball.new()
	ball.name = "Ball"
	add_child(ball)
	ball.call("setup", float(stadium.get("half_length")) * 2.0, float(stadium.get("half_width")) * 2.0, float(stadium.get("goal_half")) * 2.0)
	ball.connect("goal_crossed", _on_goal_crossed)
	ball.connect("bounced", func() -> void: sounds.call("play", "bounce"))
	_make_teams()
	host = FootballHost.new(self)
	_load_programs()
	_kickoff("home", false)
	_place_camera(1.0, true)
	var ids: Array = []
	for entry in programs:
		ids.append(entry["id"])
	_emit({"type": "ready", "programs": ids, "matchError": problem, "ruleErrors": rule_errors})
	fire("start", {})
	if args.has("--studio-smoke"):
		var smoke := SmokeTest.new()
		smoke.name = "SmokeTest"
		add_child(smoke)
		smoke.call("run", self)


func _make_teams() -> void:
	for side in ["home", "away"]:
		var t: Dictionary = stadium.call("team", side)
		var squad: Array = t.get("players", [])
		for i in range(team_size):
			var p: Node3D = Footballer.new()
			p.name = "%s_%d" % [side, i + 1]
			# The squad's first players take the field (the first keeps goal); a missing entry plays as standard.
			var member: Dictionary = squad[i] if i < squad.size() and typeof(squad[i]) == TYPE_DICTIONARY else {}
			p.set("team", side)
			p.set("slot", i)
			p.set("number", int(member.get("number", i + 1)))
			p.set("player_name", str(member.get("name", "")))
			for skill in ["pace", "shooting", "tackling"]:
				p.set(skill, clampi(int(member.get(skill, 5)), 1, 10))
			p.set("keeper", i == 0)
			p.call("build", Color(str(t.get("shirt", "#e5484d"))), Color(str(t.get("shorts", "#ffffff"))), Color(str(t.get("keeper", "#f2b84b"))), i + (0 if side == "home" else 2))
			add_child(p)
			players.append(p)


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
		var data = JSON.parse_string(FileAccess.get_file_as_string(path))
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


## Sends a match event to every rule program that handles it. Events raised while rules run wait until
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


# ---- What the rules can do (football_host.gd) ---------------------------------------------------

func add_time(seconds: float) -> void:
	if phase == "ended":
		return
	clock += seconds
	hud.call("set_clock", clock)


func change_score(team: String, amount: int) -> void:
	score[team] = maxi(0, int(score[team]) + amount)
	hud.call("set_score", score["home"], score["away"])


func end_match(text: String) -> void:
	if phase == "ended":
		return
	phase = "ended"
	phase_time = 0.0
	ball.set("holder", null)
	sounds.call("play", "whistle")
	hud.call("show_result", text if text.strip_edges() != "" else default_result())


func default_result() -> String:
	var home: Dictionary = stadium.call("team", "home")
	var away: Dictionary = stadium.call("team", "away")
	return "Full time: %s %d – %d %s" % [str(home.get("name", "Home")), int(score["home"]), int(score["away"]), str(away.get("name", "Away"))]


# ---- The match ----------------------------------------------------------------------------------

static func other(side: String) -> String:
	return "away" if side == "home" else "home"


## Starts the match again from the kick-off with 0 - 0 and a full clock, with you controlling `control`
## ("home", "away" or "" to watch). F9 reloads the scene instead; the self-test uses this to keep running.
func reset_match(control: String) -> void:
	human = control
	score = {"home": 0, "away": 0}
	var m: Dictionary = stadium.get("match_data")
	clock = maxf(float(m.get("minutes", 4.0)), 1.0) * 60.0
	played_seconds = 0.0
	minutes_played = 0
	hud.call("set_score", 0, 0)
	hud.call("set_clock", clock)
	hud.call("hide_result")
	hud.call("set_watching", human == "")
	_set_controlled(null)
	for entry in programs:
		entry["vm"].reset()
	_kickoff("home", false)
	fire("start", {})


func team_players(side: String) -> Array:
	return players.filter(func(p): return p.get("team") == side)


func keeper_of(side: String) -> Node3D:
	for p in players:
		if p.get("team") == side and p.get("keeper") == true:
			return p
	return null


## Where a player lines up for a kick-off.
func spot(p: Node3D) -> Vector3:
	var f: Array = FORMATIONS[team_size][int(p.get("slot"))]
	var hl := float(stadium.get("half_length"))
	var hw := float(stadium.get("half_width"))
	var x := -hl + float(f[0]) * hl
	var z := float(f[1]) * (hw - 2.0)
	if p.get("team") == "away":
		x = -x
		z = -z
	return Vector3(x, 0.0, z)


func _kickoff(team: String, whistle: bool = true) -> void:
	kickoff_team = team
	phase = "kickoff"
	phase_time = 0.0
	ball.call("place", Vector3.ZERO)
	for p in players:
		p.position = spot(p)
		p.set("velocity", Vector3.ZERO)
		p.set("kick_wait", 0.0)
		p.set("tackle_wait", 0.0)
		p.set("stunned", 0.0)
		p.set("think", 0.0)
		p.set("facing", Vector3.RIGHT if p.get("team") == "home" else Vector3.LEFT)
		p.call("move", 0.0, float(stadium.get("half_length")), float(stadium.get("half_width")))
	# The kicking-off side's forward stands at the ball.
	var taker: Node3D = team_players(team).back()
	taker.position = Vector3(-0.5 if team == "home" else 0.5, 0.0, 0.0)
	_set_controlled(null if human == "" else taker if team == human else nearest_to_ball(human, false))
	if whistle:
		sounds.call("play", "whistle")


func _physics_process(delta: float) -> void:
	phase_time += delta
	var hl := float(stadium.get("half_length"))
	var hw := float(stadium.get("half_width"))
	if Input.is_action_just_pressed("toggle_stats"):
		hud.call("toggle_stats")
	if Input.is_action_just_pressed("new_game"):
		get_tree().reload_current_scene()
		return
	match phase:
		"kickoff":
			if phase_time >= KICKOFF_PAUSE:
				phase = "play"
				phase_time = 0.0
			_place_camera(delta)
			return
		"goal", "ended":
			for p in players:
				p.set("velocity", (p.get("velocity") as Vector3).move_toward(Vector3.ZERO, 12.0 * delta))
				p.call("move", delta, hl, hw)
			ball.call("step", delta)
			_place_camera(delta)
			if phase == "goal" and phase_time >= GOAL_PAUSE:
				_kickoff(kickoff_team)
			return
	_tick_clock(delta)
	if phase != "play":
		return
	for p in players:
		for key in ["kick_wait", "tackle_wait", "stunned", "think"]:
			p.set(key, float(p.get(key)) - delta)
	_pass_time -= delta
	if _pass_time <= 0.0 or ball.get("holder") != null:
		pass_target = null
	_human(delta)
	_computer(delta)
	_separate()
	for p in players:
		p.call("move", delta, hl, hw)
	_possession()
	_dribble()
	ball.call("step", delta)
	_place_camera(delta)


func _tick_clock(delta: float) -> void:
	clock -= delta
	played_seconds += delta
	while minutes_played < int(floor(played_seconds / 60.0 + 0.0001)):
		minutes_played += 1
		fire("minute", {"minute": float(minutes_played)})
	if clock > 0.0:
		hud.call("set_clock", clock)
		return
	clock = 0.0
	hud.call("set_clock", clock)
	fire("fullTime", {})
	# Unless a rule added time (or ended the match itself), the final whistle goes.
	if phase != "ended" and clock <= 0.0:
		end_match(default_result())


func _on_goal_crossed(side: String) -> void:
	if phase != "play":
		return
	var team := "home" if side == "right" else "away"
	score[team] = int(score[team]) + 1
	var scorer: Node3D = ball.get("last_touch")
	var number := int(scorer.get("number")) if scorer != null else 0
	var scorer_name := str(scorer.get("player_name")) if scorer != null else ""
	goals.append({"team": team, "scorer": number, "name": scorer_name, "own": scorer != null and scorer.get("team") != team, "clock": snappedf(clock, 0.1)})
	hud.call("set_score", score["home"], score["away"])
	phase = "goal"
	phase_time = 0.0
	kickoff_team = "away" if team == "home" else "home"
	sounds.call("play", "cheer")
	fire("goal", {"team": team, "scorer": float(number), "scorerName": scorer_name})


# ---- You: one footballer at a time --------------------------------------------------------------

func _set_controlled(p: Node3D) -> void:
	if p == controlled:
		return
	if controlled != null:
		controlled.call("set_controlled", false)
	controlled = p
	if p != null:
		p.call("set_controlled", true)
	_switch_wait = 0.5


func _human(delta: float) -> void:
	_switch_wait = maxf(0.0, _switch_wait - delta)
	if human == "":
		return
	var holder: Node3D = ball.get("holder")
	if Input.is_action_just_pressed("switch"):
		var others := team_players(human).filter(func(q): return q != controlled and q.get("keeper") != true)
		others.sort_custom(func(a, b): return _flat(a.position, ball.position) < _flat(b.position, ball.position))
		if not others.is_empty():
			_set_controlled(others[0])
	elif holder != null and holder.get("team") == human and holder != controlled and holder.get("keeper") != true:
		_set_controlled(holder)
	elif _switch_wait <= 0.0 and (holder == null or holder.get("team") != human) and not (pass_target != null and pass_target.get("team") == human):
		var best := nearest_to_ball(human, false)
		if best != null and controlled != null and _flat(best.position, ball.position) + 2.5 < _flat(controlled.position, ball.position):
			_set_controlled(best)
	var p := controlled
	if p == null:
		return
	var input := Input.get_vector("move_left", "move_right", "move_up", "move_down")
	var dir := Vector3(input.x, 0.0, input.y)
	var speed := PLAYER_SPEED * float(p.call("pace_factor")) * (SPRINT if Input.is_action_pressed("sprint") else 1.0)
	p.set("velocity", Vector3.ZERO if float(p.get("stunned")) > 0.0 else dir.limit_length(1.0) * speed)
	if Input.is_action_just_pressed("shoot"):
		human_shoot(dir)
	if Input.is_action_just_pressed("pass"):
		human_pass(dir)


## Space: with the ball (or right next to it), shoot at the goal, toward the corner held with W or S,
## otherwise the side away from the keeper. Facing away from goal, it is a long ball where you face.
func human_shoot(dir: Vector3) -> bool:
	var p := controlled
	if p == null or not (ball.get("holder") == p or (ball.get("holder") == null and _flat(p.position, ball.position) < 1.3 and float(p.get("kick_wait")) <= 0.0)):
		return false
	var goal_x := float(stadium.get("half_length")) * (1.0 if human == "home" else -1.0)
	var gz := float(stadium.get("goal_half")) * 0.65
	var keeper := keeper_of(other(human))
	var aim_z := -gz if dir.z < -0.3 else gz if dir.z > 0.3 else (-gz if keeper != null and keeper.position.z > 0.0 else gz)
	var to := Vector3(goal_x, 0.0, aim_z) - ball.position
	var facing: Vector3 = p.get("facing")
	if facing.dot(to.normalized()) < 0.0:
		to = facing
	kick(p, to, SHOT_SPEED * float(p.call("shot_factor")), 1.2)
	shots += 1
	shots_by[human] = int(shots_by[human]) + 1
	return true


## E: with the ball, pass to the team-mate most in the direction held (or faced); without it, tackle an
## opponent who has the ball close by.
func human_pass(dir: Vector3) -> bool:
	var p := controlled
	if p == null:
		return false
	var holder: Node3D = ball.get("holder")
	if holder == p:
		var target := best_pass(p, dir if dir.length() > 0.2 else p.get("facing"), true)
		if target == null:
			target = best_pass(p, p.get("facing"), false)
		if target != null:
			# You take over the receiver, who then stands still unless you move: no lead on the pass.
			pass_to(p, target, false)
			_set_controlled(target)
			return true
		kick(p, p.get("facing"), 10.0, 0.0)
		return true
	if holder != null and holder.get("team") != p.get("team") and _flat(p.position, holder.position) < 1.5 and float(p.get("tackle_wait")) <= 0.0:
		tackle(p, holder, 0.75 * float(p.call("tackle_factor")))
		return true
	return false


# ---- The computer -------------------------------------------------------------------------------

func _computer(_delta: float) -> void:
	var holder: Node3D = ball.get("holder")
	for side in ["home", "away"]:
		var chaser: Node3D = null
		if holder == null or holder.get("team") != side:
			chaser = nearest_to_ball(side, false, side == human)
			# Your team-mates leave the chasing to you, unless the ball is loose right beside one of them
			# or an opponent carries it close to one (who then presses and tackles).
			if side == human and chaser != null and controlled != null:
				var mine := _flat(chaser.position, ball.position)
				var closer := mine < _flat(controlled.position, ball.position)
				var beside := holder == null and mine < 2.5 and closer
				var press: bool = holder != null and holder.get("team") != side and mine < 3.5 and closer
				if not (beside or press):
					chaser = null
		for p in team_players(side):
			if p == controlled:
				continue
			if float(p.get("stunned")) > 0.0:
				p.set("velocity", Vector3.ZERO)
				continue
			if holder == p:
				_carry(p)
			elif p == pass_target and holder == null:
				_chase(p)
			elif p.get("keeper") == true:
				_keep(p)
			elif p == chaser:
				_chase(p)
			else:
				_support(p)


func nearest_to_ball(side: String, keepers: bool, skip_controlled: bool = false) -> Node3D:
	var best: Node3D = null
	var best_d := INF
	var at: Vector3 = ball.position + (ball.get("velocity") as Vector3) * 0.25
	for p in team_players(side):
		if (not keepers and p.get("keeper") == true) or (skip_controlled and p == controlled):
			continue
		var d := _flat(p.position, at)
		if d < best_d:
			best = p
			best_d = d
	return best


func _chase(p: Node3D) -> void:
	var holder: Node3D = ball.get("holder")
	var target: Vector3 = holder.position + (holder.get("velocity") as Vector3) * 0.2 if holder != null else ball.position + (ball.get("velocity") as Vector3) * 0.25
	_run_to(p, target, float(level["speed"]) * float(p.call("pace_factor")), 0.0)
	if holder != null and holder.get("team") != p.get("team") and _flat(p.position, holder.position) < 1.1 and float(p.get("tackle_wait")) <= 0.0:
		tackle(p, holder, float(level["tackle"]) * float(p.call("tackle_factor")))


## Without the ball: hold a place in the team's shape, which slides with the ball, pushes up when the
## team has it and drops back when it does not.
func _support(p: Node3D) -> void:
	var hl := float(stadium.get("half_length"))
	var hw := float(stadium.get("half_width"))
	var base := spot(p)
	var attack := 1.0 if p.get("team") == "home" else -1.0
	var holder: Node3D = ball.get("holder")
	var ours: bool = holder != null and holder.get("team") == p.get("team")
	var x := base.x * 0.5 + ball.position.x * 0.5 + attack * (5.0 if ours else -2.0)
	var z := base.z + (ball.position.z - base.z) * 0.25
	var target := Vector3(clampf(x, -hl + 2.0, hl - 2.0), 0.0, clampf(z, -hw + 1.5, hw - 1.5))
	_run_to(p, target, float(level["speed"]) * float(p.call("pace_factor")) * 0.85, 0.6)
	if (p.get("velocity") as Vector3).length() < 0.2:
		p.set("facing", (ball.position - p.position) * Vector3(1.0, 0.0, 1.0))


func _keep(p: Node3D) -> void:
	var hl := float(stadium.get("half_length"))
	var goal_half := float(stadium.get("goal_half"))
	var own_x := -hl if p.get("team") == "home" else hl
	var line_x := own_x + (0.9 if own_x < 0.0 else -0.9)
	var target := Vector3(line_x, 0.0, clampf(ball.position.z * 0.45, -goal_half + 0.3, goal_half - 0.3))
	var v: Vector3 = ball.get("velocity")
	var loose: bool = ball.get("holder") == null
	if loose and signf(v.x) == signf(own_x) and absf(v.x) > 2.0:
		# A shot or pass coming at the goal: go to where it crosses the keeper's line.
		var t := (line_x - ball.position.x) / v.x
		if t > 0.0 and t < 1.5:
			target.z = clampf(ball.position.z + v.z * t, -goal_half, goal_half)
	elif loose and absf(ball.position.x - own_x) < 6.0 and absf(ball.position.z) < goal_half + 3.0:
		# A loose ball close to goal: come out and claim it.
		target = ball.position
	_run_to(p, target, float(level["speed"]) * float(p.call("pace_factor")) * 1.05, 0.1)
	p.set("facing", (ball.position - p.position) * Vector3(1.0, 0.0, 1.0))


## With the ball. A keeper waits a moment, then passes out; others shoot when close enough, pass when
## an opponent closes in, and otherwise dribble at goal, stepping round whoever is in the way.
func _carry(p: Node3D) -> void:
	var hl := float(stadium.get("half_length"))
	var attack := 1.0 if p.get("team") == "home" else -1.0
	if p.get("keeper") == true:
		p.set("velocity", Vector3.ZERO)
		if float(p.get("think")) <= 0.0:
			var t := best_pass(p, Vector3(attack, 0.0, 0.0), false)
			if t != null:
				pass_to(p, t)
			else:
				kick(p, Vector3(attack, 0.0, _rng.randf_range(-0.4, 0.4)), 14.0, 2.5)
		return
	var goal := Vector3(attack * hl, 0.0, 0.0)
	if float(p.get("think")) <= 0.0:
		p.set("think", float(level["think"]))
		if _flat(p.position, goal) < 11.0:
			_computer_shot(p)
			return
		if _pressure(p) < 2.2:
			var target := best_pass(p, Vector3(attack, 0.0, 0.0), false)
			if target != null:
				pass_to(p, target)
				return
		p.set("aim", ((goal - p.position).normalized() + _step_round(p) * 0.8).normalized())
	var aim: Vector3 = p.get("aim")
	if aim.length() < 0.1:
		aim = (goal - p.position).normalized()
	p.set("velocity", aim * float(level["speed"]) * float(p.call("pace_factor")) * 0.92)


func _computer_shot(p: Node3D) -> void:
	var attack := 1.0 if p.get("team") == "home" else -1.0
	var keeper := keeper_of("away" if p.get("team") == "home" else "home")
	var gz := float(stadium.get("goal_half")) * 0.6
	var aim_z := -gz if keeper != null and keeper.position.z > 0.0 else gz
	# Better shooters stray less: 1.67 times the level's stray at 1, the level's at 5, a sixth of it at 10.
	var stray := float(level["stray"]) * (11.0 - float(p.get("shooting"))) / 6.0
	aim_z += _rng.randf_range(-stray, stray)
	kick(p, Vector3(attack * float(stadium.get("half_length")), 0.0, aim_z) - ball.position, SHOT_SPEED * 0.92 * float(p.call("shot_factor")), 1.0)
	shots += 1
	shots_by[str(p.get("team"))] = int(shots_by[str(p.get("team"))]) + 1


## The best team-mate to pass to: in the direction given (strict: within about 70 degrees of it), clear
## of opponents along the way and around them, further forward scoring higher. Null when none is fit.
func best_pass(p: Node3D, direction: Vector3, strict: bool) -> Node3D:
	var attack := 1.0 if p.get("team") == "home" else -1.0
	var dir := (direction * Vector3(1.0, 0.0, 1.0)).normalized() if direction.length() > 0.01 else Vector3(attack, 0.0, 0.0)
	var best: Node3D = null
	var best_score := -INF
	for q in team_players(str(p.get("team"))):
		if q == p or q.get("keeper") == true:
			continue
		var to: Vector3 = (q.position - p.position) * Vector3(1.0, 0.0, 1.0)
		var d := to.length()
		if d < 3.0 or d > 24.0:
			continue
		var along := dir.dot(to / d)
		if strict and along < 0.35:
			continue
		var lane := _lane_clearance(p.position, q.position, str(p.get("team")))
		if lane < 0.9:
			continue
		var space := _space_around(q)
		var forward: float = (q.position.x - p.position.x) * attack
		var value: float = along * (3.0 if strict else 1.0) + clampf(space, 0.0, 6.0) * 0.35 + clampf(lane, 0.0, 4.0) * 0.4 + forward * (0.05 if strict else 0.15) - d * 0.03
		if value > best_score:
			best_score = value
			best = q
	return best


## Passes along the ground to a team-mate, ahead of where it is running when `lead` is on.
func pass_to(p: Node3D, target: Node3D, lead: bool = true) -> void:
	var ahead: Vector3 = (target.get("velocity") as Vector3) * 0.35 if lead else Vector3.ZERO
	var to: Vector3 = target.position + ahead - ball.position
	kick(p, to, clampf(5.0 + to.length() * 0.75, 7.0, 13.0), 0.0)
	pass_target = target
	_pass_time = 2.0
	passes += 1
	passes_by[str(p.get("team"))] = int(passes_by[str(p.get("team"))]) + 1


func kick(p: Node3D, direction: Vector3, speed: float, lift: float) -> void:
	ball.call("kick", p, direction, speed, lift)
	p.set("kick_wait", KICK_WAIT)
	p.set("facing", (direction * Vector3(1.0, 0.0, 1.0)).normalized())
	sounds.call("play", "kick")


## A tackle on the player with the ball: won, the tackler takes the ball and the other is left standing
## for a moment; lost, the tackler is.
func tackle(tackler: Node3D, holder: Node3D, chance: float) -> bool:
	tackler.set("tackle_wait", TACKLE_WAIT)
	if _rng.randf() < chance:
		ball.set("holder", tackler)
		ball.set("last_touch", tackler)
		holder.set("stunned", 0.5)
		holder.set("kick_wait", 0.6)
		tackles_won += 1
		if tackler.get("team") == human:
			_set_controlled(tackler)
		return true
	tackler.set("stunned", 0.45)
	return false


## A loose ball near enough, and slow enough, goes to the nearest player who may touch it. A keeper in
## his own area reaches further and catches what is not too fast, pushing faster shots away.
func _possession() -> void:
	if ball.get("holder") != null or str(ball.get("in_goal")) != "" or ball.position.y > 1.3:
		return
	var speed: float = ball.call("speed_on_ground")
	var best: Node3D = null
	var best_d := INF
	for p in players:
		if float(p.get("kick_wait")) > 0.0 or float(p.get("stunned")) > 0.0:
			continue
		var keeping: bool = p.get("keeper") == true and _in_own_area(p)
		var d := _flat(p.position, ball.position)
		var reach := CONTROL_RANGE + (float(level["reach"]) if keeping else 0.0) + (0.35 if p == pass_target else 0.0)
		if d > reach:
			continue
		if keeping and speed > float(level["catch"]):
			# Too hard to hold: pushed away, back out of the goal.
			var v: Vector3 = ball.get("velocity")
			ball.set("velocity", Vector3(-v.x * 0.35, 3.0, v.z * 0.5 + _rng.randf_range(-3.0, 3.0)))
			ball.set("last_touch", p)
			p.set("kick_wait", 0.4)
			saves += 1
			sounds.call("play", "kick")
			return
		if not keeping and speed > CONTROL_SPEED:
			continue
		if d < best_d:
			best = p
			best_d = d
	if best == null:
		return
	if best.get("keeper") == true and ball.get("last_touch") != null and (ball.get("last_touch") as Node3D).get("team") != best.get("team"):
		saves += 1
	ball.set("holder", best)
	ball.set("last_touch", best)
	if best.get("keeper") == true:
		best.set("think", 0.8)
	elif best.get("team") == human:
		_set_controlled(best)


## The ball rolls just ahead of the player who has it, inside the boards (only a kick scores).
func _dribble() -> void:
	var h: Node3D = ball.get("holder")
	if h == null:
		return
	var hl := float(stadium.get("half_length"))
	var hw := float(stadium.get("half_width"))
	var ahead: Vector3 = (h.get("facing") as Vector3) * 0.55
	var r: float = Ball.RADIUS
	ball.position = Vector3(clampf(h.position.x + ahead.x, -hl + r, hl - r), r, clampf(h.position.z + ahead.z, -hw + r, hw - r))
	var v: Vector3 = h.get("velocity")
	ball.set("velocity", Vector3(v.x, 0.0, v.z))


## Players do not stand inside each other.
func _separate() -> void:
	for i in range(players.size()):
		for j in range(i + 1, players.size()):
			var a: Node3D = players[i]
			var b: Node3D = players[j]
			var gap := (b.position - a.position) * Vector3(1.0, 0.0, 1.0)
			var d := gap.length()
			if d < 0.7 and d > 0.0001:
				var push := gap / d * (0.7 - d) * 0.5
				a.position -= push
				b.position += push


func _run_to(p: Node3D, target: Vector3, speed: float, settle: float) -> void:
	var to := (target - p.position) * Vector3(1.0, 0.0, 1.0)
	var d := to.length()
	if d <= settle:
		p.set("velocity", Vector3.ZERO)
		return
	p.set("velocity", to / d * minf(speed, d * 4.0))


## Metres to the nearest opponent ahead (within 100 degrees of where the player faces).
func _pressure(p: Node3D) -> float:
	var nearest := INF
	var facing: Vector3 = p.get("facing")
	for q in players:
		if q.get("team") == p.get("team"):
			continue
		var to: Vector3 = (q.position - p.position) * Vector3(1.0, 0.0, 1.0)
		if to.length() < 0.01 or facing.dot(to.normalized()) > -0.17:
			nearest = minf(nearest, to.length())
	return nearest


## A sideways step away from the nearest opponent in front, so a dribble goes round him.
func _step_round(p: Node3D) -> Vector3:
	var attack := 1.0 if p.get("team") == "home" else -1.0
	var nearest: Node3D = null
	var nearest_d := 3.0
	for q in players:
		if q.get("team") == p.get("team"):
			continue
		var to: Vector3 = (q.position - p.position) * Vector3(1.0, 0.0, 1.0)
		if to.x * attack > 0.0 and to.length() < nearest_d:
			nearest = q
			nearest_d = to.length()
	if nearest == null:
		return Vector3.ZERO
	var side := 1.0 if p.position.z >= nearest.position.z else -1.0
	return Vector3(0.0, 0.0, side)


func _space_around(q: Node3D) -> float:
	var nearest := INF
	for o in players:
		if o.get("team") != q.get("team"):
			nearest = minf(nearest, _flat(o.position, q.position))
	return nearest


## How close the nearest opponent stands to the straight line from a to b.
func _lane_clearance(a: Vector3, b: Vector3, side: String) -> float:
	var ab := (b - a) * Vector3(1.0, 0.0, 1.0)
	var length := ab.length()
	var nearest := INF
	for o in players:
		if o.get("team") == side:
			continue
		var ao: Vector3 = (o.position - a) * Vector3(1.0, 0.0, 1.0)
		var t := clampf(ao.dot(ab) / maxf(length * length, 0.0001), 0.0, 1.0)
		nearest = minf(nearest, (ao - ab * t).length())
	return nearest


func _in_own_area(p: Node3D) -> bool:
	var hl := float(stadium.get("half_length"))
	var own_x := -hl if p.get("team") == "home" else hl
	return absf(p.position.x - own_x) < minf(6.0, hl / 3.0) + 0.5


static func _flat(a: Vector3, b: Vector3) -> float:
	return Vector2(a.x - b.x, a.z - b.z).length()


## The broadcast camera follows the ball along the touchline.
func _place_camera(delta: float, snap: bool = false) -> void:
	var hl := float(stadium.get("half_length"))
	var hw := float(stadium.get("half_width"))
	var reach := maxf(hl - 9.0, 0.0)
	# Aimed a little toward the near touchline, high enough to see both touchlines and the far stand.
	var look := Vector3(clampf(ball.position.x, -reach, reach), 0.0, ball.position.z * 0.2 + 1.0)
	var want := look + Vector3(0.0, 11.0 + hw * 0.55, hw + 10.0)
	camera.position = want if snap else camera.position.lerp(want, clampf(delta * 3.0, 0.0, 1.0))
	camera.look_at(look, Vector3.UP)


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
		"player": [snappedf(controlled.position.x, 0.01), snappedf(controlled.position.y, 0.01), snappedf(controlled.position.z, 0.01)] if controlled != null else [],
		"ball": [snappedf(ball.position.x, 0.01), snappedf(ball.position.z, 0.01)],
		"score": [score["home"], score["away"]],
		"clock": snappedf(clock, 0.1),
	}
	hud.call("update_stats", stats)
	_emit(stats)


func _emit(data: Dictionary) -> void:
	if telemetry:
		print("GSTUDIO " + JSON.stringify(data))

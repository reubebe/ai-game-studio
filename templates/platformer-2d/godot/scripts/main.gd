extends Node2D
## Wires the level, player, camera, HUD and the compiled rule programs together.
##
## Command-line options (after "--"):
##   --studio-telemetry   print one JSON line per rule run and twice a second for performance
##   --studio-smoke       run the headless self-test and quit (see smoke_test.gd)
## Progress (coins, checkpoints, the gate, where you stand) is saved as you play and restored on the
## next start (see progress.gd); F9 starts over.

const RulesVM := preload("res://addons/gamestudio_runtime/rules_vm.gd")
const PlatformerHost := preload("res://scripts/platformer_host.gd")
const LevelBuilder := preload("res://scripts/level_builder.gd")
const Player := preload("res://scripts/player.gd")
const Hud := preload("res://scripts/hud.gd")
const Background := preload("res://scripts/background.gd")
const SoundBank := preload("res://scripts/sound_bank.gd")
const InputSetup := preload("res://scripts/input_setup.gd")
const SmokeTest := preload("res://scripts/smoke_test.gd")
const Progress := preload("res://scripts/progress.gd")
const RULES_INDEX := "res://gamestudio_data/rules_index.json"
const TILE := 32.0
const AUTOSAVE_SECONDS := 4.0

var level: Node2D
var player: CharacterBody2D
var hud: CanvasLayer
var sounds: Node
var host: RefCounted
var programs: Array = []
var rule_errors: Array = []
var telemetry := false
var keep_progress := false
var last_hurt := ""
var _stats_time := 0.0
var _level_id := ""
var _level_text := ""
var _save_time := 0.0
var _save_soon := false
var _saved_at := Vector2.ZERO
var _hurt_cooldown := 0.0


func _ready() -> void:
	InputSetup.ensure_actions()
	var args := OS.get_cmdline_user_args()
	telemetry = args.has("--studio-telemetry")
	sounds = SoundBank.new()
	sounds.name = "Sounds"
	add_child(sounds)
	hud = Hud.new()
	hud.name = "HUD"
	add_child(hud)
	level = LevelBuilder.new()
	level.name = "Level"
	add_child(level)
	player = Player.new()
	player.name = "Player"
	level.player = player
	level.build()
	sounds.call("configure", (level.get("level") as Dictionary).get("audio", {}))
	var background := Background.new()
	background.name = "Background"
	background.setup(level.get("level").get("background", {}))
	add_child(background)
	move_child(background, 0)
	var size: Vector2 = level.call("size_tiles")
	var hills := background.make_hills(size.x * TILE)
	hills.position = Vector2(0, -size.y * TILE * 0.35)
	add_child(hills)
	move_child(hills, 1)
	add_child(player)
	player.configure(level.call("player_settings"))
	player.respawn(level.call("respawn_point"))
	var camera := Camera2D.new()
	camera.limit_left = 0
	camera.limit_right = int(size.x * TILE)
	camera.limit_top = int(-size.y * TILE)
	camera.limit_bottom = 0
	camera.position_smoothing_enabled = true
	camera.position_smoothing_speed = 7.0
	camera.position = Vector2(0, -2 * TILE)
	player.add_child(camera)

	var world_error := str(level.get("load_error"))
	if world_error != "":
		hud.call("show_error", "Level data problem: %s" % world_error)
	level.connect("coin_collected", _on_coin_collected)
	level.connect("checkpoint_reached", _on_checkpoint)
	level.connect("goal_reached", _on_goal)
	level.connect("hazard", hurt)
	level.connect("enemy_stomped", _on_stomped)
	level.connect("sign_touched", _on_sign)
	player.connect("jumped", func() -> void: sounds.call("play", "jump"))
	host = PlatformerHost.new(level, hud, sounds)
	_load_programs()
	var ids: Array = []
	for entry in programs:
		ids.append(entry["id"])
	_emit({"type": "ready", "programs": ids, "worldError": world_error, "ruleErrors": rule_errors})
	fire("start", {})
	_update_coins()
	if args.has("--studio-smoke"):
		var smoke := SmokeTest.new()
		smoke.name = "SmokeTest"
		add_child(smoke)
		smoke.call("run", self)
	else:
		keep_progress = true
		_restore_progress()
		_save_progress()


func _load_programs() -> void:
	programs.clear()
	_level_text = FileAccess.get_file_as_string(LevelBuilder.LEVEL_PATH)
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
		_level_text += raw
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


## Sends a game event to every rule program that handles it.
func fire(event: String, payload: Dictionary) -> void:
	_save_soon = keep_progress
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


func _update_coins() -> void:
	hud.call("set_coins", level.call("collected_count", "coin"), level.call("total_count", "coin"))


func _on_coin_collected(item_id: String, kind: String) -> void:
	_update_coins()
	fire("collect", {"itemId": item_id, "kind": kind})


func _on_checkpoint(checkpoint_id: String) -> void:
	fire("checkpoint", {"checkpointId": checkpoint_id})


func _on_goal(goal_id: String) -> void:
	fire("goal", {"goalId": goal_id})


func _on_stomped(enemy_id: String) -> void:
	fire("stomp", {"enemyId": enemy_id})


func _on_sign(text: String) -> void:
	hud.call("show_message", text, 5.0)


## Sends the player back to the last checkpoint and tells the rules.
func hurt(cause: String) -> void:
	if _hurt_cooldown > 0.0 or hud.get("won") == true:
		return
	_hurt_cooldown = 0.4
	last_hurt = cause
	host.set("hurts", int(host.get("hurts")) + 1)
	player.respawn(level.call("respawn_point"))
	fire("hurt", {"cause": cause})


func _physics_process(delta: float) -> void:
	_hurt_cooldown = maxf(0.0, _hurt_cooldown - delta)
	if player.global_position.y > 4.0 * TILE:
		hurt("fall")


func _process(delta: float) -> void:
	if Input.is_action_just_pressed("toggle_stats"):
		hud.call("toggle_stats")
	if keep_progress:
		if Input.is_action_just_pressed("new_game"):
			_start_over()
			return
		_save_time += delta
		var moved := player.global_position.distance_to(_saved_at) > TILE
		if (_save_soon and _save_time >= 0.5) or (moved and _save_time >= AUTOSAVE_SECONDS):
			_save_progress()
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
		"player": [snappedf(player.global_position.x / TILE, 0.01), snappedf(-player.global_position.y / TILE, 0.01), 0.0],
	}
	hud.call("update_stats", stats)
	_emit(stats)


func _notification(what: int) -> void:
	if what == NOTIFICATION_WM_CLOSE_REQUEST:
		_save_progress()


# ---- Progress (see progress.gd) ----------------------------------------------------------

func _level_fingerprint() -> String:
	if _level_id == "":
		_level_id = _level_text.md5_text()
	return _level_id


func _progress_state() -> Dictionary:
	var rules := {}
	for entry in programs:
		rules[entry["id"]] = entry["vm"].variables
	var hidden: Array = []
	var nodes: Dictionary = level.get("nodes")
	var collected: Dictionary = level.get("collected")
	var stomped: Dictionary = level.get("stomped")
	for id in nodes:
		if not (nodes[id] as Node2D).visible and not collected.has(id) and not stomped.has(id):
			hidden.append(id)
	var p := player.global_position
	return {
		"level": _level_fingerprint(),
		"player": [snappedf(p.x, 0.1), snappedf(p.y, 0.1)],
		"collected": collected,
		"checkpoints": (level.get("reached") as Dictionary).keys(),
		"stomped": stomped.keys(),
		"doors": (level.get("doors_open") as Dictionary).keys(),
		"hidden": hidden,
		"hurts": host.get("hurts"),
		"objective": str(hud.get("objective")),
		"rules": rules,
	}


func _save_progress() -> void:
	if not keep_progress:
		return
	_save_soon = false
	_save_time = 0.0
	_saved_at = player.global_position
	if not Progress.write(_progress_state()):
		push_warning("Could not save progress to %s" % Progress.PATH)


func _restore_progress() -> void:
	var saved := Progress.read()
	if saved.is_empty():
		_emit({"type": "progress", "restored": false})
		return
	if str(saved.get("level", "")) != _level_fingerprint():
		hud.call("show_message", "The level has changed since you last played, so you start from the beginning.", 5.0)
		_emit({"type": "progress", "restored": false, "reason": "level changed"})
		return
	for item_id in saved.get("collected", {}):
		level.call("collect_item", str(item_id), false)
	for checkpoint_id in saved.get("checkpoints", []):
		level.call("restore_checkpoint", str(checkpoint_id))
	for enemy_id in saved.get("stomped", []):
		level.call("stomp", str(enemy_id), false)
	for door_id in saved.get("doors", []):
		level.call("open_door", str(door_id), true)
	for object_id in saved.get("hidden", []):
		level.call("set_object_visible", str(object_id), false)
	host.set("hurts", int(saved.get("hurts", 0)))
	var rules = saved.get("rules", {})
	if typeof(rules) == TYPE_DICTIONARY:
		for entry in programs:
			if typeof(rules.get(entry["id"])) == TYPE_DICTIONARY:
				entry["vm"].variables = (rules[entry["id"]] as Dictionary).duplicate(true)
	hud.call("set_objective", str(saved.get("objective", hud.get("objective"))))
	var at = saved.get("player", [])
	if typeof(at) == TYPE_ARRAY and at.size() == 2:
		player.respawn(Vector2(float(at[0]), float(at[1])))
	_update_coins()
	hud.call("clear_messages")
	hud.call("show_message", "Welcome back. You carry on where you stopped; press F9 to start over.", 5.0)
	_emit({"type": "progress", "restored": true, "collected": (level.get("collected") as Dictionary).size(), "player": at})


func _start_over() -> void:
	keep_progress = false
	Progress.clear()
	get_tree().reload_current_scene()


func _emit(data: Dictionary) -> void:
	if telemetry:
		print("GSTUDIO " + JSON.stringify(data))

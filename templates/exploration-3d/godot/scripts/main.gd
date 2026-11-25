extends Node3D
## Wires the level, player, HUD and the compiled rule programs together.
##
## Command-line options (after "--"):
##   --studio-telemetry   print one JSON line per rule run and twice a second for performance
##   --studio-smoke       run the headless self-test and quit (see smoke_test.gd)
## Progress is saved as you play and restored on the next start (see progress.gd); F9 starts over.

const RulesVM := preload("res://addons/gamestudio_runtime/rules_vm.gd")
const ExploreHost := preload("res://scripts/explore_host.gd")
const SoundBank := preload("res://scripts/sound_bank.gd")
const InputSetup := preload("res://scripts/input_setup.gd")
const SmokeTest := preload("res://scripts/smoke_test.gd")
const Progress := preload("res://scripts/progress.gd")
const WorldBuilder := preload("res://scripts/world_builder.gd")
const ChatBridge := preload("res://scripts/chat_bridge.gd")
const RULES_INDEX := "res://gamestudio_data/rules_index.json"
const AUTOSAVE_SECONDS := 4.0
## Events one event may lead to before the rest wait for the next frame (a rule that hurts the player
## from On Player Defeated would otherwise never stop).
const MAX_CHAINED_EVENTS := 32

@onready var world: Node3D = $World
@onready var player: CharacterBody3D = $Player
@onready var hud: CanvasLayer = $HUD

var programs: Array = []
var rule_errors: Array = []
var host: RefCounted
var sounds: Node
var telemetry := false
var keep_progress := false
var _stats_time := 0.0
## Identifies the level and its rules; a save made with other ones is not restored.
var _level_id := ""
var _level_text := ""
var _save_time := 0.0
var _save_soon := false
var _saved_at := Vector3.ZERO
## Events raised while a rule runs (the rules VM runs one handler at a time); fired right after it.
var _firing := false
var _queued: Array = []
## Running timers: id -> {"left", "seconds", "repeat", "countdown"}; and every timer that ran out, in order.
var timers: Dictionary = {}
var timers_fired: Array = []
var _countdown_text := ""
## Conversations with villagers who answer with AI (inside Game Studio): the bridge, who is being
## talked to, the question waiting for its answer, and every exchange (for the self-test).
var chat: Object
var chats: Array = []
var _chat_npc := ""
var _chat_request := -1
var _chat_question := ""


func _ready() -> void:
	InputSetup.ensure_actions()
	var args := OS.get_cmdline_user_args()
	telemetry = args.has("--studio-telemetry")
	sounds = SoundBank.new()
	sounds.name = "Sounds"
	add_child(sounds)
	sounds.call("configure", (world.get("world") as Dictionary).get("audio", {}))
	var world_error := str(world.get("load_error"))
	if world_error != "":
		hud.call("show_error", "Level data problem: %s" % world_error)
	player.call("configure", world.call("player_settings"))
	world.call("apply_style", player)
	world.connect("item_collected", _on_item_collected)
	world.connect("zone_entered", _on_zone_entered)
	world.connect("enemy_defeated", _on_enemy_defeated)
	world.connect("block_entered_zone", _on_block_entered_zone)
	player.connect("interact_requested", _on_interact_requested)
	player.connect("focus_changed", _on_focus_changed)
	player.connect("hurt", _on_player_hurt)
	player.connect("defeated", _on_player_defeated)
	player.connect("health_changed", _on_health_changed)
	player.connect("swung", _on_swung)
	var fighting: bool = not (world.call("object_ids_of_type", "enemy") as Array).is_empty()
	hud.call("set_fight_controls", fighting)
	# Hearts show from the start where enemies or a set health make them matter; otherwise from the first change.
	if fighting or (world.call("player_settings") as Dictionary).has("health"):
		hud.call("set_health", int(player.get("health")), int(player.get("max_health")))
	host = ExploreHost.new(world, hud, sounds, self)
	use_chat(ChatBridge.new())
	hud.connect("chat_submitted", _on_chat_submitted)
	hud.connect("chat_closed", _on_chat_closed)
	_load_programs()
	var ids: Array = []
	for entry in programs:
		ids.append(entry["id"])
	var grass_tufts: int = 0 if world.get("grass") == null else int((world.get("grass") as Node).get("tufts"))
	_emit({"type": "ready", "programs": ids, "worldError": world_error, "ruleErrors": rule_errors, "modelsUsed": (world.get("models_used") as Dictionary).size(), "modelErrors": world.get("model_errors"), "grassTufts": grass_tufts, "drawnShadows": world.get("drawn_shadows") != null})
	fire("start", {})
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
	_level_text = FileAccess.get_file_as_string(WorldBuilder.WORLD_PATH)
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


## Sends a game event to every rule program that handles it. Events raised while rules run (a Hurt
## Player that takes the last heart) wait until the running one has finished.
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


func _on_item_collected(item_id: String, kind: String) -> void:
	fire("collect", {"itemId": item_id, "kind": kind})


func _on_enemy_defeated(enemy_id: String, kind: String) -> void:
	sounds.call("play", "defeat")
	fire("enemyDefeated", {"enemyId": enemy_id, "kind": kind})


func _on_block_entered_zone(block_id: String, zone_id: String) -> void:
	fire("blockInZone", {"blockId": block_id, "zoneId": zone_id})


func _on_player_hurt(source_id: String, _amount: int) -> void:
	sounds.call("play", "hurt")
	hud.call("flash_hurt")
	fire("playerHurt", {"sourceId": source_id})


## The player is back at the spawn point with full hearts. Without a rule for it, say what happened.
func _on_player_defeated(source_id: String) -> void:
	var handled := false
	for entry in programs:
		handled = handled or entry["vm"].has_handler("playerDefeated")
	if not handled:
		hud.call("show_message", "You ran out of hearts and start again at the beginning.", 4.0)
	fire("playerDefeated", {"sourceId": source_id})


func _on_health_changed(health: int, max_health: int) -> void:
	hud.call("set_health", health, max_health)
	_save_soon = keep_progress


func _on_swung(hit_ids: Array) -> void:
	sounds.call("play", "hit" if not hit_ids.is_empty() else "swing")
	_emit({"type": "swing", "hits": hit_ids})


# ---- Timers (Start Timer, Stop Timer, Time Left, On Timer) --------------------------------------

func start_timer(timer_id: String, seconds: float, repeat: bool, countdown: String) -> void:
	timers[timer_id] = {"left": seconds, "seconds": seconds, "repeat": repeat, "countdown": countdown}
	_show_countdowns()
	_save_soon = keep_progress


func stop_timer(timer_id: String) -> void:
	if timers.erase(timer_id):
		_show_countdowns()
		_save_soon = keep_progress


func time_left(timer_id: String) -> float:
	return float((timers.get(timer_id, {}) as Dictionary).get("left", 0.0))


## Moves every running timer on by `seconds`; those that reach zero run On Timer (the self-test also
## calls this to skip ahead).
func advance_timers(seconds: float) -> void:
	if timers.is_empty():
		return
	if hud.get("won") == true:
		timers.clear()
		_show_countdowns()
		return
	var done: Array = []
	for timer_id in timers.keys():
		var t: Dictionary = timers[timer_id]
		t["left"] = float(t["left"]) - seconds
		if float(t["left"]) <= 0.0:
			done.append(timer_id)
			if bool(t["repeat"]):
				t["left"] = maxf(float(t["left"]) + float(t["seconds"]), 0.05)
			else:
				timers.erase(timer_id)
	_show_countdowns()
	for timer_id in done:
		timers_fired.append(timer_id)
		fire("timer", {"timerId": timer_id})


func _show_countdowns() -> void:
	var lines: Array = []
	for timer_id in timers:
		var t: Dictionary = timers[timer_id]
		if str(t["countdown"]) == "":
			continue
		var whole := int(ceil(maxf(float(t["left"]), 0.0)))
		lines.append("%s %d:%02d" % [str(t["countdown"]), whole / 60, whole % 60])
	var text := "\n".join(PackedStringArray(lines))
	if text != _countdown_text:
		_countdown_text = text
		hud.call("set_countdowns", lines)


func _on_zone_entered(zone_id: String) -> void:
	fire("enterZone", {"zoneId": zone_id})


func _on_interact_requested(target_id: String) -> void:
	var lookup: Dictionary = world.get("nodes")
	var target = lookup.get(target_id)
	if target != null and target.has_meta("sign_text"):
		hud.call("show_message", str(target.get_meta("sign_text")), 6.0)
	fire("interact", {"targetId": target_id})
	# A villager with a persona also takes typed questions, when Game Studio is there to answer.
	if not villager_ai(target_id).is_empty() and bool(chat.call("available")):
		open_chat(target_id)


func _on_focus_changed(prompt: String) -> void:
	var target: Node3D = player.get("focus")
	var id := str(target.get_meta("target_id", "")) if target != null else ""
	if prompt != "" and not villager_ai(id).is_empty() and bool(chat.call("available")):
		prompt += " (and ask anything)"
	hud.call("set_prompt", prompt)


# ---- Villagers who answer with AI (chat_bridge.gd) ---------------------------------------------

## Connects a chat bridge (the self-test hands in a stand-in that answers without Game Studio).
func use_chat(bridge: Object) -> void:
	if chat != null and chat.is_connected("answered", _on_chat_answered):
		chat.disconnect("answered", _on_chat_answered)
		chat.disconnect("test_question", _on_chat_test)
	chat = bridge
	chat.connect("answered", _on_chat_answered)
	chat.connect("test_question", _on_chat_test)


## The villager's persona and knowledge from the level ({} for villagers without one).
func villager_ai(id: String) -> Dictionary:
	if id == "":
		return {}
	for o in (world.get("world") as Dictionary).get("objects", []):
		if typeof(o) == TYPE_DICTIONARY and str(o.get("id", "")) == id and str(o.get("type", "")) == "npc" and typeof(o.get("ai")) == TYPE_DICTIONARY:
			return o["ai"]
	return {}


func _villager_name(id: String) -> String:
	for o in (world.get("world") as Dictionary).get("objects", []):
		if typeof(o) == TYPE_DICTIONARY and str(o.get("id", "")) == id:
			return str(o.get("name", id))
	return id


func open_chat(npc_id: String) -> void:
	_chat_npc = npc_id
	player.set("controls_enabled", false)
	if Input.mouse_mode == Input.MOUSE_MODE_CAPTURED:
		Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
	hud.call("open_chat", _villager_name(npc_id))


func _on_chat_submitted(question: String) -> void:
	var history: Array = hud.call("chat_history")
	# The question itself is the last line; the history is what came before it.
	history = history.slice(0, maxi(history.size() - 1, 0))
	_chat_question = question
	_chat_request = int(chat.call("ask", _chat_npc, question, history))


func _on_chat_answered(request_id: int, text: String, error: String) -> void:
	if request_id != _chat_request:
		return
	_chat_request = -1
	var who := _villager_name(_chat_npc)
	var shown := text if error == "" else "(%s does not answer: %s)" % [who, error]
	if bool(hud.get("chat_open")):
		hud.call("add_chat_line", "npc", shown)
	var entry := {"npc": _chat_npc, "question": _chat_question, "answer": text, "error": error}
	chats.append(entry)
	_emit({"type": "chat", "npc": _chat_npc, "question": _chat_question, "answer": text, "error": error})


func _on_chat_closed() -> void:
	player.set("controls_enabled", true)
	_chat_npc = ""


## Game Studio's self-test: a question to a villager, as if the player had walked up and typed it.
func _on_chat_test(npc_id: String, question: String) -> void:
	if villager_ai(npc_id).is_empty() or question.strip_edges() == "":
		return
	open_chat(npc_id)
	hud.call("submit_chat", question.strip_edges())


func _process(delta: float) -> void:
	if Input.is_action_just_pressed("toggle_stats"):
		hud.call("toggle_stats")
	advance_timers(delta)
	if keep_progress:
		if Input.is_action_just_pressed("new_game"):
			_start_over()
			return
		_save_time += delta
		var moved := player.global_position.distance_to(_saved_at) > 0.5
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
		"player": [snappedf(player.global_position.x, 0.01), snappedf(player.global_position.y, 0.01), snappedf(player.global_position.z, 0.01)],
		"look": [snappedf(float(player.get("yaw")), 0.001), snappedf(float(player.get("pitch")), 0.001)],
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
	var nodes: Dictionary = world.get("nodes")
	var collected: Dictionary = world.get("collected")
	var gates: Array = []
	var hidden: Array = []
	for id in nodes:
		var node: Node3D = nodes[id]
		if node.get("is_open") == true:
			gates.append(id)
		if not node.visible and not collected.has(id):
			hidden.append(id)
	var rules := {}
	for entry in programs:
		rules[entry["id"]] = entry["vm"].variables
	var p := player.global_position
	var blocks := {}
	var placed: Dictionary = world.call("block_positions")
	for id in placed:
		var at: Vector3 = placed[id]
		blocks[id] = [snappedf(at.x, 0.01), snappedf(at.y, 0.01), snappedf(at.z, 0.01)]
	var defeated: Array = (world.get("defeated") as Dictionary).keys()
	for id in defeated:
		hidden.erase(id)
	return {
		"level": _level_fingerprint(),
		"player": [snappedf(p.x, 0.01), snappedf(p.y, 0.01), snappedf(p.z, 0.01)],
		"yaw": snappedf(float(player.get("yaw")), 0.001),
		"pitch": snappedf(float(player.get("pitch")), 0.001),
		"collected": collected,
		"gates": gates,
		"hidden": hidden,
		"objective": str(hud.get("objective")),
		"rules": rules,
		"health": int(player.get("health")),
		"defeated": defeated,
		"blocks": blocks,
		"timers": timers.duplicate(true),
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
		world.call("restore_collected", str(item_id))
	for gate_id in saved.get("gates", []):
		world.call("open_gate_now", str(gate_id))
	for object_id in saved.get("hidden", []):
		world.call("set_object_visible", str(object_id), false)
	var rules = saved.get("rules", {})
	if typeof(rules) == TYPE_DICTIONARY:
		for entry in programs:
			if typeof(rules.get(entry["id"])) == TYPE_DICTIONARY:
				entry["vm"].variables = (rules[entry["id"]] as Dictionary).duplicate(true)
	hud.call("set_objective", str(saved.get("objective", hud.get("objective"))))
	for enemy_id in saved.get("defeated", []):
		world.call("restore_defeated", str(enemy_id))
	var blocks = saved.get("blocks", {})
	if typeof(blocks) == TYPE_DICTIONARY:
		for block_id in blocks:
			var spot = blocks[block_id]
			if typeof(spot) == TYPE_ARRAY and (spot as Array).size() == 3:
				world.call("place_block", str(block_id), Vector3(float(spot[0]), float(spot[1]), float(spot[2])))
	if saved.has("health"):
		player.call("set_health", int(saved.get("health", 3)))
	var saved_timers = saved.get("timers", {})
	if typeof(saved_timers) == TYPE_DICTIONARY:
		for timer_id in saved_timers:
			var t = saved_timers[timer_id]
			if typeof(t) == TYPE_DICTIONARY and float(t.get("left", 0.0)) > 0.0:
				start_timer(str(timer_id), float(t.get("seconds", t["left"])), bool(t.get("repeat", false)), str(t.get("countdown", "")))
				timers[str(timer_id)]["left"] = float(t["left"])
		_show_countdowns()
	var at = saved.get("player", [])
	if typeof(at) == TYPE_ARRAY and at.size() == 3:
		player.global_position = Vector3(float(at[0]), float(at[1]), float(at[2]))
	player.set("yaw", float(saved.get("yaw", 0.0)))
	player.set("pitch", float(saved.get("pitch", -0.32)))
	hud.call("clear_messages")
	hud.call("show_message", "Welcome back. You carry on where you stopped; press F9 to start over.", 5.0)
	_emit({"type": "progress", "restored": true, "collected": (world.get("collected") as Dictionary).size(), "player": at})


func _start_over() -> void:
	keep_progress = false
	Progress.clear()
	get_tree().reload_current_scene()


func _emit(data: Dictionary) -> void:
	if telemetry:
		print("GSTUDIO " + JSON.stringify(data))

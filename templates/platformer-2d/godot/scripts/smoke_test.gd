extends Node
## Headless self-test:
##   godot --headless --path <project> -- --studio-smoke
## Checks loading, running, jumping, coins, checkpoints, hazards, stomping, the gate and the goal, then
## prints one line starting with GSTUDIO_SMOKE (JSON) and quits with 0 on success or 1 on failure.
## Level-specific outcomes are reported under "observations" for the caller to judge.

const TILE := 32.0

var checks: Array = []
var failed := false


func _check(check_name: String, ok: bool, detail: String = "") -> void:
	checks.append({"name": check_name, "ok": ok, "detail": detail})
	if not ok:
		failed = true


func _frames(count: int) -> void:
	for i in range(count):
		await get_tree().physics_frame


func _put(player: CharacterBody2D, at: Vector2) -> void:
	player.global_position = at
	player.velocity = Vector2.ZERO


func run(main: Node) -> void:
	var level: Node = main.get("level")
	var player: CharacterBody2D = main.get("player")
	var hud: Node = main.get("hud")
	var host: RefCounted = main.get("host")
	await _frames(20)
	_check("level data loads", str(level.get("load_error")) == "", str(level.get("load_error")))
	var programs: Array = main.get("programs")
	_check("rule programs load", programs.size() > 0, "%d program(s)" % programs.size())
	_check("start rules set an objective", str(hud.get("objective")) != "", str(hud.get("objective")))

	await _frames(40)
	_check("player lands on the ground", player.is_on_floor(), "y = %.2f tiles" % (-player.global_position.y / TILE))

	var start := player.global_position
	var standing := str(player.get("anim_state"))
	player.set("scripted_dir", 1.0)
	await _frames(30)
	var running := str(player.get("anim_state"))
	var sprite_facing_right := player.get("sprite") != null and not (player.get("sprite") as AnimatedSprite2D).flip_h
	await _frames(15)
	player.set("scripted_dir", 0.0)
	await _frames(15)
	var ran := (player.global_position.x - start.x) / TILE
	_check("player runs right", ran > 3.0, "%.2f tiles" % ran)
	if player.get("sprite") != null or str(player.get("sprite_error")) != "":
		_check("the player's sprite sheet loads", player.get("sprite") != null, str(player.get("sprite_error")))
		_check("the player's sprite stands idle, runs while moving and faces the way it runs", standing == "idle" and running == "run" and sprite_facing_right and str(player.get("anim_state")) == "idle", "standing %s, running %s (facing right %s), now %s" % [standing, running, sprite_facing_right, str(player.get("anim_state"))])

	var ground_y := player.global_position.y
	player.set("scripted_hold", true)
	player.set("scripted_jump", true)
	var peak := ground_y
	for i in range(50):
		await get_tree().physics_frame
		peak = minf(peak, player.global_position.y)
	player.set("scripted_hold", false)
	var airborne_state := str(player.get("anim_state"))
	var rise := (ground_y - peak) / TILE
	var expected := float((level.call("player_settings") as Dictionary).get("jumpHeight", 4))
	_check("holding jump reaches the level's jump height", absf(rise - expected) < 0.35, "%.2f tiles (level says %.1f)" % [rise, expected])
	await _frames(40)

	var coins: Array = level.call("object_ids_of_type", "coin")
	var nodes: Dictionary = level.get("nodes")
	if coins.size() > 0:
		var coin: Node2D = nodes[coins[0]]
		_put(player, coin.global_position + Vector2(0, 16))
		await _frames(6)
		_check("touching a coin collects it", (level.get("collected") as Dictionary).has(coins[0]), str(coins[0]))

	var checkpoints: Array = level.call("object_ids_of_type", "checkpoint")
	if checkpoints.size() > 0:
		var flag: Node2D = nodes[checkpoints[0]]
		_put(player, flag.global_position + Vector2(0, -2))
		await _frames(8)
		_check("touching a checkpoint flag activates it", (level.get("reached") as Dictionary).has(checkpoints[0]), str(checkpoints[0]))

	var spikes: Array = level.call("object_ids_of_type", "spike")
	if spikes.size() > 0:
		var spike: Node2D = nodes[spikes[0]]
		_put(player, spike.global_position + Vector2(TILE, -4))
		await _frames(8)
		var back := player.global_position.distance_to(level.call("respawn_point")) < TILE * 1.5
		_check("spikes send the player back to the last checkpoint", str(main.get("last_hurt")) == "spike" and back, "cause %s, %.1f tiles from the checkpoint" % [str(main.get("last_hurt")), player.global_position.distance_to(level.call("respawn_point")) / TILE])
		await _frames(30)

	_put(player, Vector2(player.global_position.x, 6.0 * TILE))
	await _frames(4)
	_check("falling off the level sends the player back", str(main.get("last_hurt")) == "fall" and player.global_position.y < 0.0, "cause %s" % str(main.get("last_hurt")))
	await _frames(30)

	var enemies: Array = level.call("object_ids_of_type", "enemy")
	if enemies.size() > 0:
		var beetle: Node2D = nodes[enemies[0]]
		_put(player, beetle.global_position + Vector2(0, -2.2 * TILE))
		player.velocity = Vector2(0, 300)
		for i in range(30):
			await get_tree().physics_frame
			_put(player, Vector2(beetle.global_position.x, player.global_position.y))
			player.velocity = Vector2(0, 300)
			if (level.get("stomped") as Dictionary).has(enemies[0]):
				break
		_check("jumping on an enemy stomps it", (level.get("stomped") as Dictionary).has(enemies[0]), str(enemies[0]))
		await _frames(10)

	for coin_id in coins:
		level.call("collect_item", coin_id)
	await _frames(5)
	_check("every coin can be collected", (level.get("collected") as Dictionary).size() == coins.size(), "%d of %d" % [(level.get("collected") as Dictionary).size(), coins.size()])

	var goals: Array = level.call("object_ids_of_type", "goal")
	if goals.size() > 0:
		_put(player, (nodes[goals[0]] as Node2D).global_position + Vector2(0, -2))
		await _frames(10)

	_check("rules run without errors", (main.get("rule_errors") as Array).is_empty(), "; ".join(PackedStringArray(main.get("rule_errors"))))
	var doors := {}
	for door_id in level.call("object_ids_of_type", "door"):
		doors[door_id] = level.call("is_door_open", door_id)
	var sounds: Node = main.get("sounds")
	# The level's own sounds: imported files load, replaced sounds play from them, the music loops.
	var pictured: Array = level.get("textured_platforms")
	var picture_errors: Dictionary = level.get("texture_errors")
	if not pictured.is_empty() or not picture_errors.is_empty():
		_check("platform pictures load", picture_errors.is_empty(), "%d textured; %s" % [pictured.size(), JSON.stringify(picture_errors)])
	var level_audio = (main.get("level").get("level") as Dictionary).get("audio", {})
	if typeof(level_audio) == TYPE_DICTIONARY and not (level_audio as Dictionary).is_empty():
		var errors: Dictionary = sounds.get("audio_errors")
		_check("the level's imported sounds load", errors.is_empty(), JSON.stringify(errors))
		if (level_audio as Dictionary).has("music"):
			_check("the level's music plays", bool(sounds.call("music_playing")), str((level_audio as Dictionary)["music"]))
		var replaced: Array = ((level_audio as Dictionary).get("sounds", {}) as Dictionary).keys()
		var heard: Array = (sounds.get("played") as Array).filter(func(c): return replaced.has(c))
		if not heard.is_empty():
			_check("replaced sounds play from their files", (sounds.get("played_files") as Array).size() >= heard.size(), "played %s, from files %s" % [JSON.stringify(heard), JSON.stringify(sounds.get("played_files"))])
	var observations := {
		"objective": hud.get("objective"),
		"won": hud.get("won"),
		"messages": hud.get("messages_shown"),
		"doorsOpen": doors,
		"sounds": sounds.get("played"),
		"soundFiles": sounds.get("played_files"),
		"music": sounds.call("music_playing"),
		"hurts": host.get("hurts"),
		"coins": coins.size(),
		"stomped": (level.get("stomped") as Dictionary).keys(),
		"texturedPlatforms": level.get("textured_platforms"),
	}
	print("GSTUDIO_SMOKE " + JSON.stringify({"pass": not failed, "checks": checks, "observations": observations}))
	# The audio server lets go of a stopped sound a few mixes later; quitting sooner leaks its playback.
	sounds.call("stop_all")
	await _frames(30)
	get_tree().quit(1 if failed else 0)

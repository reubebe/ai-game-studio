extends Node
## Headless self-test:
##   godot --headless --path <project> -- --studio-smoke
## Checks loading, physics, movement, collecting, zones and rule errors, then prints one
## line starting with GSTUDIO_SMOKE (JSON) and quits with 0 on success or 1 on failure.
## Level-specific outcomes are reported under "observations" for the caller to judge.

const Humanoid := preload("res://scripts/humanoid.gd")
const Models := preload("res://scripts/models.gd")

var checks: Array = []
var failed := false


func _check(check_name: String, ok: bool, detail: String = "") -> void:
	checks.append({"name": check_name, "ok": ok, "detail": detail})
	if not ok:
		failed = true


func _frames(count: int) -> void:
	for i in range(count):
		await get_tree().physics_frame


func run(main: Node) -> void:
	var world: Node = main.get("world")
	var player: CharacterBody3D = main.get("player")
	var hud: Node = main.get("hud")
	await _frames(20)
	_check("level data loads", str(world.get("load_error")) == "", str(world.get("load_error")))
	var programs: Array = main.get("programs")
	_check("rule programs load", programs.size() > 0, "%d program(s)" % programs.size())
	_check("start rules set an objective", str(hud.get("objective")) != "", str(hud.get("objective")))

	await _frames(40)
	var y := player.global_position.y
	_check("player rests on the ground", player.is_on_floor() and y > -0.5 and y < 2.0, "y = %.2f" % y)

	var start := player.global_position
	var resting_state := str(player.get("anim_state"))
	Input.action_press("move_forward")
	await _frames(30)
	var walking_state := str(player.get("anim_state"))
	await _frames(15)
	Input.action_release("move_forward")
	await _frames(5)
	var walked := start.distance_to(player.global_position)
	_check("player walks forward", walked > 2.0, "%.2f m" % walked)

	# An imported player character: it loads, stands idle and plays its walk while moving.
	var character: Node3D = player.get("character")
	if character != null or str(player.get("character_error")) != "":
		_check("the player character loads", character != null, str(player.get("character_error")))
		var player_anim: AnimationPlayer = player.get("anim")
		var clips: Dictionary = player.get("clips")
		_check(
			"the player character stands idle and plays its walk animation while moving",
			player_anim != null and resting_state == "idle" and walking_state in ["walk", "run"] and str(clips.get("walk", "")) != "",
			"at rest %s, walking %s, clips %s" % [resting_state, walking_state, JSON.stringify(clips)]
		)
		await _frames(30)
		_check("the player character returns to idle", str(player.get("anim_state")) == "idle" and player_anim != null and player_anim.is_playing(), "now %s (%s)" % [str(player.get("anim_state")), player_anim.current_animation if player_anim != null else "no AnimationPlayer"])

	var lookup: Dictionary = world.get("nodes")
	await _fight(main, world, player, hud, lookup)
	await _blocks(main, world, player, hud, lookup)
	await _chat(main, world, player, hud, lookup)
	var items: Array = world.call("object_ids_of_type", "collectible")
	if items.size() > 0:
		var first: Node3D = lookup[items[0]]
		player.global_position = first.global_position + Vector3(0.0, 0.3, 0.0)
		player.velocity = Vector3.ZERO
		await _frames(12)
		var picked: Dictionary = world.get("collected")
		_check("touching a collectible picks it up", picked.has(items[0]), str(items[0]))
		for item_id in items:
			world.call("collect_item", item_id)
		await _frames(5)
		picked = world.get("collected")
		_check("every collectible can be collected", picked.size() == items.size(), "%d of %d" % [picked.size(), items.size()])

	for zone_id in world.call("object_ids_of_type", "zone"):
		# A block stands in this zone: the player is not dropped onto it.
		if int(world.call("blocks_in_zone", zone_id)) > 0:
			continue
		var zone: Node3D = lookup[zone_id]
		player.global_position = zone.global_position + Vector3(0.0, 0.5, 0.0)
		player.velocity = Vector3.ZERO
		await _frames(12)

	# Imported models: each loads, and a model the player bumps into has a solid box (a ray dropped
	# onto its middle stops on the model, not the ground).
	var models: Array = world.call("object_ids_of_type", "model")
	var model_errors: Dictionary = world.get("model_errors")
	_check("imported models and textures load", model_errors.is_empty(), "%d model(s); %s" % [models.size(), "; ".join(PackedStringArray(model_errors.values()))])
	var playing: Dictionary = world.call("playing_animations")
	if not playing.is_empty():
		var idle := playing.keys().filter(func(id): return str(playing[id]) == "")
		_check("animated villagers and models play their animations", idle.is_empty(), JSON.stringify(playing))
	# Characters stand on the ground: the lowest bone (a toe) is just above their feet, not under the grass.
	var feet := {}
	var sunk := []
	var standing: Dictionary = {"player": player}
	for id in lookup:
		standing[id] = lookup[id]
	for id in standing:
		var node: Node3D = standing[id]
		var low := INF
		var low_bone := ""
		for sk in node.find_children("*", "Skeleton3D", true, false):
			var skel := sk as Skeleton3D
			for b in skel.get_bone_count():
				var bone_y := (skel.global_transform * skel.get_bone_global_pose(b)).origin.y
				if bone_y < low:
					low = bone_y
					low_bone = skel.get_bone_name(b)
		if low == INF:
			continue
		var above := low - node.global_position.y
		feet[id] = "%s %.2f" % [low_bone, above]
		if above < -0.08 or above > 0.35:
			sunk.append(id)
	if not feet.is_empty():
		_check("characters stand on the ground, not sunk into it", sunk.is_empty(), "lowest bone above the feet (m): %s" % JSON.stringify(feet))
	var solid := 0
	for model_id in models:
		var m: Node3D = lookup[model_id]
		if m.get_node_or_null("Collision") == null:
			continue
		var bounds: AABB = (world.get("model_bounds") as Dictionary).get(model_id, AABB())
		var top := m.global_position + Vector3(0.0, bounds.end.y * m.scale.y + 5.0, 0.0)
		var centre := m.global_transform * bounds.get_center()
		var query := PhysicsRayQueryParameters3D.create(Vector3(centre.x, top.y, centre.z), Vector3(centre.x, -1.0, centre.z))
		var hit := player.get_world_3d().direct_space_state.intersect_ray(query)
		if not hit.is_empty() and float(hit["position"].y) > 0.05:
			solid += 1
	var colliding := models.filter(func(id): return (lookup[id] as Node3D).get_node_or_null("Collision") != null).size()
	if colliding > 0:
		_check("solid models block the player", solid == colliding, "%d of %d" % [solid, colliding])

	var rule_errors: Array = main.get("rule_errors")
	_check("rules run without errors", rule_errors.is_empty(), "; ".join(PackedStringArray(rule_errors)))

	var gates := {}
	for gate_id in world.call("object_ids_of_type", "gate"):
		gates[gate_id] = world.call("is_gate_open", gate_id)
	var sounds: Node = main.get("sounds")
	# The level's own sounds: imported files load, replaced sounds play from them, the music loops.
	var level_audio = (main.get("world").get("world") as Dictionary).get("audio", {})
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
		"gatesOpen": gates,
		"sounds": sounds.get("played"),
		"soundFiles": sounds.get("played_files"),
		"music": sounds.call("music_playing"),
		"collectibles": items.size(),
		"models": models.size(),
		"textured": world.get("textured"),
		"animations": world.call("playing_animations"),
		"playerAnimation": player.get("anim_state"),
		"highQuality": world.get("high_quality"),
		"enemies": (world.call("object_ids_of_type", "enemy") as Array).size(),
		"defeated": (world.get("defeated") as Dictionary).keys(),
		"health": player.get("health"),
		"maxHealth": player.get("max_health"),
		"hearts": hud.get("hearts_shown"),
		"blockZones": _block_zones(world),
		"timersFired": main.get("timers_fired"),
		"countdownsSeen": _countdowns_seen,
		"chats": main.get("chats"),
		"modelsUsed": world.get("models_used"),
		"enemyWalk": _enemy_walk,
		"doorPieces": world.get("door_pieces"),
		"grass": _grass(world),
		"style": (world.get("style") as RefCounted).get("style"),
		"toonMaterials": (world.get("style") as RefCounted).get("toon_materials"),
		"skyPhoto": world.get("sky_photo"),
		"vrmWalk": _vrm_walk(world),
		"realisticEffects": world.get("realistic_effects"),
		"nature": _nature(world),
	}
	print("GSTUDIO_SMOKE " + JSON.stringify({"pass": not failed, "checks": checks, "observations": observations}))
	# The audio server lets go of a stopped sound a few mixes later; quitting sooner leaks its playback.
	sounds.call("stop_all")
	await _frames(30)
	get_tree().quit(1 if failed else 0)


var _countdowns_seen: Array = []


## How the first VRM character in the level (a model object whose file is .vrm) moves its left thigh a
## quarter and three quarters into Walk: degrees back from straight down. Game Studio's humanoid clips
## (humanoid.gd) give 22 and -26; the studio's 3D view gives the same (humanoid.test.ts).
func _vrm_walk(world: Node) -> Array:
	var nodes: Dictionary = world.get("nodes")
	for o in (world.get("world") as Dictionary).get("objects", []):
		if typeof(o) != TYPE_DICTIONARY or str(o.get("type", "")) != "model" or not str(o.get("asset", "")).to_lower().ends_with(".vrm"):
			continue
		var node: Node = nodes.get(str(o.get("id", "")))
		var sk := Humanoid.skeleton(node) if node != null else null
		var ap := Models.animation_player(node) if node != null else null
		if sk == null or ap == null or not ap.has_animation("Walk"):
			return []
		ap.play("Walk")
		var f: Dictionary = Humanoid._frame(sk)
		var out := []
		for t in [0.25, 0.75]:
			ap.seek(t, true)
			var d := (sk.get_bone_global_pose(sk.find_bone("LeftLowerLeg")).origin - sk.get_bone_global_pose(sk.find_bone("LeftUpperLeg")).origin).normalized()
			out.append(snappedf(rad_to_deg(atan2(-d.dot(f["forward"]), -d.dot(f["up"]))), 0.1))
		return out
	return []


## The grass the level grew: how many tufts and a few of them (Game Studio's tests compare them with
## where the studio's 3D view puts them).
func _grass(world: Node) -> Dictionary:
	var g = world.get("grass")
	if g == null:
		return {"tufts": 0, "sample": []}
	return {"tufts": g.get("tufts"), "sample": g.get("sample")}


## The detailed trees and rocks the realistic style built (nature.gd): for each, its turn and, for each
## mesh, how many corners and triangles it has and three of its corners (position and colour). Game
## Studio's tests build the same with nature.ts and compare.
func _nature(world: Node) -> Dictionary:
	var out := {}
	var nodes: Dictionary = world.get("nodes")
	for id in nodes:
		var holder := (nodes[id] as Node).get_node_or_null("Nature") as Node3D
		if holder == null:
			continue
		var parts := []
		for child in holder.get_children():
			var arrays := (child as MeshInstance3D).mesh.surface_get_arrays(0)
			var pos: PackedVector3Array = arrays[Mesh.ARRAY_VERTEX]
			var col: PackedColorArray = arrays[Mesh.ARRAY_COLOR]
			var sample := []
			for i in [0, pos.size() >> 1, pos.size() - 1]:
				sample.append([pos[i].x, pos[i].y, pos[i].z, col[i].r, col[i].g, col[i].b])
			parts.append({"vertices": pos.size(), "triangles": int((arrays[Mesh.ARRAY_INDEX] as PackedInt32Array).size() / 3.0), "sample": sample})
		out[id] = {"turn": holder.rotation.y, "parts": parts}
	return out


## Stands in for Game Studio's answers (the self-test runs without it): answers on the next frame.
class StandInChat extends RefCounted:
	signal answered(request_id: int, text: String, error: String)
	signal test_question(npc_id: String, question: String)
	var asked: Array = []
	var _next := 1

	func available() -> bool:
		return true

	func ask(npc_id: String, question: String, history: Array) -> int:
		var id := _next
		_next += 1
		asked.append({"npc": npc_id, "question": question, "history": history.size()})
		answered.emit.call_deferred(id, "A stand-in answer to: %s" % question, "")
		return id


## Villagers with a persona: E beside one opens a conversation and stops walking, a typed question
## comes back answered (through a stand-in for Game Studio), and Esc ends it and gives the controls back.
func _chat(main: Node, world: Node, player: CharacterBody3D, hud: Node, lookup: Dictionary) -> void:
	var villager := ""
	for id in world.call("object_ids_of_type", "npc"):
		if not (main.call("villager_ai", id) as Dictionary).is_empty():
			villager = str(id)
			break
	if villager == "":
		return
	var stand_in := StandInChat.new()
	main.call("use_chat", stand_in)
	var npc: Node3D = lookup[villager]
	var away := (player.global_position - npc.global_position) * Vector3(1.0, 0.0, 1.0)
	player.global_position = npc.global_position + (away.normalized() if away.length() > 0.01 else Vector3.BACK) * 1.6 + Vector3(0.0, 0.3, 0.0)
	player.velocity = Vector3.ZERO
	await _frames(6)
	var press := InputEventAction.new()
	press.action = "interact"
	press.pressed = true
	Input.parse_input_event(press)
	var release := InputEventAction.new()
	release.action = "interact"
	release.pressed = false
	Input.parse_input_event(release)
	await _frames(3)
	_check("E beside a villager who answers with AI opens a conversation and stops walking", bool(hud.get("chat_open")) and player.get("controls_enabled") == false, "open %s, walking %s" % [str(hud.get("chat_open")), str(player.get("controls_enabled"))])
	hud.call("submit_chat", "What do you look after here?")
	await _frames(4)
	var lines: Array = hud.get("chat_lines")
	var last: Dictionary = lines.back() if not lines.is_empty() else {}
	_check("a typed question goes to Game Studio and the villager's answer appears", stand_in.asked.size() == 1 and str(last.get("from", "")) == "npc" and str(last.get("text", "")).contains("What do you look after here?") and (main.get("chats") as Array).size() == 1, JSON.stringify(lines))
	var cancel := InputEventAction.new()
	cancel.action = "ui_cancel"
	cancel.pressed = true
	Input.parse_input_event(cancel)
	await _frames(3)
	_check("Esc ends the conversation and gives the controls back", not bool(hud.get("chat_open")) and player.get("controls_enabled") == true, "open %s, walking %s" % [str(hud.get("chat_open")), str(player.get("controls_enabled"))])


## Turns the player (camera and body) to face along `d` on the ground.
func _face(player: CharacterBody3D, d: Vector3) -> void:
	player.set("yaw", atan2(-d.x, -d.z))


## Enemies: one chases the player who comes within sight, its touch costs hearts, the staff defeats it
## in as many hits as its health, and with no hearts left the player starts again at the spawn point
## with full hearts. Then every enemy can be defeated.
## The chasing enemy's animation state and clip, when it is drawn from an animated model.
var _enemy_walk := ""


func _fight(main: Node, world: Node, player: CharacterBody3D, hud: Node, lookup: Dictionary) -> void:
	var enemies: Array = world.call("object_ids_of_type", "enemy")
	if enemies.is_empty():
		return
	_check("hearts show in a level with enemies", int(hud.get("hearts_shown")) == int(player.get("health")) and int(player.get("health")) == int(player.get("max_health")), "showing %s of %s" % [hud.get("hearts_shown"), player.get("max_health")])
	var enemy: Node3D = lookup[enemies[0]]
	var enemy_id := str(enemies[0])
	if float(enemy.get("speed")) > 0.0 and float(enemy.get("sight")) > 2.5:
		var away := minf(float(enemy.get("sight")) - 1.0, 5.0)
		player.global_position = enemy.global_position + Vector3(0.0, 0.3, away)
		player.velocity = Vector3.ZERO
		await _frames(5)
		var before := (enemy.global_position - player.global_position).length()
		await _frames(30)
		var after := (enemy.global_position - player.global_position).length()
		_check("an enemy chases the player who comes within sight", after < before - 0.5 and str(enemy.get("state")) == "chase", "%.2f m -> %.2f m, %s" % [before, after, str(enemy.get("state"))])
		# An enemy drawn from an animated model walks while it moves (its legs play the model's walk).
		var enemy_anim: AnimationPlayer = enemy.get("anim")
		if enemy_anim != null:
			_enemy_walk = "%s/%s" % [str(enemy.get("anim_state")), enemy_anim.current_animation if enemy_anim.is_playing() else ""]
			_check("an enemy drawn from an animated model walks while it chases", str(enemy.get("anim_state")) == "walk" and enemy_anim.is_playing(), _enemy_walk)
	# Next to it: a touch takes the enemy's damage in hearts, and the player blinks for a moment.
	var hearts := int(player.get("health"))
	var to := (enemy.global_position - player.global_position) * Vector3(1.0, 0.0, 1.0)
	player.global_position = enemy.global_position - (to.normalized() if to.length() > 0.01 else Vector3.FORWARD) * (float(enemy.get("radius")) + 0.6) + Vector3(0.0, 0.3, 0.0)
	player.velocity = Vector3.ZERO
	var waited := 0
	while int(enemy.get("touches")) == 0 and waited < 120:
		await _frames(4)
		waited += 4
	var damage := int(enemy.get("damage"))
	# Losing the last heart starts the player again with full hearts.
	var expected := hearts - damage if hearts - damage > 0 else int(player.get("max_health"))
	_check(
		"an enemy's touch costs the player hearts, then the player blinks unhurt for a moment",
		int(enemy.get("touches")) >= 1 and int(player.get("health")) == expected and float(player.get("invulnerable")) > 0.0,
		"%d -> %d hearts after %d touch(es), blinking %.2f s" % [hearts, int(player.get("health")), int(enemy.get("touches")), float(player.get("invulnerable"))]
	)
	_check("the hearts on screen follow the player's health", int(hud.get("hearts_shown")) == int(player.get("health")), "showing %s, health %s" % [hud.get("hearts_shown"), player.get("health")])
	# The staff: swing at it until it falls (standing close and facing it before each swing).
	var swings := 0
	while not bool(enemy.get("is_defeated")) and swings < 12:
		to = (enemy.global_position - player.global_position) * Vector3(1.0, 0.0, 1.0)
		if to.length() > 1.6 or to.length() < 0.2:
			var dir := to.normalized() if to.length() > 0.01 else Vector3.FORWARD
			player.global_position = enemy.global_position - dir * (float(enemy.get("radius")) + 0.7) + Vector3(0.0, 0.3, 0.0)
			player.velocity = Vector3.ZERO
			await _frames(2)
			to = (enemy.global_position - player.global_position) * Vector3(1.0, 0.0, 1.0)
		_face(player, to)
		player.call("swing")
		swings += 1
		await _frames(28)
	_check(
		"the staff defeats an enemy in as many hits as its health",
		bool(enemy.get("is_defeated")) and int(enemy.get("hits_taken")) == int(enemy.get("max_health")) and (world.get("defeated") as Dictionary).has(enemy_id),
		"%d swing(s), %d hit(s) for health %d" % [swings, int(enemy.get("hits_taken")), int(enemy.get("max_health"))]
	)
	await _frames(30)
	var shapes_on := 0
	for child in enemy.get_children():
		if child is CollisionShape3D and not (child as CollisionShape3D).disabled:
			shapes_on += 1
	_check("a defeated enemy disappears and stops colliding", not enemy.is_visible_in_tree() and shapes_on == 0, "visible %s, %d collision shape(s) on" % [str(enemy.is_visible_in_tree()), shapes_on])
	# Out of hearts (a Hurt Player for all of them): back at the spawn point with full hearts.
	var spawn: Vector3 = player.get("spawn_point")
	player.global_position = spawn + Vector3(3.0, 0.0, 0.0)
	player.call("hurt_by_rules", int(player.get("max_health")))
	await _frames(3)
	_check(
		"with no hearts left the player starts again at the spawn point with full hearts",
		int(player.get("health")) == int(player.get("max_health")) and (player.global_position * Vector3(1.0, 0.0, 1.0)).distance_to(spawn * Vector3(1.0, 0.0, 1.0)) < 1.0,
		"%d of %d hearts, %.2f m from the spawn point" % [int(player.get("health")), int(player.get("max_health")), (player.global_position * Vector3(1.0, 0.0, 1.0)).distance_to(spawn * Vector3(1.0, 0.0, 1.0))]
	)
	for id in enemies:
		var e: Node3D = lookup[id]
		var guard := 0
		while not bool(e.get("is_defeated")) and guard < 25:
			e.call("take_hit", e.global_position + Vector3(0.0, 0.0, 1.0))
			guard += 1
	await _frames(20)
	var down: Dictionary = world.get("defeated")
	_check("every enemy can be defeated", down.size() == enemies.size(), "%d of %d" % [down.size(), enemies.size()])
	player.set("invulnerable", 0.0)


## Blocks: walking into one pushes it, a block in a zone counts there (and the rules hear of it), and
## running timers count down and run On Timer when they reach zero.
func _blocks(main: Node, world: Node, player: CharacterBody3D, hud: Node, lookup: Dictionary) -> void:
	var blocks: Array = world.call("object_ids_of_type", "crate")
	if not blocks.is_empty():
		var block: RigidBody3D = lookup[blocks[0]]
		var size: float = 1.2 * float(_object(world, str(blocks[0])).get("scale", 1.0))
		var moved := 0.0
		var tried: Array = []
		for d in [Vector3.FORWARD, Vector3.BACK, Vector3.LEFT, Vector3.RIGHT]:
			var start := block.global_position
			player.global_position = start - d * (size / 2.0 + 0.9) + Vector3(0.0, 0.3, 0.0)
			player.velocity = Vector3.ZERO
			_face(player, d)
			await _frames(6)
			Input.action_press("move_forward")
			await _frames(50)
			Input.action_release("move_forward")
			await _frames(20)
			var shift := (block.global_position - start) * Vector3(1.0, 0.0, 1.0)
			tried.append("%s %.2f m" % [str(d), shift.length()])
			# The block goes the way it was pushed, without turning.
			if shift.length() > 0.6 and shift.normalized().dot(d) > 0.95:
				moved = shift.length()
				break
		_check("walking into a block pushes it straight ahead", moved > 0.6, ", ".join(PackedStringArray(tried)))
		# Each block into the first zone (in the level's order) that holds none yet.
		var zones: Array = world.call("object_ids_of_type", "zone")
		var placed := 0
		for id in blocks:
			for zone_id in zones:
				if int(world.call("blocks_in_zone", zone_id)) > 0:
					continue
				var zone: Node3D = lookup[zone_id]
				world.call("place_block", id, zone.global_position + Vector3(0.0, 0.05, 0.0), true)
				placed += 1
				await _frames(10)
				break
		if placed > 0:
			var counted := 0
			for zone_id in zones:
				counted += int(world.call("blocks_in_zone", zone_id))
			_check("blocks pushed into zones count as standing there", counted == placed, "%d block(s) placed, %d counted" % [placed, counted])
	# Timers the rules started: they count down, show their countdown, and run On Timer at zero.
	var timers: Dictionary = main.get("timers")
	if not timers.is_empty():
		var timer_id := str(timers.keys()[0])
		var left := float(main.call("time_left", timer_id))
		await _frames(30)
		var later := float(main.call("time_left", timer_id))
		_countdowns_seen = (hud.get("countdowns") as Array).duplicate()
		var shows := str((timers.get(timer_id, {}) as Dictionary).get("countdown", "")) == "" or not _countdowns_seen.is_empty()
		_check("running timers count down and show their countdown", later < left and shows, "%s: %.2f s -> %.2f s; %s" % [timer_id, left, later, JSON.stringify(_countdowns_seen)])
		main.call("advance_timers", later + 0.01)
		await _frames(5)
		_check("a timer that reaches zero runs On Timer", (main.get("timers_fired") as Array).has(timer_id), JSON.stringify(main.get("timers_fired")))


func _object(world: Node, id: String) -> Dictionary:
	for o in (world.get("world") as Dictionary).get("objects", []):
		if typeof(o) == TYPE_DICTIONARY and str(o.get("id", "")) == id:
			return o
	return {}


func _block_zones(world: Node) -> Dictionary:
	var out := {}
	var zones: Dictionary = world.get("block_zones")
	for id in zones:
		out[id] = (zones[id] as Dictionary).keys()
	return out

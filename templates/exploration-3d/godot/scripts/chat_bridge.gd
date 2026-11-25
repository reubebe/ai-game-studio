extends RefCounted
## Villagers who answer the player with AI, while the game plays inside Game Studio (Play here). The page
## around the game (Game Studio's play-shell.html) sets up window.gamestudio; a question goes from here to
## that page, then to Game Studio, which takes the villager's persona from the project, asks the AI
## provider chosen in its Settings and sends the answer back. The game never holds a key. Anywhere else
## (an exported game, a run from Godot) there is no bridge, and villagers say their written lines.

signal answered(request_id: int, text: String, error: String)
## Game Studio's self-test asks a villager a question through the same path, as if the player typed it.
signal test_question(npc_id: String, question: String)

var _studio = null
var _reply_callback = null
var _test_callback = null
var _next_id := 1


func _init() -> void:
	if not OS.has_feature("web"):
		return
	var studio = JavaScriptBridge.get_interface("gamestudio")
	if studio == null:
		return
	_studio = studio
	# The callbacks must stay referenced while JavaScript may call them.
	_reply_callback = JavaScriptBridge.create_callback(_on_reply)
	_test_callback = JavaScriptBridge.create_callback(_on_test)
	_studio.listen(_reply_callback, _test_callback)


func available() -> bool:
	return _studio != null


## Sends a question; the answer arrives through `answered` with the returned number.
func ask(npc_id: String, question: String, history: Array) -> int:
	var id := _next_id
	_next_id += 1
	if _studio == null:
		answered.emit.call_deferred(id, "", "Villagers answer with AI only while the game plays inside Game Studio.")
		return id
	_studio.ask(JSON.stringify({"id": id, "npcId": npc_id, "question": question, "history": history}))
	return id


func _on_reply(args: Array) -> void:
	if args.is_empty():
		return
	var data = JSON.parse_string(str(args[0]))
	if typeof(data) != TYPE_DICTIONARY:
		return
	answered.emit(int(data.get("id", 0)), str(data.get("text", "")), str(data.get("error", "")))


func _on_test(args: Array) -> void:
	if args.is_empty():
		return
	var data = JSON.parse_string(str(args[0]))
	if typeof(data) == TYPE_DICTIONARY:
		test_question.emit(str(data.get("npcId", "")), str(data.get("question", "")))

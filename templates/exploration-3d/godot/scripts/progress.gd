extends RefCounted
## Keeps the player's progress in user://progress.json, so the game continues where it stopped:
## when you play it in Godot, in an exported build, or with Play here in Game Studio (which keeps
## the game's user:// files for it). Press F9 in the game, or delete the file, to start over.
## A save only applies to the level it was made in: after the level or its rules change, the game
## starts from the beginning. The self-test (--studio-smoke) never reads or writes it.

const PATH := "user://progress.json"
const VERSION := 1


static func read() -> Dictionary:
	if not FileAccess.file_exists(PATH):
		return {}
	var data = JSON.parse_string(FileAccess.get_file_as_string(PATH))
	if typeof(data) != TYPE_DICTIONARY or int(data.get("version", 0)) != VERSION:
		return {}
	return data


static func write(data: Dictionary) -> bool:
	var file := FileAccess.open(PATH, FileAccess.WRITE)
	if file == null:
		return false
	data["version"] = VERSION
	file.store_string(JSON.stringify(data))
	file.close()
	return true


static func clear() -> void:
	if FileAccess.file_exists(PATH):
		DirAccess.remove_absolute(PATH)

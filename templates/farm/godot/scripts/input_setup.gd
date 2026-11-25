extends RefCounted
## Creates the template's input actions at startup, so project.godot stays readable.
## Remap them in Project > Project Settings > Input Map; existing actions are kept.

const BINDINGS := {
	"move_up": [KEY_W, KEY_UP],
	"move_down": [KEY_S, KEY_DOWN],
	"move_left": [KEY_A, KEY_LEFT],
	"move_right": [KEY_D, KEY_RIGHT],
	"use": [KEY_E, KEY_SPACE],
	"next_seed": [KEY_Q],
	"toggle_stats": [KEY_F3],
	"new_game": [KEY_F9],
}


static func ensure_actions() -> void:
	for action in BINDINGS:
		if InputMap.has_action(action):
			continue
		InputMap.add_action(action)
		for key in BINDINGS[action]:
			var ev := InputEventKey.new()
			ev.physical_keycode = key
			InputMap.action_add_event(action, ev)

extends CanvasLayer
## Objective, messages, interaction prompt, victory banner, errors and optional stats (F3); in levels
## with enemies or health rules also the player's hearts, and the countdowns of timers that show one.

const HELP := "WASD move   Shift sprint   Space jump   E interact   Esc free the mouse   F9 start over"
const HELP_FIGHT := "WASD move   Shift sprint   Space jump   E interact   F or click swing   Esc free the mouse   F9 start over"

var objective := ""
var won := false
var messages_shown: Array = []
## Hearts on screen now (-1 while they are hidden) and the countdown lines shown.
var hearts_shown := -1
var countdowns: Array = []
## A conversation with a villager who answers with AI: open or not, with whom, and what was said.
var chat_open := false
var chat_npc := ""
var chat_lines: Array = []

signal chat_submitted(question: String)
signal chat_closed()


## Hearts drawn from shapes (a font may not have a heart): full ones red, lost ones faint.
class Hearts extends Control:
	const SIZE := 22.0
	const GAP := 6.0
	var health := 0
	var max_health := 0

	func set_hearts(value: int, most: int) -> void:
		health = value
		max_health = most
		custom_minimum_size = Vector2(float(most) * (SIZE + GAP), SIZE)
		queue_redraw()

	func _draw() -> void:
		for i in range(max_health):
			var at := Vector2(float(i) * (SIZE + GAP), 0.0)
			var c := Color("#ff5a6a") if i < health else Color(1.0, 1.0, 1.0, 0.2)
			draw_circle(at + Vector2(SIZE * 0.3, SIZE * 0.32), SIZE * 0.26, c)
			draw_circle(at + Vector2(SIZE * 0.7, SIZE * 0.32), SIZE * 0.26, c)
			draw_colored_polygon(PackedVector2Array([at + Vector2(SIZE * 0.06, SIZE * 0.42), at + Vector2(SIZE * 0.94, SIZE * 0.42), at + Vector2(SIZE * 0.5, SIZE * 0.96)]), c)

var _objective_label: Label
var _message_panel: PanelContainer
var _message_label: Label
var _prompt_label: Label
var _win_panel: Control
var _win_label: Label
var _error_label: Label
var _stats_label: Label
var _help_label: Label
var _hearts: Hearts
var _countdown_label: Label
var _flash: ColorRect
var _flash_time := 0.0
var _chat_panel: PanelContainer
var _chat_title: Label
var _chat_log: Label
var _chat_input: LineEdit
var _chat_waiting := false
var _queue: Array = []
var _message_time := 0.0


func _ready() -> void:
	var root := Control.new()
	root.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	root.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(root)

	var objective_panel := _panel(Color(0.04, 0.07, 0.12, 0.72))
	objective_panel.position = Vector2(20, 20)
	root.add_child(objective_panel)
	var objective_box := VBoxContainer.new()
	objective_panel.add_child(objective_box)
	objective_box.add_child(_label("OBJECTIVE", 12, Color("#7fd9cb")))
	_objective_label = _label("", 18, Color.WHITE)
	_objective_label.custom_minimum_size = Vector2(320, 0)
	_objective_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	objective_box.add_child(_objective_label)
	_hearts = Hearts.new()
	_hearts.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_hearts.visible = false
	objective_box.add_child(_hearts)
	_countdown_label = _label("", 18, Color("#ffd98a"))
	_countdown_label.visible = false
	objective_box.add_child(_countdown_label)

	_help_label = _label(HELP, 13, Color(1, 1, 1, 0.75))
	_help_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	root.add_child(_help_label)
	_help_label.set_anchors_and_offsets_preset(Control.PRESET_TOP_RIGHT, Control.PRESET_MODE_MINSIZE, 20)

	# A red flash over the whole screen when an enemy hurts the player.
	_flash = ColorRect.new()
	_flash.color = Color(0.85, 0.05, 0.05, 0.0)
	_flash.mouse_filter = Control.MOUSE_FILTER_IGNORE
	root.add_child(_flash)
	_flash.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	_build_chat(root)

	_error_label = _label("", 15, Color("#ff9a8f"))
	_error_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_error_label.custom_minimum_size = Vector2(520, 0)
	_error_label.visible = false
	root.add_child(_error_label)
	_error_label.set_anchors_and_offsets_preset(Control.PRESET_CENTER_TOP, Control.PRESET_MODE_MINSIZE, 70)

	_stats_label = _label("", 13, Color("#bfe9ff"))
	_stats_label.visible = false
	root.add_child(_stats_label)
	_stats_label.set_anchors_and_offsets_preset(Control.PRESET_BOTTOM_LEFT, Control.PRESET_MODE_MINSIZE, 20)

	var bottom := VBoxContainer.new()
	bottom.mouse_filter = Control.MOUSE_FILTER_IGNORE
	bottom.alignment = BoxContainer.ALIGNMENT_END
	root.add_child(bottom)
	bottom.set_anchors_and_offsets_preset(Control.PRESET_BOTTOM_WIDE, Control.PRESET_MODE_MINSIZE, 32)
	bottom.grow_vertical = Control.GROW_DIRECTION_BEGIN
	_prompt_label = _label("", 18, Color("#ffe3a3"))
	_prompt_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	bottom.add_child(_prompt_label)
	var center := CenterContainer.new()
	center.mouse_filter = Control.MOUSE_FILTER_IGNORE
	bottom.add_child(center)
	_message_panel = _panel(Color(0.04, 0.07, 0.12, 0.85))
	_message_panel.visible = false
	center.add_child(_message_panel)
	_message_label = _label("", 20, Color.WHITE)
	_message_label.custom_minimum_size = Vector2(560, 0)
	_message_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_message_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_message_panel.add_child(_message_label)

	_win_panel = ColorRect.new()
	(_win_panel as ColorRect).color = Color(0.02, 0.05, 0.1, 0.72)
	_win_panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_win_panel.visible = false
	root.add_child(_win_panel)
	_win_panel.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	var win_center := CenterContainer.new()
	win_center.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_win_panel.add_child(win_center)
	win_center.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	var win_box := VBoxContainer.new()
	win_center.add_child(win_box)
	_win_label = _label("", 34, Color("#ffd98a"))
	_win_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	win_box.add_child(_win_label)
	var sub := _label("Keep exploring, or press Esc to free the mouse.", 16, Color(1, 1, 1, 0.8))
	sub.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	win_box.add_child(sub)


func _process(delta: float) -> void:
	if _message_panel.visible:
		_message_time -= delta
		if _message_time <= 0.0:
			_next_message()
	if _flash_time > 0.0:
		_flash_time = maxf(0.0, _flash_time - delta)
		_flash.color.a = 0.35 * _flash_time / 0.35


func _build_chat(root: Control) -> void:
	_chat_panel = _panel(Color(0.04, 0.07, 0.12, 0.92))
	_chat_panel.visible = false
	_chat_panel.mouse_filter = Control.MOUSE_FILTER_STOP
	root.add_child(_chat_panel)
	_chat_panel.set_anchors_and_offsets_preset(Control.PRESET_CENTER_BOTTOM, Control.PRESET_MODE_MINSIZE, 120)
	_chat_panel.grow_horizontal = Control.GROW_DIRECTION_BOTH
	_chat_panel.grow_vertical = Control.GROW_DIRECTION_BEGIN
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 8)
	_chat_panel.add_child(box)
	_chat_title = _label("", 14, Color("#7fd9cb"))
	box.add_child(_chat_title)
	_chat_log = _label("", 17, Color.WHITE)
	_chat_log.custom_minimum_size = Vector2(620, 0)
	_chat_log.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	box.add_child(_chat_log)
	_chat_input = LineEdit.new()
	_chat_input.max_length = 200
	_chat_input.custom_minimum_size = Vector2(620, 34)
	_chat_input.text_submitted.connect(_on_chat_submit)
	box.add_child(_chat_input)
	box.add_child(_label("Enter asks   Esc ends the conversation", 12, Color(1, 1, 1, 0.6)))


func open_chat(npc_name: String) -> void:
	chat_open = true
	chat_npc = npc_name
	chat_lines.clear()
	_chat_waiting = false
	_chat_title.text = "TALKING WITH %s" % npc_name.to_upper()
	_chat_input.placeholder_text = "Ask %s something..." % npc_name
	_chat_input.text = ""
	_chat_input.editable = true
	_show_chat()
	_chat_panel.visible = true
	_chat_input.grab_focus()


func close_chat() -> void:
	if not chat_open:
		return
	chat_open = false
	_chat_panel.visible = false
	_chat_input.release_focus()
	chat_closed.emit()


## Adds a line to the conversation ("player" or "npc"); an npc line also ends the wait for it.
func add_chat_line(from: String, text: String) -> void:
	chat_lines.append({"from": from, "text": text})
	if from == "npc":
		_chat_waiting = false
		_chat_input.editable = true
		_chat_input.grab_focus()
	_show_chat()


func chat_history() -> Array:
	return chat_lines.slice(maxi(chat_lines.size() - 8, 0))


func _on_chat_submit(text: String) -> void:
	var question := text.strip_edges()
	if question == "" or _chat_waiting:
		return
	_chat_input.text = ""
	submit_chat(question)


## Puts the player's question in the conversation and asks for the answer (the Enter key, or the self-test).
func submit_chat(question: String) -> void:
	add_chat_line("player", question)
	_chat_waiting = true
	_chat_input.editable = false
	_show_chat()
	chat_submitted.emit(question)


func _show_chat() -> void:
	var shown: Array = []
	for line in chat_lines.slice(maxi(chat_lines.size() - 6, 0)):
		shown.append(("You: %s" if line["from"] == "player" else chat_npc + ": %s") % str(line["text"]))
	if _chat_waiting:
		shown.append("%s is thinking..." % chat_npc)
	_chat_log.text = "\n".join(PackedStringArray(shown)) if not shown.is_empty() else "Say hello, or ask a question."


func _input(event: InputEvent) -> void:
	if chat_open and event.is_action_pressed("ui_cancel"):
		close_chat()
		get_viewport().set_input_as_handled()


## Shows the fighting controls in the help line (levels with enemies).
func set_fight_controls(on: bool) -> void:
	_help_label.text = HELP_FIGHT if on else HELP


## Shows the player's hearts (from the first change, or from the start in levels with enemies).
func set_health(value: int, most: int) -> void:
	hearts_shown = value
	_hearts.visible = true
	_hearts.set_hearts(value, most)


func flash_hurt() -> void:
	_flash_time = 0.35


## Countdown lines, such as "Sunset in 1:05"; an empty list hides them.
func set_countdowns(lines: Array) -> void:
	countdowns = lines
	_countdown_label.text = "\n".join(PackedStringArray(lines))
	_countdown_label.visible = not lines.is_empty()


func set_objective(text: String) -> void:
	objective = text
	_objective_label.text = text


func show_message(text: String, seconds: float) -> void:
	messages_shown.append(text)
	_queue.append([text, maxf(seconds, 0.5)])
	if not _message_panel.visible:
		_next_message()


func clear_messages() -> void:
	_queue.clear()
	_message_panel.visible = false


func _next_message() -> void:
	if _queue.is_empty():
		_message_panel.visible = false
		return
	var item: Array = _queue.pop_front()
	_message_label.text = str(item[0])
	_message_time = float(item[1])
	_message_panel.visible = true


func set_prompt(text: String) -> void:
	_prompt_label.text = ("E   " + text) if text != "" else ""


func show_win(text: String) -> void:
	won = true
	_win_label.text = text
	_win_panel.visible = true


func show_error(text: String) -> void:
	_error_label.text = text
	_error_label.visible = text != ""


func toggle_stats() -> void:
	_stats_label.visible = not _stats_label.visible


func update_stats(stats: Dictionary) -> void:
	if _stats_label.visible:
		_stats_label.text = "%d fps   %.1f ms process   %d draw calls   %d nodes" % [int(stats.get("fps", 0)), float(stats.get("processMs", 0.0)), int(stats.get("drawCalls", 0)), int(stats.get("nodes", 0))]


func _panel(color: Color) -> PanelContainer:
	var panel := PanelContainer.new()
	var style := StyleBoxFlat.new()
	style.bg_color = color
	style.set_corner_radius_all(10)
	style.content_margin_left = 16
	style.content_margin_right = 16
	style.content_margin_top = 12
	style.content_margin_bottom = 12
	panel.add_theme_stylebox_override("panel", style)
	panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
	return panel


func _label(text: String, font_size: int, color: Color) -> Label:
	var label := Label.new()
	label.text = text
	label.add_theme_font_size_override("font_size", font_size)
	label.add_theme_color_override("font_color", color)
	label.add_theme_color_override("font_outline_color", Color(0, 0, 0, 0.8))
	label.add_theme_constant_override("outline_size", 4)
	label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	return label

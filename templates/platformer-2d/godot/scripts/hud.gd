extends CanvasLayer
## Objective, coin counter, messages, the level-complete banner, errors and optional stats (F3).

var objective := ""
var won := false
var messages_shown: Array = []

var _objective_label: Label
var _coins_label: Label
var _message_panel: PanelContainer
var _message_label: Label
var _win_panel: Control
var _win_label: Label
var _error_label: Label
var _stats_label: Label
var _queue: Array = []
var _message_time := 0.0


func _ready() -> void:
	var root := Control.new()
	root.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	root.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(root)

	var objective_panel := _panel(Color(0.06, 0.05, 0.14, 0.7))
	objective_panel.position = Vector2(20, 20)
	root.add_child(objective_panel)
	var objective_box := VBoxContainer.new()
	objective_panel.add_child(objective_box)
	objective_box.add_child(_label("OBJECTIVE", 12, Color("#ffcf8a")))
	_objective_label = _label("", 18, Color.WHITE)
	_objective_label.custom_minimum_size = Vector2(340, 0)
	_objective_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	objective_box.add_child(_objective_label)

	var coins_panel := _panel(Color(0.06, 0.05, 0.14, 0.7))
	root.add_child(coins_panel)
	coins_panel.set_anchors_and_offsets_preset(Control.PRESET_TOP_RIGHT, Control.PRESET_MODE_MINSIZE, 20)
	coins_panel.grow_horizontal = Control.GROW_DIRECTION_BEGIN
	_coins_label = _label("", 22, Color("#ffd95e"))
	coins_panel.add_child(_coins_label)

	var help := _label("A D or arrows run   Space jump (hold for higher)   F9 start over", 13, Color(1, 1, 1, 0.75))
	root.add_child(help)
	help.set_anchors_and_offsets_preset(Control.PRESET_BOTTOM_RIGHT, Control.PRESET_MODE_MINSIZE, 16)
	help.grow_horizontal = Control.GROW_DIRECTION_BEGIN
	help.grow_vertical = Control.GROW_DIRECTION_BEGIN

	_error_label = _label("", 15, Color("#ff9a8f"))
	_error_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_error_label.custom_minimum_size = Vector2(520, 0)
	_error_label.visible = false
	root.add_child(_error_label)
	_error_label.set_anchors_and_offsets_preset(Control.PRESET_CENTER_TOP, Control.PRESET_MODE_MINSIZE, 90)

	_stats_label = _label("", 13, Color("#bfe9ff"))
	_stats_label.visible = false
	root.add_child(_stats_label)
	_stats_label.set_anchors_and_offsets_preset(Control.PRESET_BOTTOM_LEFT, Control.PRESET_MODE_MINSIZE, 16)

	# Messages sit near the top: the action happens at the bottom of the screen.
	var top := CenterContainer.new()
	top.mouse_filter = Control.MOUSE_FILTER_IGNORE
	root.add_child(top)
	top.set_anchors_and_offsets_preset(Control.PRESET_TOP_WIDE, Control.PRESET_MODE_MINSIZE, 140)
	_message_panel = _panel(Color(0.06, 0.05, 0.14, 0.86))
	_message_panel.visible = false
	top.add_child(_message_panel)
	_message_label = _label("", 20, Color.WHITE)
	_message_label.custom_minimum_size = Vector2(560, 0)
	_message_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_message_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_message_panel.add_child(_message_label)

	_win_panel = ColorRect.new()
	(_win_panel as ColorRect).color = Color(0.05, 0.03, 0.12, 0.7)
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
	var sub := _label("Press F9 to play the level again.", 16, Color(1, 1, 1, 0.8))
	sub.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	win_box.add_child(sub)


func _process(delta: float) -> void:
	if _message_panel.visible:
		_message_time -= delta
		if _message_time <= 0.0:
			_next_message()


func set_objective(text: String) -> void:
	objective = text
	_objective_label.text = text


func set_coins(collected: int, total: int) -> void:
	_coins_label.text = "● %d / %d" % [collected, total]


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
	style.content_margin_top = 10
	style.content_margin_bottom = 10
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

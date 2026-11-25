extends CanvasLayer
## The goal, the day, the clock and the weather, money, the chosen seed, the basket, what E would do
## on the tile in front, messages, the end-of-season banner, errors and optional stats (F3).

const HELP := "WASD walk   E work the tile in front   Q next seed   F9 start over"

var goal := ""
var ended := false
var ended_text := ""
var prompt := ""
var messages_shown: Array = []
var money_text := ""
var day_text := ""

var _currency := "coins"
var _goal_label: Label
var _day_label: Label
var _money_label: Label
var _seed_label: Label
var _seed_swatch: ColorRect
var _basket_label: Label
var _prompt_label: Label
var _message_panel: PanelContainer
var _message_label: Label
var _banner: Control
var _banner_label: Label
var _error_label: Label
var _stats_label: Label
var _queue: Array = []
var _message_time := 0.0
var _day := 1
var _raining := false
var _clock := "6:00"


func _ready() -> void:
	var root := Control.new()
	root.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	root.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(root)

	var goal_panel := _panel(Color(0.08, 0.1, 0.06, 0.78))
	goal_panel.position = Vector2(18, 18)
	root.add_child(goal_panel)
	var goal_box := VBoxContainer.new()
	goal_panel.add_child(goal_box)
	goal_box.add_child(_label("GOAL", 12, Color("#c5e1a5")))
	_goal_label = _label("", 17, Color.WHITE)
	_goal_label.custom_minimum_size = Vector2(320, 0)
	_goal_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	goal_box.add_child(_goal_label)

	var status := _panel(Color(0.08, 0.1, 0.06, 0.78))
	root.add_child(status)
	status.set_anchors_and_offsets_preset(Control.PRESET_TOP_RIGHT, Control.PRESET_MODE_MINSIZE, 18)
	status.grow_horizontal = Control.GROW_DIRECTION_BEGIN
	var status_box := VBoxContainer.new()
	status.add_child(status_box)
	_day_label = _label("Day 1", 18, Color("#ffe8a3"))
	_day_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	status_box.add_child(_day_label)
	_money_label = _label("0 coins", 22, Color.WHITE)
	_money_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	status_box.add_child(_money_label)

	var tools := _panel(Color(0.08, 0.1, 0.06, 0.78))
	root.add_child(tools)
	tools.set_anchors_and_offsets_preset(Control.PRESET_BOTTOM_LEFT, Control.PRESET_MODE_MINSIZE, 18)
	tools.grow_vertical = Control.GROW_DIRECTION_BEGIN
	var tools_box := VBoxContainer.new()
	tools.add_child(tools_box)
	var seed_row := HBoxContainer.new()
	seed_row.add_theme_constant_override("separation", 8)
	tools_box.add_child(seed_row)
	_seed_swatch = ColorRect.new()
	_seed_swatch.custom_minimum_size = Vector2(14, 14)
	seed_row.add_child(_seed_swatch)
	_seed_label = _label("", 16, Color.WHITE)
	seed_row.add_child(_seed_label)
	_basket_label = _label("Basket: empty", 14, Color(1, 1, 1, 0.8))
	tools_box.add_child(_basket_label)

	var help := _label(HELP, 13, Color(1, 1, 1, 0.75))
	root.add_child(help)
	help.set_anchors_and_offsets_preset(Control.PRESET_BOTTOM_RIGHT, Control.PRESET_MODE_MINSIZE, 16)

	_error_label = _label("", 15, Color("#ff9a8f"))
	_error_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_error_label.custom_minimum_size = Vector2(520, 0)
	_error_label.visible = false
	root.add_child(_error_label)
	_error_label.set_anchors_and_offsets_preset(Control.PRESET_CENTER_TOP, Control.PRESET_MODE_MINSIZE, 90)

	_stats_label = _label("", 13, Color("#bfe9ff"))
	_stats_label.visible = false
	root.add_child(_stats_label)
	_stats_label.set_anchors_and_offsets_preset(Control.PRESET_CENTER_BOTTOM, Control.PRESET_MODE_MINSIZE, 8)

	var bottom := VBoxContainer.new()
	bottom.mouse_filter = Control.MOUSE_FILTER_IGNORE
	bottom.alignment = BoxContainer.ALIGNMENT_END
	root.add_child(bottom)
	bottom.set_anchors_and_offsets_preset(Control.PRESET_BOTTOM_WIDE, Control.PRESET_MODE_MINSIZE, 70)
	bottom.grow_vertical = Control.GROW_DIRECTION_BEGIN
	_prompt_label = _label("", 18, Color("#ffe3a3"))
	_prompt_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	bottom.add_child(_prompt_label)
	var center := CenterContainer.new()
	center.mouse_filter = Control.MOUSE_FILTER_IGNORE
	bottom.add_child(center)
	_message_panel = _panel(Color(0.08, 0.1, 0.06, 0.88))
	_message_panel.visible = false
	center.add_child(_message_panel)
	_message_label = _label("", 19, Color.WHITE)
	_message_label.custom_minimum_size = Vector2(560, 0)
	_message_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_message_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_message_panel.add_child(_message_label)

	_banner = ColorRect.new()
	(_banner as ColorRect).color = Color(0.05, 0.07, 0.04, 0.75)
	_banner.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_banner.visible = false
	root.add_child(_banner)
	_banner.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	var banner_center := CenterContainer.new()
	banner_center.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_banner.add_child(banner_center)
	banner_center.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	var banner_box := VBoxContainer.new()
	banner_center.add_child(banner_box)
	_banner_label = _label("", 32, Color("#ffe08a"))
	_banner_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_banner_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_banner_label.custom_minimum_size = Vector2(700, 0)
	banner_box.add_child(_banner_label)
	var sub := _label("Press F9 to start a new season.", 16, Color(1, 1, 1, 0.8))
	sub.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	banner_box.add_child(sub)


func _process(delta: float) -> void:
	if _message_panel.visible:
		_message_time -= delta
		if _message_time <= 0.0:
			_next_message()


func set_currency(name_text: String) -> void:
	_currency = name_text


func set_goal(text: String) -> void:
	goal = text
	_goal_label.text = text


func set_money(amount: int) -> void:
	money_text = "%d %s" % [amount, _currency]
	_money_label.text = money_text


func set_day(day: int, raining: bool) -> void:
	_day = day
	_raining = raining
	_show_day()


func set_clock(text: String) -> void:
	if text != _clock:
		_clock = text
		_show_day()


func _show_day() -> void:
	day_text = "Day %d   %s   %s" % [_day, _clock, "Rain" if _raining else "Sun"]
	_day_label.text = day_text


func set_seed(name_text: String, cost: int, color: Color) -> void:
	_seed_label.text = "Seed: %s (%d %s)   Q next" % [name_text, cost, _currency] if name_text != "" else "No crops on this farm"
	_seed_swatch.color = color


func set_basket(lines: Array) -> void:
	_basket_label.text = "Basket: " + (", ".join(PackedStringArray(lines)) if not lines.is_empty() else "empty")


func set_prompt(text: String) -> void:
	prompt = text
	_prompt_label.text = text


func show_message(text: String, seconds: float) -> void:
	messages_shown.append(text)
	_queue.append([text, maxf(seconds, 0.5)])
	if not _message_panel.visible:
		_next_message()


func _next_message() -> void:
	if _queue.is_empty():
		_message_panel.visible = false
		return
	var item: Array = _queue.pop_front()
	_message_label.text = str(item[0])
	_message_time = float(item[1])
	_message_panel.visible = true


func show_result(text: String) -> void:
	ended = true
	ended_text = text
	_banner_label.text = text
	_banner.visible = true


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
	style.content_margin_left = 14
	style.content_margin_right = 14
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

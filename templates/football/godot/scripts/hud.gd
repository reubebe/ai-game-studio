extends CanvasLayer
## Scoreboard with the clock, the rules' caption, messages, the full-time banner, errors and optional
## stats (F3).

const HELP := "WASD run   Shift sprint   Space shoot   E pass or tackle   Q switch player   F9 restart"
const HELP_WATCHING := "Watching the computer play both sides   F9 restart"

var caption := ""
var ended := false
var ended_text := ""
var messages_shown: Array = []
var score_text := ""
var clock_text := ""

var _help: Label
var _home_name: Label
var _away_name: Label
var _score: Label
var _clock: Label
var _caption: Label
var _home_swatch: ColorRect
var _away_swatch: ColorRect
var _message_panel: PanelContainer
var _message_label: Label
var _banner: Control
var _banner_label: Label
var _error_label: Label
var _stats_label: Label
var _queue: Array = []
var _message_time := 0.0


func _ready() -> void:
	var root := Control.new()
	root.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	root.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(root)

	var top := VBoxContainer.new()
	top.mouse_filter = Control.MOUSE_FILTER_IGNORE
	top.alignment = BoxContainer.ALIGNMENT_BEGIN
	root.add_child(top)
	top.set_anchors_and_offsets_preset(Control.PRESET_CENTER_TOP, Control.PRESET_MODE_MINSIZE, 16)
	var board := _panel(Color(0.04, 0.07, 0.12, 0.85))
	top.add_child(board)
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 12)
	row.alignment = BoxContainer.ALIGNMENT_CENTER
	board.add_child(row)
	_home_swatch = _swatch()
	row.add_child(_home_swatch)
	_home_name = _label("HOM", 24, Color.WHITE)
	row.add_child(_home_name)
	_score = _label("0 – 0", 28, Color("#ffd98a"))
	row.add_child(_score)
	_away_name = _label("AWY", 24, Color.WHITE)
	row.add_child(_away_name)
	_away_swatch = _swatch()
	row.add_child(_away_swatch)
	_clock = _label("0:00", 22, Color("#c9fff6"))
	_clock.custom_minimum_size = Vector2(70, 0)
	_clock.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	row.add_child(_clock)
	_caption = _label("", 16, Color(1, 1, 1, 0.85))
	_caption.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	top.add_child(_caption)

	# On a dark strip of its own: the boards behind it are bright.
	var help_panel := _panel(Color(0.04, 0.07, 0.12, 0.7))
	root.add_child(help_panel)
	_help = _label(HELP, 13, Color(1, 1, 1, 0.85))
	help_panel.add_child(_help)
	help_panel.set_anchors_and_offsets_preset(Control.PRESET_BOTTOM_RIGHT, Control.PRESET_MODE_MINSIZE, 10)
	help_panel.grow_horizontal = Control.GROW_DIRECTION_BEGIN
	help_panel.grow_vertical = Control.GROW_DIRECTION_BEGIN

	_error_label = _label("", 15, Color("#ff9a8f"))
	_error_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_error_label.custom_minimum_size = Vector2(520, 0)
	_error_label.visible = false
	root.add_child(_error_label)
	_error_label.set_anchors_and_offsets_preset(Control.PRESET_CENTER_TOP, Control.PRESET_MODE_MINSIZE, 110)

	_stats_label = _label("", 13, Color("#bfe9ff"))
	_stats_label.visible = false
	root.add_child(_stats_label)
	_stats_label.set_anchors_and_offsets_preset(Control.PRESET_BOTTOM_LEFT, Control.PRESET_MODE_MINSIZE, 14)

	var bottom := VBoxContainer.new()
	bottom.mouse_filter = Control.MOUSE_FILTER_IGNORE
	bottom.alignment = BoxContainer.ALIGNMENT_END
	root.add_child(bottom)
	bottom.set_anchors_and_offsets_preset(Control.PRESET_BOTTOM_WIDE, Control.PRESET_MODE_MINSIZE, 48)
	bottom.grow_vertical = Control.GROW_DIRECTION_BEGIN
	var center := CenterContainer.new()
	center.mouse_filter = Control.MOUSE_FILTER_IGNORE
	bottom.add_child(center)
	_message_panel = _panel(Color(0.04, 0.07, 0.12, 0.85))
	_message_panel.visible = false
	center.add_child(_message_panel)
	_message_label = _label("", 22, Color.WHITE)
	_message_label.custom_minimum_size = Vector2(560, 0)
	_message_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_message_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_message_panel.add_child(_message_label)

	_banner = ColorRect.new()
	(_banner as ColorRect).color = Color(0.02, 0.05, 0.1, 0.72)
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
	_banner_label = _label("", 34, Color("#ffd98a"))
	_banner_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_banner_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_banner_label.custom_minimum_size = Vector2(700, 0)
	banner_box.add_child(_banner_label)
	var sub := _label("Press F9 to play the match again.", 16, Color(1, 1, 1, 0.8))
	sub.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	banner_box.add_child(sub)


func _process(delta: float) -> void:
	if _message_panel.visible:
		_message_time -= delta
		if _message_time <= 0.0:
			_next_message()


func set_teams(home: Dictionary, away: Dictionary) -> void:
	_home_name.text = str(home.get("short", "HOM"))
	_away_name.text = str(away.get("short", "AWY"))
	_home_swatch.color = Color(str(home.get("shirt", "#e5484d")))
	_away_swatch.color = Color(str(away.get("shirt", "#3b82f6")))


func set_score(home: int, away: int) -> void:
	score_text = "%d – %d" % [home, away]
	_score.text = score_text


func set_clock(seconds_left: float) -> void:
	var whole := int(ceil(maxf(seconds_left, 0.0)))
	clock_text = "%d:%02d" % [whole / 60, whole % 60]
	_clock.text = clock_text


func set_caption(text: String) -> void:
	caption = text
	_caption.text = text


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


func hide_result() -> void:
	ended = false
	ended_text = ""
	_banner.visible = false


func set_watching(on: bool) -> void:
	_help.text = HELP_WATCHING if on else HELP


func show_error(text: String) -> void:
	_error_label.text = text
	_error_label.visible = text != ""


func toggle_stats() -> void:
	_stats_label.visible = not _stats_label.visible


func update_stats(stats: Dictionary) -> void:
	if _stats_label.visible:
		_stats_label.text = "%d fps   %.1f ms process   %d draw calls   %d nodes" % [int(stats.get("fps", 0)), float(stats.get("processMs", 0.0)), int(stats.get("drawCalls", 0)), int(stats.get("nodes", 0))]


func _swatch() -> ColorRect:
	var r := ColorRect.new()
	r.custom_minimum_size = Vector2(12, 26)
	r.mouse_filter = Control.MOUSE_FILTER_IGNORE
	return r


func _panel(color: Color) -> PanelContainer:
	var panel := PanelContainer.new()
	var style := StyleBoxFlat.new()
	style.bg_color = color
	style.set_corner_radius_all(10)
	style.content_margin_left = 16
	style.content_margin_right = 16
	style.content_margin_top = 8
	style.content_margin_bottom = 8
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

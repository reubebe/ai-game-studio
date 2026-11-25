extends Node2D
## The farmer, seen from above: a straw hat over a shirt in the farm's colour, with the name shown
## above. main.gd moves it; this script draws it, bobbing while it walks and looking the way it goes.

const RADIUS := 14.0

var shirt := Color("#e8833a")
var farmer_name := ""
var facing := Vector2.DOWN
var moving := false
var _step := 0.0
var _label: Label


func _ready() -> void:
	_label = Label.new()
	_label.add_theme_font_size_override("font_size", 14)
	_label.add_theme_color_override("font_color", Color.WHITE)
	_label.add_theme_color_override("font_outline_color", Color(0, 0, 0, 0.8))
	_label.add_theme_constant_override("outline_size", 4)
	_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_label.size = Vector2(120, 20)
	_label.position = Vector2(-60, -46)
	add_child(_label)


func setup(name_text: String, shirt_color: Color) -> void:
	farmer_name = name_text
	shirt = shirt_color
	if _label != null:
		_label.text = name_text
	queue_redraw()


func _process(delta: float) -> void:
	if moving:
		_step += delta * 10.0
	else:
		_step = 0.0
	queue_redraw()


func _draw() -> void:
	var bob := absf(sin(_step)) * 2.5
	draw_circle(Vector2(0, 10), RADIUS * 0.9, Color(0, 0, 0, 0.2))
	# Feet swing while walking.
	var swing := sin(_step) * 5.0 if moving else 0.0
	var side := Vector2(-facing.y, facing.x)
	draw_circle(side * 6.0 + facing * swing + Vector2(0, 6), 4.0, Color("#4a3426"))
	draw_circle(-side * 6.0 - facing * swing + Vector2(0, 6), 4.0, Color("#4a3426"))
	draw_circle(Vector2(0, -bob), RADIUS, shirt)
	draw_circle(Vector2(0, -bob) + facing * 4.0, RADIUS * 0.55, Color("#8d5524"))
	# The straw hat, its brim a little ahead of where the farmer looks.
	draw_circle(Vector2(0, -bob - 4) + facing * 2.0, RADIUS * 0.95, Color("#e9cf7a"))
	draw_circle(Vector2(0, -bob - 5) + facing * 1.0, RADIUS * 0.55, Color("#d4b45a"))

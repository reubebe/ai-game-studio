extends CanvasLayer
## Sky gradient and a band of hills behind the level, drawn without image files.

var sky_top := Color("#2b3a78")
var sky_bottom := Color("#f4a261")
var hills := Color("#6d4c7d")


func setup(colours: Dictionary) -> void:
	sky_top = Color(str(colours.get("skyTop", "#2b3a78")))
	sky_bottom = Color(str(colours.get("skyBottom", "#f4a261")))
	hills = Color(str(colours.get("hills", "#6d4c7d")))


func _ready() -> void:
	layer = -10
	var gradient := Gradient.new()
	gradient.set_color(0, sky_top)
	gradient.set_color(1, sky_bottom)
	var texture := GradientTexture2D.new()
	texture.gradient = gradient
	texture.fill_from = Vector2(0, 0)
	texture.fill_to = Vector2(0, 1)
	var sky := TextureRect.new()
	sky.texture = texture
	sky.stretch_mode = TextureRect.STRETCH_SCALE
	sky.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	sky.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(sky)


## Hills that scroll slower than the level, for depth.
func make_hills(level_width_px: float) -> Parallax2D:
	var parallax := Parallax2D.new()
	parallax.scroll_scale = Vector2(0.35, 0.35)
	for band in range(2):
		var poly := Polygon2D.new()
		var points := PackedVector2Array()
		var base_y := 40.0 + band * 60.0
		var width := level_width_px * 0.5 + 1600.0
		points.append(Vector2(-400, 600))
		var x := -400.0
		while x <= width:
			points.append(Vector2(x, base_y - 120.0 - sin(x * 0.004 + band * 2.0) * 70.0 - sin(x * 0.011) * 25.0))
			x += 40.0
		points.append(Vector2(width, 600))
		poly.polygon = points
		poly.color = hills.lightened(0.18) if band == 0 else hills
		parallax.add_child(poly)
	return parallax

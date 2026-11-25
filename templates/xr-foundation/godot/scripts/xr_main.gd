extends Node3D
## OpenXR entry scene (foundation, not verified on a headset by Game Studio).
## Starts OpenXR when a runtime is available, places the viewer at the level's spawn point,
## moves with the left thumbstick and snap-turns 30 degrees with the right thumbstick.
## Collecting, gates and rules are wired only in the desktop scene (scenes/main.tscn) for now.

const SNAP_DEGREES := 30.0

@onready var origin: XROrigin3D = $XROrigin3D
@onready var camera: XRCamera3D = $XROrigin3D/XRCamera3D
@onready var left_hand: XRController3D = $XROrigin3D/LeftHand
@onready var right_hand: XRController3D = $XROrigin3D/RightHand
@onready var world: Node3D = $World

var move_speed := 2.0
var _snap_ready := true


func _ready() -> void:
	var xr := XRServer.find_interface("OpenXR")
	if xr != null and xr.is_initialized():
		DisplayServer.window_set_vsync_mode(DisplayServer.VSYNC_DISABLED)
		get_viewport().use_xr = true
		print("GSTUDIO_XR openxr-initialized")
	else:
		print("GSTUDIO_XR no-openxr-runtime")
		var label := get_node_or_null("XROrigin3D/XRCamera3D/FallbackLabel") as Label3D
		if label != null:
			label.visible = true
	var settings: Dictionary = world.call("player_settings")
	var spawn: Dictionary = settings.get("spawn", {})
	origin.global_position = Vector3(float(spawn.get("x", 0.0)), 0.0, float(spawn.get("z", 0.0)))


func _physics_process(delta: float) -> void:
	var move := left_hand.get_vector2("primary")
	if move.length() > 0.15:
		var yaw := camera.global_transform.basis.get_euler().y
		var direction := Basis(Vector3.UP, yaw) * Vector3(move.x, 0.0, -move.y)
		origin.global_position += direction * move_speed * delta
	var turn := right_hand.get_vector2("primary")
	if absf(turn.x) > 0.7 and _snap_ready:
		_snap_ready = false
		var pivot := camera.global_position
		pivot.y = origin.global_position.y
		origin.global_transform = origin.global_transform.translated(-pivot).rotated(Vector3.UP, -signf(turn.x) * deg_to_rad(SNAP_DEGREES)).translated(pivot)
	elif absf(turn.x) < 0.3:
		_snap_ready = true

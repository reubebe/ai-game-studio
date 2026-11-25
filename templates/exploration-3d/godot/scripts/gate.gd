extends Node3D
## open() lets the player through at once and sinks the door into the ground; open_now() skips the sinking.

var is_open := false


func open() -> void:
	if is_open:
		return
	is_open = true
	var door := get_node_or_null("Door") as StaticBody3D
	if door == null:
		return
	for child in door.get_children():
		if child is CollisionShape3D:
			child.set_deferred("disabled", true)
	var tween := create_tween()
	tween.tween_property(door, "position:y", -4.2, 2.5).set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_IN_OUT)


func open_now() -> void:
	if is_open:
		return
	is_open = true
	var door := get_node_or_null("Door") as StaticBody3D
	if door == null:
		return
	for child in door.get_children():
		if child is CollisionShape3D:
			child.set_deferred("disabled", true)
	door.position.y = -4.2

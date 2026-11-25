extends Area3D
## Spins and bobs; reports the first time the player touches it.

signal collected(item_id: String, kind: String)

var item_id := ""
var kind := "crystal"
var label_text := ""
var _time := 0.0
var _taken := false


func setup(new_id: String, new_kind: String, new_label: String) -> void:
	item_id = new_id
	kind = new_kind
	label_text = new_label


func _ready() -> void:
	body_entered.connect(_on_body_entered)


func _process(delta: float) -> void:
	_time += delta
	var visual := get_node_or_null("Visual") as Node3D
	if visual != null:
		visual.rotation.y += delta * 1.6
		visual.position.y = 1.1 + sin(_time * 2.2) * 0.15


func _on_body_entered(body: Node3D) -> void:
	if _taken or not body.is_in_group("gs_player"):
		return
	_taken = true
	collected.emit(item_id, kind)

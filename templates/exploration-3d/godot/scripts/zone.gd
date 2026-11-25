extends Area3D
## Reports when the player walks into the zone.

signal entered(zone_id: String)

var zone_id := ""


func setup(new_id: String) -> void:
	zone_id = new_id


func _ready() -> void:
	body_entered.connect(_on_body_entered)


func _on_body_entered(body: Node3D) -> void:
	if body.is_in_group("gs_player"):
		entered.emit(zone_id)

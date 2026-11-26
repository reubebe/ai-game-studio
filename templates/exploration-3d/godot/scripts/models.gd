extends RefCounted
## Imported glTF models (res://assets/...): loading, measuring, fitting a character to a height and
## playing its animations by name. Shared by the level builder (scenery and villagers) and the player.

const Humanoid := preload("res://scripts/humanoid.gd")

## Words that name each movement state in animation names, most specific first (see guessClips in
## packages/explore/src/world.ts, which the studio uses for the same choice).
const HINTS := {
	"idle": ["idle", "stand", "breath", "survey", "wait", "rest"],
	"walk": ["walk", "move", "stroll"],
	"run": ["run", "sprint", "jog", "gallop"],
	"jump": ["jump", "fall", "air", "leap"],
}


## A new instance of the model at `rel` (a path under the project, such as assets/models/x.glb), or null.
static func instance(rel: String) -> Node3D:
	if rel == "" or rel.contains("..") or rel.begins_with("/"):
		return null
	var path := "res://" + rel
	if not ResourceLoader.exists(path):
		return null
	var scene := load(path) as PackedScene
	if scene == null:
		return null
	return scene.instantiate() as Node3D


## The box around every mesh under `node`, in the coordinates `xform` maps to.
static func bounds(node: Node, xform: Transform3D = Transform3D.IDENTITY) -> AABB:
	var t := xform
	if node is Node3D:
		t = xform * (node as Node3D).transform
	var out := AABB()
	var first := true
	if node is VisualInstance3D:
		out = t * _drawn_box(node as VisualInstance3D)
		first = false
	for child in node.get_children():
		var cb := bounds(child, t)
		if cb.size == Vector3.ZERO:
			continue
		if first:
			out = cb
			first = false
		else:
			out = out.merge(cb)
	return out


## A mesh's box where it is drawn. A skinned mesh is drawn where its skeleton's rest pose puts it, which
## can be far from its own box: converted Rocketbox people stood 0.86 m below their box, sunk to the knees.
## level3d.ts gets the same from three's skinned bounding box.
static func _drawn_box(v: VisualInstance3D) -> AABB:
	var box := v.get_aabb()
	var mi := v as MeshInstance3D
	if mi == null or mi.skin == null or mi.skin.get_bind_count() == 0:
		return box
	var sk := mi.get_node_or_null(mi.skeleton) as Skeleton3D
	if sk == null:
		return box
	var bone := mi.skin.get_bind_bone(0)
	if bone < 0:
		bone = sk.find_bone(mi.skin.get_bind_name(0))
	if bone < 0 or bone >= sk.get_bone_count():
		return box
	# Skeleton space to the mesh's space, then the bind: where the rest pose draws the mesh.
	var to_mesh := relative_transform(null, mi).affine_inverse() * relative_transform(null, sk)
	return to_mesh * sk.get_bone_global_rest(bone) * mi.skin.get_bind_pose(0) * box


## Scales `inst` so it is `height` metres tall and stands with its lowest point on its parent's origin.
static func fit_height(inst: Node3D, height: float) -> void:
	inst.scale = Vector3.ONE
	var box := bounds(inst, Transform3D.IDENTITY)
	if box.size.y <= 0.00001:
		return
	var s := height / box.size.y
	inst.scale = Vector3.ONE * s
	inst.position.y = -box.position.y * s


## Scales `inst` evenly so its largest side is `size` metres, centred over its parent's origin and standing
## on it: a pushable block's model fills its block. level3d.ts (fitBox) fits it the same way.
static func fit_box(inst: Node3D, size: float) -> void:
	inst.scale = Vector3.ONE
	inst.position = Vector3.ZERO
	var box := bounds(inst, Transform3D.IDENTITY)
	var largest := maxf(box.size.x, maxf(box.size.y, box.size.z))
	if largest <= 0.00001:
		return
	var s := size / largest
	var centre := box.get_center()
	inst.scale = Vector3.ONE * s
	inst.position = Vector3(-centre.x * s, -box.position.y * s, -centre.z * s)


## The parts of a gate model that make up its door: each outermost node whose name contains "Door".
## They sink with the door when the gate opens. level3d.ts (doorParts) finds the same ones.
static func door_parts(node: Node) -> Array[Node3D]:
	var out: Array[Node3D] = []
	for child in node.get_children():
		if child is Node3D and String(child.name).contains("Door"):
			out.append(child as Node3D)
		else:
			out.append_array(door_parts(child))
	return out


## Where `node` sits relative to `ancestor` (the product of the transforms between them).
static func relative_transform(ancestor: Node, node: Node3D) -> Transform3D:
	var t := node.transform
	var n := node.get_parent()
	while n != null and n != ancestor:
		if n is Node3D:
			t = (n as Node3D).transform * t
		n = n.get_parent()
	return t


## Scales a gate model evenly so its door is `width` metres wide (without a door: so the whole gate is
## `width` + 1.8 m wide, the built-in gate's size) and stands it on its parent's origin. level3d.ts: fitGate.
static func fit_gate(inst: Node3D, width: float) -> void:
	inst.scale = Vector3.ONE
	inst.position = Vector3.ZERO
	var box := bounds(inst, Transform3D.IDENTITY)
	var span := box.size.x
	var target := width + 1.8
	var door := AABB()
	var first := true
	for piece in door_parts(inst):
		var pb := bounds(piece, inst.transform * relative_transform(inst, piece) * piece.transform.affine_inverse())
		if pb.size == Vector3.ZERO:
			continue
		door = pb if first else door.merge(pb)
		first = false
	if not first and door.size.x > 0.00001:
		span = door.size.x
		target = width
	if span <= 0.00001:
		return
	var s := target / span
	inst.scale = Vector3.ONE * s
	inst.position = Vector3(0.0, -box.position.y * s, 0.0)


## The model's AnimationPlayer: the first under `node`, given Idle, Walk, Run and Jump when the model is a
## humanoid without walking or running of its own (VRoid characters; humanoid.gd). Null when it has none.
static func animation_player(node: Node) -> AnimationPlayer:
	var ap := _find_player(node)
	if resolve(ap, "", "walk") == "" and resolve(ap, "", "run") == "":
		ap = Humanoid.add_clips(node, ap)
	return ap


static func _find_player(node: Node) -> AnimationPlayer:
	if node is AnimationPlayer:
		return node
	for child in node.get_children():
		var found := _find_player(child)
		if found != null:
			return found
	return null


static func _plain(name: String) -> String:
	var out := ""
	for c in name.to_lower():
		if (c >= "a" and c <= "z") or (c >= "0" and c <= "9"):
			out += c
	return out


## The animation in `ap` called `wanted` (compared without case or punctuation, since importers may
## rename "Armature|Walk"), or, when nothing is named, the one whose name suggests `state`.
static func resolve(ap: AnimationPlayer, wanted: String, state: String = "") -> String:
	if ap == null:
		return ""
	var names := ap.get_animation_list()
	if wanted != "":
		if ap.has_animation(wanted):
			return wanted
		for n in names:
			if _plain(n) == _plain(wanted) or _plain(n).ends_with(_plain(wanted)):
				return n
		return ""
	for hint in HINTS.get(state, []):
		for n in names:
			var plain := _plain(n)
			if plain.contains(hint) and (state == "jump" or not plain.contains("jump")):
				return n
	return ""


## Plays `clip` (looping, or once and holding its last frame), blending from the current one.
static func play(ap: AnimationPlayer, clip: String, loop: bool = true, blend: float = 0.2) -> bool:
	if ap == null or clip == "" or not ap.has_animation(clip):
		return false
	var anim := ap.get_animation(clip)
	anim.loop_mode = Animation.LOOP_LINEAR if loop else Animation.LOOP_NONE
	if ap.current_animation != clip or not ap.is_playing():
		ap.play(clip, blend)
	return true

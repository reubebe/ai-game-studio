extends RefCounted
## Walking, running, standing and jumping for humanoid characters that come without them, such as VRoid
## (VRM) characters: their importer names the bones after Godot's humanoid profile (Hips, Spine,
## LeftUpperLeg...). The poses are data (humanoid_poses.json): each bone turns about the character's own
## axes (left, up, forward, measured from its skeleton) starting from its T-pose, so they fit any humanoid
## whatever its bones' own axes. The studio's 3D view makes the same motion (look.ts): keep them in step.

const POSES_PATH := "res://scripts/humanoid_poses.json"
## Bones a skeleton needs for the clips to fit.
const NEEDED := ["Hips", "Spine", "Head", "LeftUpperLeg", "LeftLowerLeg", "RightUpperLeg", "RightLowerLeg", "LeftUpperArm", "LeftLowerArm", "RightUpperArm", "RightLowerArm"]
## Samples per second written into each clip.
const RATE := 30.0


## The humanoid skeleton under `node` (one with every NEEDED bone), or null.
static func skeleton(node: Node) -> Skeleton3D:
	if node is Skeleton3D:
		var sk := node as Skeleton3D
		var ok := true
		for b in NEEDED:
			if sk.find_bone(b) < 0:
				ok = false
				break
		if ok:
			return sk
	for child in node.get_children():
		var found := skeleton(child)
		if found != null:
			return found
	return null


## Adds Idle, Walk, Run and Jump to the character's AnimationPlayer (making one if it has none) when it has a
## humanoid skeleton and no walking or running of its own. Returns the AnimationPlayer, or null.
static func add_clips(root: Node, ap: AnimationPlayer) -> AnimationPlayer:
	var sk := skeleton(root)
	if sk == null:
		return ap
	if ap == null:
		ap = AnimationPlayer.new()
		ap.name = "AnimationPlayer"
		root.add_child(ap)
	var poses := _poses()
	var clips: Dictionary = poses.get("clips", {})
	var lib: AnimationLibrary
	if ap.has_animation_library(""):
		lib = ap.get_animation_library("")
	else:
		lib = AnimationLibrary.new()
		ap.add_animation_library("", lib)
	var base := ap.get_node(ap.root_node).get_path_to(sk)
	var frame := _frame(sk)
	for clip_name in clips:
		if lib.has_animation(clip_name):
			continue
		lib.add_animation(clip_name, _clip(sk, String(base), frame, clips[clip_name]))
	return ap


static func _poses() -> Dictionary:
	var text := FileAccess.get_file_as_string(POSES_PATH)
	var parsed = JSON.parse_string(text)
	return parsed if typeof(parsed) == TYPE_DICTIONARY else {}


## The character's axes in skeleton space: left (from the right hip to the left), up (from the hips to the
## head) and forward (left x up), and the leg's length.
static func _frame(sk: Skeleton3D) -> Dictionary:
	var g := func(name: String) -> Vector3: return sk.get_bone_global_rest(sk.find_bone(name)).origin
	var up: Vector3 = (g.call("Head") - g.call("Hips")).normalized()
	var left: Vector3 = g.call("LeftUpperLeg") - g.call("RightUpperLeg")
	left = (left - up * left.dot(up)).normalized()
	var forward := left.cross(up).normalized()
	var foot := "LeftFoot" if sk.find_bone("LeftFoot") >= 0 else "LeftLowerLeg"
	var leg: float = (g.call("Hips") - g.call(foot)).length()
	return {"left": left, "up": up, "forward": forward, "leg": maxf(leg, 0.01)}


static func _angle(spec: Array, t: float, length: float) -> float:
	var a := float(spec[1]) + float(spec[2]) * sin(TAU * (float(spec[4]) * t / length + float(spec[3])))
	if spec.size() > 5:
		a = maxf(a, float(spec[5]))
	return deg_to_rad(a)


## The bone's own turn at time t: its listed turns about the character's axes, in order.
static func _own(turns: Array, frame: Dictionary, t: float, length: float) -> Basis:
	var b := Basis.IDENTITY
	for spec in turns:
		var axis: Vector3 = frame.get(str(spec[0]), Vector3.UP)
		b = Basis(axis, _angle(spec, t, length)) * b
	return b


static func _clip(sk: Skeleton3D, base: String, frame: Dictionary, spec: Dictionary) -> Animation:
	var anim := Animation.new()
	var length := float(spec.get("length", 1.0))
	anim.length = length
	anim.loop_mode = Animation.LOOP_LINEAR if bool(spec.get("loop", true)) else Animation.LOOP_NONE
	var bones: Dictionary = spec.get("bones", {})
	var steps := maxi(2, int(round(length * RATE)))
	# Every bone between the hips and the bones that turn gets a track, so turns add up down the chain.
	var tracks := {}
	for name in bones:
		var i := sk.find_bone(name)
		while i >= 0:
			tracks[i] = true
			i = sk.get_bone_parent(i)
	for i in tracks:
		var track := anim.add_track(Animation.TYPE_ROTATION_3D)
		anim.track_set_path(track, NodePath("%s:%s" % [base, sk.get_bone_name(i)]))
		var parent := sk.get_bone_parent(i)
		var rest := sk.get_bone_global_rest(i).basis.orthonormalized()
		var parent_rest := sk.get_bone_global_rest(parent).basis.orthonormalized() if parent >= 0 else Basis.IDENTITY
		for s in steps + 1:
			var t := length * float(s) / float(steps)
			var total := _total(sk, i, bones, frame, t, length)
			var parent_total := _total(sk, parent, bones, frame, t, length) if parent >= 0 else Basis.IDENTITY
			var local := parent_rest.inverse() * parent_total.inverse() * total * rest
			anim.rotation_track_insert_key(track, t, local.get_rotation_quaternion())
	var hips := sk.find_bone("Hips")
	var move: Dictionary = spec.get("hips", {})
	if hips >= 0 and not move.is_empty():
		var track := anim.add_track(Animation.TYPE_POSITION_3D)
		anim.track_set_path(track, NodePath("%s:Hips" % base))
		var parent := sk.get_bone_parent(hips)
		var to_parent := sk.get_bone_global_rest(parent).basis.orthonormalized().inverse() if parent >= 0 else Basis.IDENTITY
		var rest_pos := sk.get_bone_rest(hips).origin
		# A retargeted skeleton (Godot's VRM import) scales every position key by its motion_scale; without
		# undoing it Godette walked 0.21 m low, sunk to the ankles.
		var unscale := 1.0 / sk.motion_scale if sk.motion_scale > 0.00001 else 1.0
		for s in steps + 1:
			var t := length * float(s) / float(steps)
			var offset := Vector3.ZERO
			for axis in move:
				var m: Array = move[axis]
				var amount := float(m[0]) + float(m[1]) * sin(TAU * (float(m[3]) * t / length + float(m[2])))
				offset += (frame.get(axis, Vector3.UP) as Vector3) * amount * float(frame["leg"])
			anim.position_track_insert_key(track, t, (rest_pos + to_parent * offset) * unscale)
	return anim


## A bone's turn in skeleton space at time t: its own turns after its parents' (turns down the chain add up).
static func _total(sk: Skeleton3D, bone: int, bones: Dictionary, frame: Dictionary, t: float, length: float) -> Basis:
	var chain: Array[int] = []
	var i := bone
	while i >= 0:
		chain.push_front(i)
		i = sk.get_bone_parent(i)
	var total := Basis.IDENTITY
	for b in chain:
		var turns: Array = bones.get(sk.get_bone_name(b), [])
		if not turns.is_empty():
			total = _own(turns, frame, t, length) * total
	return total

extends SceneTree
## Turns a Rocketbox person (an FBX, its .tga textures and separate FBX animations) into one .glb with its
## textures (at most `size` pixels across) and its animations named Idle, Walk and Run, so Game Studio can
## use it like any glTF character. Run by Game Studio after downloading the files:
##   godot --headless --path <empty project> --script convert_character.gd -- <dir> <person.fbx> <out.glb> <size> Idle=<fbx> Walk=<fbx> Run=<fbx>
## Prints CONVERTED <json> on success, CONVERT_FAILED <reason> otherwise.

func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	if args.size() < 4:
		_fail("expected: <dir> <person.fbx> <out.glb> <size> Name=<animation.fbx>...")
		return
	var dir := args[0]
	var person := args[1]
	var out := args[2]
	var size := maxi(256, int(args[3]))
	var root := _load(dir.path_join(person), dir)
	if root == null:
		_fail("%s could not be read" % person)
		return
	var textured := _texture(root, dir, size)
	var sk := _skeleton(root)
	var ap := _player(root)
	var lib: AnimationLibrary = ap.get_animation_library("") if ap.has_animation_library("") else AnimationLibrary.new()
	if not ap.has_animation_library(""):
		ap.add_animation_library("", lib)
	for name in lib.get_animation_list():
		lib.remove_animation(name)
	var clips := []
	for spec in args.slice(4):
		var kv := String(spec).split("=", true, 1)
		if kv.size() != 2:
			continue
		var anim := _animation(dir.path_join(kv[1]), dir, sk, root.get_path_to(sk) if sk else NodePath("Skeleton3D"))
		if anim == null:
			_fail("%s could not be read" % kv[1])
			return
		anim.loop_mode = Animation.LOOP_LINEAR
		lib.add_animation(kv[0], anim)
		clips.append(kv[0])
	var bones := sk.get_bone_count() if sk else 0
	var doc := GLTFDocument.new()
	var state := GLTFState.new()
	var err := doc.append_from_scene(root, state)
	if err == OK:
		err = doc.write_to_filesystem(state, out)
	root.free()
	if err != OK:
		_fail("writing %s failed (%d)" % [out, err])
		return
	print("CONVERTED ", JSON.stringify({"clips": clips, "textured": textured, "bones": bones}))
	quit()


func _fail(reason: String) -> void:
	print("CONVERT_FAILED ", reason)
	quit(1)


func _load(path: String, dir: String) -> Node:
	var doc := FBXDocument.new()
	var st := FBXState.new()
	if doc.append_from_file(path, st, 0, dir) != OK:
		return null
	return doc.generate_scene(st)


func _skeleton(n: Node) -> Skeleton3D:
	if n is Skeleton3D:
		return n
	for c in n.get_children():
		var s := _skeleton(c)
		if s != null:
			return s
	return null


func _player(root: Node) -> AnimationPlayer:
	for c in root.get_children():
		if c is AnimationPlayer:
			return c
	var ap := AnimationPlayer.new()
	ap.name = "AnimationPlayer"
	root.add_child(ap)
	ap.owner = root
	return ap


## Rocketbox materials are named <set>_body, <set>_head and <set>_opacity; their textures are
## <set>_body_color.tga, <set>_body_normal.tga, <set>_head_... and <set>_opacity_color.tga (colour with
## the hair's and eyelashes' outline in its alpha). Godot's FBX reader cannot open .tga outside the editor,
## so they are read here and shrunk to `size`.
func _texture(n: Node, dir: String, size: int) -> int:
	var count := 0
	if n is MeshInstance3D:
		var mi := n as MeshInstance3D
		for i in mi.mesh.get_surface_count():
			var m := mi.get_active_material(i)
			if not (m is StandardMaterial3D):
				continue
			var sm := (m as StandardMaterial3D).duplicate() as StandardMaterial3D
			var base := String(sm.resource_name)
			var opacity := base.ends_with("_opacity")
			var color := _image(dir.path_join(base + "_color.tga"), size)
			if color != null:
				sm.albedo_texture = ImageTexture.create_from_image(color)
				sm.albedo_color = Color.WHITE
				count += 1
			var normal := _image(dir.path_join(base + "_normal.tga"), size)
			if normal != null:
				sm.normal_enabled = true
				sm.normal_texture = ImageTexture.create_from_image(normal)
			sm.roughness = 0.75
			sm.metallic = 0.0
			if opacity:
				sm.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA_SCISSOR
				sm.alpha_scissor_threshold = 0.4
				sm.cull_mode = BaseMaterial3D.CULL_DISABLED
			mi.set_surface_override_material(i, sm)
			mi.mesh.surface_set_material(i, sm)
	for c in n.get_children():
		count += _texture(c, dir, size)
	return count


func _image(path: String, size: int) -> Image:
	if not FileAccess.file_exists(path):
		return null
	var img := Image.load_from_file(path)
	if img == null or img.is_empty():
		return null
	var longest := maxi(img.get_width(), img.get_height())
	if longest > size:
		img.resize(img.get_width() * size / longest, img.get_height() * size / longest, Image.INTERPOLATE_LANCZOS)
	img.generate_mipmaps()
	return img


## The first animation in an FBX of the same rig, with tracks only for bones this person has, pointed at
## this person's skeleton.
func _animation(path: String, dir: String, sk: Skeleton3D, sk_path: NodePath) -> Animation:
	var scene := _load(path, dir)
	if scene == null:
		return null
	var src: AnimationPlayer = null
	for c in scene.get_children():
		if c is AnimationPlayer:
			src = c
	if src == null or src.get_animation_list().is_empty():
		scene.free()
		return null
	var from := src.get_animation(src.get_animation_list()[0])
	var anim := Animation.new()
	anim.length = from.length
	for t in from.get_track_count():
		var p := from.track_get_path(t)
		var bone := p.get_concatenated_subnames()
		if sk == null or bone == "" or sk.find_bone(bone) < 0:
			continue
		var type := from.track_get_type(t)
		var nt := anim.add_track(type)
		anim.track_set_path(nt, NodePath("%s:%s" % [sk_path, bone]))
		anim.track_set_interpolation_type(nt, from.track_get_interpolation_type(t))
		# The skeleton's root keeps its place on the ground (some clips still travel forward); the stride,
		# sway and bounce are in the bones below it.
		var in_place := type == Animation.TYPE_POSITION_3D and sk.get_bone_parent(sk.find_bone(bone)) < 0
		var start = from.track_get_key_value(t, 0) if from.track_get_key_count(t) > 0 else null
		for k in from.track_get_key_count(t):
			var value = from.track_get_key_value(t, k)
			if in_place and start is Vector3 and value is Vector3:
				value = Vector3(start.x, value.y, start.z)
			anim.track_insert_key(nt, from.track_get_key_time(t, k), value)
	scene.free()
	return anim

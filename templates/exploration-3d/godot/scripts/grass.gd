extends Node3D
## Tufts of grass over the ground: more where it is lush and fewer where it is dry (the ground's
## patches), none in water or zones or at the very edge. Every tuft's place, turn and size come from a
## hash of its cell, so the studio's 3D view (level3d.ts, grassTufts) puts them in the same places:
## keep cell_size, hash01, patches, the rules in place_tufts and the tuft's shape in step with it.

const GrassShader := preload("res://shaders/grass.gdshader")
## Tufts are grouped in squares this many metres across, so the camera skips those out of view.
const CHUNK := 24.0
## Never more cells than this, however large the level (large levels get sparser grass).
const MAX_CELLS := 40000

var material: ShaderMaterial
var tufts := 0
## The first three tufts and the last ([x, z, turn, size]), for the self-test.
var sample: Array = []


## Metres between tufts for a density from 0 (none) to 1 (thick), on a level of the given size.
static func cell_size(density: float, width: float, depth: float) -> float:
	var cell := lerpf(1.6, 0.55, clampf(density, 0.0, 1.0))
	return maxf(cell, sqrt(width * depth / float(MAX_CELLS)))


## A number from 0 to 1 for a cell (i, j) and a salt, the same in GDScript and in TypeScript
## (32-bit integer arithmetic only).
static func hash01(i: int, j: int, salt: int) -> float:
	var h := (i * 374761393 + j * 668265263 + salt * 1274126177) & 0xFFFFFFFF
	h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
	h = h ^ (h >> 16)
	return float(h) / 4294967296.0


## x - floor(x), written out so GDScript and TypeScript round alike.
static func _fract(x: float) -> float:
	return x - floorf(x)


static func _hash2(x: float, y: float) -> float:
	var px := _fract(x * 123.34)
	var py := _fract(y * 456.21)
	var d := px * (px + 45.32) + py * (py + 45.32)
	px += d
	py += d
	return _fract(px * py)


static func _value_noise(x: float, y: float) -> float:
	var ix := floorf(x)
	var iy := floorf(y)
	var fx := x - ix
	var fy := y - iy
	var ux := fx * fx * (3.0 - 2.0 * fx)
	var uy := fy * fy * (3.0 - 2.0 * fy)
	var a := _hash2(ix, iy)
	var b := _hash2(ix + 1.0, iy)
	var c := _hash2(ix, iy + 1.0)
	var d := _hash2(ix + 1.0, iy + 1.0)
	return lerpf(lerpf(a, b, ux), lerpf(c, d, ux), uy)


## The ground's patches (0 lush to 1 dry), as ground.gdshader computes them.
static func patches(x: float, z: float) -> float:
	var px := x / 16.0
	var pz := z / 16.0
	return _value_noise(px, pz) * 0.6 + _value_noise(px * 2.7 + 7.1, pz * 2.7 + 7.1) * 0.28 + _value_noise(px * 7.3 + 3.7, pz * 7.3 + 3.7) * 0.12


## Where the tufts go: [x, z, turn in radians, size] for each. keep_out: [x, z, radius] circles.
static func place_tufts(width: float, depth: float, density: float, variation: float, keep_out: Array) -> Array:
	var out := []
	if density <= 0.0:
		return out
	var cell := cell_size(density, width, depth)
	var nx := int(floor(width / cell))
	var nz := int(floor(depth / cell))
	var x0 := -width / 2.0
	var z0 := -depth / 2.0
	for i in nx:
		for j in nz:
			var x := x0 + (float(i) + 0.15 + 0.7 * hash01(i, j, 1)) * cell
			var z := z0 + (float(j) + 0.15 + 0.7 * hash01(i, j, 2)) * cell
			if absf(x) > width / 2.0 - 0.5 or absf(z) > depth / 2.0 - 0.5:
				continue
			var dry := smoothstep(0.3, 0.7, patches(x, z)) * variation
			if hash01(i, j, 3) > 0.9 - 0.55 * dry:
				continue
			var blocked := false
			for k in keep_out:
				var dx := x - float(k[0])
				var dz := z - float(k[1])
				if dx * dx + dz * dz < float(k[2]) * float(k[2]):
					blocked = true
					break
			if blocked:
				continue
			out.append([x, z, hash01(i, j, 4) * TAU, 0.75 + 0.55 * hash01(i, j, 5)])
	return out


## One tuft: nine thin blades leaning out from a small circle (UV.y: 0 at the foot, 1 at the tip).
static func tuft_mesh() -> ArrayMesh:
	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)
	for k in 9:
		var a := float(k) / 9.0 * TAU + 0.4 * sin(float(k) * 2.3)
		var dir := Vector3(cos(a), 0.0, sin(a))
		var side := Vector3(-dir.z, 0.0, dir.x)
		var h := 0.26 + 0.22 * _fract(float(k) * 0.618)
		var foot := dir * (0.04 + 0.05 * _fract(float(k) * 0.43))
		var w := 0.03
		var tip := foot + dir * (0.1 + 0.08 * _fract(float(k) * 0.37)) + Vector3(0.0, h, 0.0) + side * 0.03
		st.set_normal(Vector3.UP)
		st.set_uv(Vector2(0.0, 0.0))
		st.add_vertex(foot - side * w)
		st.set_uv(Vector2(1.0, 0.0))
		st.add_vertex(foot + side * w)
		st.set_uv(Vector2(0.5, 1.0))
		st.add_vertex(tip)
	return st.commit()


func build(width: float, depth: float, density: float, variation: float, ground_color: Color, keep_out: Array) -> void:
	name = "Grass"
	material = ShaderMaterial.new()
	material.shader = GrassShader
	material.set_shader_parameter("ground_color", ground_color)
	material.set_shader_parameter("variation", variation)
	var mesh := tuft_mesh()
	var chunks := {}
	var placed := place_tufts(width, depth, density, variation, keep_out)
	sample = placed.slice(0, 3)
	if placed.size() > 3:
		sample.append(placed[placed.size() - 1])
	for t in placed:
		var key := Vector2i(int(floor((float(t[0]) + width / 2.0) / CHUNK)), int(floor((float(t[1]) + depth / 2.0) / CHUNK)))
		if not chunks.has(key):
			chunks[key] = []
		(chunks[key] as Array).append(t)
	for key in chunks:
		var list: Array = chunks[key]
		var mm := MultiMesh.new()
		mm.transform_format = MultiMesh.TRANSFORM_3D
		mm.mesh = mesh
		mm.instance_count = list.size()
		for n in list.size():
			var t: Array = list[n]
			var s := float(t[3])
			mm.set_instance_transform(n, Transform3D(Basis(Vector3.UP, float(t[2])).scaled(Vector3(s, s, s)), Vector3(float(t[0]), 0.0, float(t[1]))))
		var mmi := MultiMeshInstance3D.new()
		mmi.multimesh = mm
		mmi.material_override = material
		mmi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
		add_child(mmi)
		tufts += list.size()

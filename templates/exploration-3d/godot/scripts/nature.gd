extends RefCounted
## Detailed trees and rocks for the realistic style (world_builder.gd, _nature), built from numbers
## (no model files): bark tubes that branch, two-sided leaf cards showing the leaf picture
## (leaf_atlas.gd), and rocks with broken faces, dark crevices and moss on top. The studio's 3D view
## builds the same meshes with packages/explore/src/nature.ts, call for call: change the two together
## (the Godot integration test compares them). Triangles are listed counter-clockwise seen from
## outside, as three.js wants them, and flipped for Godot when the mesh is made. Colours are screen
## colours (sRGB): the web renderer treats a material's colour as one and converts it at the end, so the
## materials say vertex_color_is_srgb, which makes Forward+ convert them first and the two agree.

const Grass := preload("res://scripts/grass.gd")
const LeafAtlas := preload("res://scripts/leaf_atlas.gd")
## How many shapes each kind of tree and the rock come in; an object's id picks one.
const VARIANTS := 4
## Where the leaf picture's halves are: u, v, width, height.
const BROAD := [0.0, 0.0, 0.5, 1.0]
const NEEDLES := [0.5, 0.0, 0.5, 1.0]
## Bark colours (screen colours, 0 to 1) and leaf tints.
const BARK_ROUND := [0.4, 0.31, 0.23]
const BARK_PINE := [0.35, 0.26, 0.2]
const BARK_BAOBAB := [0.6, 0.53, 0.47]
const LEAF_ROUND := [1.0, 1.0, 1.0]
const LEAF_PINE := [0.92, 1.0, 0.95]
const LEAF_BAOBAB := [1.05, 1.08, 0.82]
const ROCK_RINGS := 16
const ROCK_SEGMENTS := 28

static var _meshes := {}
static var _materials := {}
static var _atlas: Texture2D = null


## Mesh data being built.
class Buf:
	var pos := PackedVector3Array()
	var nrm := PackedVector3Array()
	var col := PackedColorArray()
	var uv := PackedVector2Array()
	var idx := PackedInt32Array()

	func vertex(p: Vector3, n: Vector3, c: Color, u: float = 0.0, v: float = 0.0) -> int:
		pos.append(p)
		nrm.append(n)
		col.append(Color(clampf(c.r, 0.0, 1.0), clampf(c.g, 0.0, 1.0), clampf(c.b, 0.0, 1.0)))
		uv.append(Vector2(u, v))
		return pos.size() - 1

	func tri(a: int, b: int, c: int) -> void:
		idx.append(a)
		idx.append(b)
		idx.append(c)


## Numbers from 0 to 1: grass.gd's hash01(start, 1, 9137), then (start, 2, 9137) and so on, the same
## sequence as nature.ts's rng.
class Rng:
	var start := 0
	var n := 0

	func _init(s: int) -> void:
		start = s

	func next() -> float:
		n += 1
		var h := (start * 374761393 + n * 668265263 + 9137 * 1274126177) & 0xFFFFFFFF
		h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
		h = h ^ (h >> 16)
		return float(h) / 4294967296.0

	func between(a: float, b: float) -> float:
		return a + (b - a) * next()


## 32-bit FNV-1a of the id's UTF-8 bytes (nature.ts, seedOf).
static func seed_of(id: String) -> int:
	var h := 2166136261
	for b in id.to_utf8_buffer():
		h = ((h ^ b) * 16777619) & 0xFFFFFFFF
	return h


## Which of the VARIANTS shapes an object gets.
static func variant_of(id: String) -> int:
	return seed_of(id) % VARIANTS


## An object's own turn about its middle, in radians (counter-clockwise seen from above), so neighbours differ.
static func turn_of(id: String) -> float:
	return Grass.hash01(seed_of(id), 1, 4421) * TAU


# ---- small maths, written out as nature.ts does it ---------------------------------------------

static func _smoothstep(a: float, b: float, x: float) -> float:
	var s := clampf((x - a) / (b - a), 0.0, 1.0)
	return s * s * (3.0 - 2.0 * s)


static func _smooth(t: float) -> float:
	return t * t * (3.0 - 2.0 * t)


static func _lattice(i: int, j: int, k: int, s: int) -> float:
	return Grass.hash01(i, j, k * 92821 + s)


## Value noise in 3D, from 0 to 1.
static func noise3(x: float, y: float, z: float, s: int) -> float:
	var fx := floorf(x)
	var fy := floorf(y)
	var fz := floorf(z)
	var i := int(fx)
	var j := int(fy)
	var k := int(fz)
	var ux := _smooth(x - fx)
	var uy := _smooth(y - fy)
	var uz := _smooth(z - fz)
	var a := lerpf(_lattice(i, j, k, s), _lattice(i + 1, j, k, s), ux)
	var b := lerpf(_lattice(i, j + 1, k, s), _lattice(i + 1, j + 1, k, s), ux)
	var c := lerpf(_lattice(i, j, k + 1, s), _lattice(i + 1, j, k + 1, s), ux)
	var d := lerpf(_lattice(i, j + 1, k + 1, s), _lattice(i + 1, j + 1, k + 1, s), ux)
	return lerpf(lerpf(a, b, uy), lerpf(c, d, uy), uz)


## Four octaves of noise3, from about -1 to 1.
static func _fbm3(x: float, y: float, z: float, s: int) -> float:
	var sum := 0.0
	var amp := 0.5
	var f := 1.0
	for o in 4:
		sum += amp * (noise3(x * f, y * f, z * f, s + o) * 2.0 - 1.0)
		amp *= 0.5
		f *= 2.0
	return sum / 0.9375


# ---- rocks --------------------------------------------------------------------------------------

## A rock about 1.8 m across and 1 m tall, its bottom 0.2 m under the ground.
static func _rock(variant: int) -> Buf:
	var r := Rng.new(11001 + variant)
	var ox := r.between(0.0, 50.0)
	var oy := r.between(0.0, 50.0)
	var oz := r.between(0.0, 50.0)
	var sx := r.between(0.9, 1.2)
	var sy := r.between(0.55, 0.75)
	var sz := r.between(0.8, 1.1)
	# Flat broken faces: where a plane cuts closer than the rounded shape.
	var planes := []
	for p in 5:
		var a := r.next() * TAU
		var e := r.between(-0.25, 0.95)
		var c := r.between(0.74, 0.92)
		planes.append([cos(e) * cos(a), sin(e), cos(e) * sin(a), c])
	var warm := r.next()
	var bright := r.between(0.85, 1.08)
	var moss := r.between(-0.3, 1.0)
	var base := [(0.5 + 0.07 * warm) * bright, (0.51 + 0.01 * warm) * bright, (0.51 - 0.06 * warm) * bright]

	var dx := PackedFloat64Array([0.0])
	var dy := PackedFloat64Array([1.0])
	var dz := PackedFloat64Array([0.0])
	for i in range(1, ROCK_RINGS):
		var th := PI * i / ROCK_RINGS
		for j in ROCK_SEGMENTS:
			var ph := TAU * j / ROCK_SEGMENTS
			dx.append(sin(th) * cos(ph))
			dy.append(cos(th))
			dz.append(sin(th) * sin(ph))
	dx.append(0.0)
	dy.append(-1.0)
	dz.append(0.0)
	var count := dx.size()
	var px := PackedFloat64Array()
	var py := PackedFloat64Array()
	var pz := PackedFloat64Array()
	var fine := PackedFloat64Array()
	for v in count:
		var x := dx[v]
		var y := dy[v]
		var z := dz[v]
		var detail := _fbm3(x * 4.5 + oz, y * 4.5 + ox, z * 4.5 + oy, 31)
		var rad := 1.0 + 0.26 * _fbm3(x * 1.4 + ox, y * 1.4 + oy, z * 1.4 + oz, 17) + 0.06 * detail
		for p in planes:
			var k: float = x * p[0] + y * p[1] + z * p[2]
			if k > 0.05:
				rad = minf(rad, p[3] / k)
		px.append(x * rad * sx)
		py.append(y * rad * sy)
		pz.append(z * rad * sz)
		fine.append(detail)
	# 0.92 m from the middle at its widest, 0.2 m sunk into the ground.
	var reach := 0.0
	var low := INF
	for v in count:
		reach = maxf(reach, sqrt(px[v] * px[v] + pz[v] * pz[v]))
		low = minf(low, py[v])
	var scale := 0.92 / reach
	var lift := -low * scale - 0.2
	for v in count:
		px[v] = px[v] * scale
		py[v] = py[v] * scale + lift
		pz[v] = pz[v] * scale

	var s := ROCK_SEGMENTS
	var last := count - 1
	var tris := PackedInt32Array()
	for j in s:
		tris.append(0)
		tris.append(1 + (j + 1) % s)
		tris.append(1 + j)
	for i in range(1, ROCK_RINGS - 1):
		for j in s:
			var a := 1 + (i - 1) * s + j
			var b := 1 + (i - 1) * s + (j + 1) % s
			tris.append(a)
			tris.append(b)
			tris.append(a + s)
			tris.append(b)
			tris.append(b + s)
			tris.append(a + s)
	for j in s:
		tris.append(1 + (ROCK_RINGS - 2) * s + j)
		tris.append(1 + (ROCK_RINGS - 2) * s + (j + 1) % s)
		tris.append(last)

	var nx := PackedFloat64Array()
	var ny := PackedFloat64Array()
	var nz := PackedFloat64Array()
	for v in count:
		nx.append(0.0)
		ny.append(0.0)
		nz.append(0.0)
	for t in range(0, tris.size(), 3):
		var a := tris[t]
		var b := tris[t + 1]
		var c := tris[t + 2]
		var ux := px[b] - px[a]
		var uy := py[b] - py[a]
		var uz := pz[b] - pz[a]
		var vx := px[c] - px[a]
		var vy := py[c] - py[a]
		var vz := pz[c] - pz[a]
		var fx := uy * vz - uz * vy
		var fy := uz * vx - ux * vz
		var fz := ux * vy - uy * vx
		for w in [a, b, c]:
			nx[w] = nx[w] + fx
			ny[w] = ny[w] + fy
			nz[w] = nz[w] + fz

	var buf := Buf.new()
	for v in count:
		var l := sqrt(nx[v] * nx[v] + ny[v] * ny[v] + nz[v] * nz[v])
		var up := ny[v] / l if l > 0.0 else 0.0
		var n := Vector3(nx[v] / l, up, nz[v] / l) if l > 0.0 else Vector3.ZERO
		var x := dx[v]
		var y := dy[v]
		var z := dz[v]
		var mottle := noise3(x * 6.0 + oy, y * 6.0 + oz, z * 6.0 + ox, 47)
		var shade := (0.8 + 0.36 * mottle) * clampf(1.0 + 2.2 * minf(fine[v], 0.0), 0.55, 1.0)
		var cr: float = base[0] * shade
		var cg: float = base[1] * shade
		var cb: float = base[2] * shade
		var m := clampf(moss, 0.0, 1.0) * _smoothstep(0.35, 0.8, up) * _smoothstep(0.42, 0.62, noise3(x * 3.0 + oz, y * 3.0 + ox, z * 3.0 + oy, 53))
		cr = lerpf(cr, 0.3, m)
		cg = lerpf(cg, 0.38, m)
		cb = lerpf(cb, 0.17, m)
		var ground := 0.55 + 0.45 * _smoothstep(-0.2, 0.3, py[v])
		buf.vertex(Vector3(px[v], py[v], pz[v]), n, Color(cr * ground, cg * ground, cb * ground))
	for t in range(0, tris.size(), 3):
		buf.tri(tris[t], tris[t + 1], tris[t + 2])
	return buf


# ---- trees --------------------------------------------------------------------------------------

## A bark tube through pts with the given radii, `sides` round, its colour varied by noise.
static func _tube(buf: Buf, pts: Array, radii: Array, sides: int, bark: Array, s: int, gnarl: float) -> void:
	var m := pts.size()
	var first := buf.pos.size()
	var t0: Vector3 = (pts[1] - pts[0]).normalized()
	var a := Vector3(1.0, 0.0, 0.0) if absf(t0.x) < 0.9 else Vector3(0.0, 0.0, 1.0)
	var b1 := t0.cross(a).normalized()
	for i in m:
		var t: Vector3
		if i == 0:
			t = (pts[1] - pts[0]).normalized()
		elif i == m - 1:
			t = (pts[m - 1] - pts[m - 2]).normalized()
		else:
			t = (pts[i + 1] - pts[i - 1]).normalized()
		b1 = (b1 - t * b1.dot(t)).normalized()
		var b2 := t.cross(b1)
		var p: Vector3 = pts[i]
		for k in sides:
			var ang := TAU * k / sides
			var dir := b1 * cos(ang) + b2 * sin(ang)
			var rad: float = radii[i] * (1.0 + gnarl * (noise3(dir.x * 1.5, p.y * 0.9, dir.z * 1.5, s) * 2.0 - 1.0))
			var q := p + dir * rad
			var shade := (0.78 + 0.4 * noise3(q.x * 2.5, q.y * 0.7, q.z * 2.5, s + 3)) * (0.6 + 0.4 * _smoothstep(-0.1, 0.6, q.y))
			buf.vertex(q, dir, Color(bark[0] * shade, bark[1] * shade, bark[2] * shade))
	for i in m - 1:
		for k in sides:
			var ia := first + i * sides + k
			var ib := first + i * sides + (k + 1) % sides
			buf.tri(ia, ib, ia + sides)
			buf.tri(ib, ib + sides, ia + sides)


## A leaf card: centre c, unit vectors a1 (across the picture) and a2 (up it), w by h metres, showing
## `region` of the leaf picture. Each corner's normal leans away from `away` (soft, rounded shading
## over the whole crown). Both sides are drawn, sharing the corners.
static func _card(buf: Buf, c: Vector3, a1: Vector3, a2: Vector3, w: float, h: float, region: Array, tint: Array, away: Vector3, bend: float) -> void:
	var nrm := a1.cross(a2)
	var u0: float = region[0]
	var v0: float = region[1]
	var du: float = region[2]
	var dv: float = region[3]
	var color := Color(tint[0], tint[1], tint[2])
	var at := buf.pos.size()
	for corner in [[-0.5, -0.5, u0, v0 + dv], [0.5, -0.5, u0 + du, v0 + dv], [0.5, 0.5, u0 + du, v0], [-0.5, 0.5, u0, v0]]:
		var p: Vector3 = c + (a1 * (corner[0] * w) + a2 * (corner[1] * h))
		var n := (nrm * (1.0 - bend) + (p - away).normalized() * bend).normalized()
		buf.vertex(p, n, color, corner[2], corner[3])
	buf.tri(at, at + 1, at + 2)
	buf.tri(at, at + 2, at + 3)
	buf.tri(at, at + 2, at + 1)
	buf.tri(at, at + 3, at + 2)


## Leaf cards round a clump's centre, more of them towards its outside.
static func _clump(buf: Buf, r: Rng, centre: Vector3, radius: float, crown: Vector3, region: Array, squash: float, size: float, tint: Array) -> void:
	var n := 6 + int(floorf(radius * 10.0))
	for i in n:
		var z := r.next() * 2.0 - 1.0
		var ph := r.next() * TAU
		var ring := sqrt(maxf(0.0, 1.0 - z * z))
		var u := Vector3(ring * cos(ph), z, ring * sin(ph))
		var q := 0.55 + 0.45 * r.next()
		var c := Vector3(centre.x + u.x * radius * q, centre.y + u.y * radius * q * squash, centre.z + u.z * radius * q)
		var jx := r.next() - 0.5
		var jy := r.next() - 0.5
		var jz := r.next() - 0.5
		var nrm := (u + Vector3(jx, jy, jz) * 0.9).normalized()
		var ref := Vector3(0.0, 1.0, 0.0) if absf(nrm.y) < 0.9 else Vector3(1.0, 0.0, 0.0)
		var t1 := ref.cross(nrm).normalized()
		var t2 := nrm.cross(t1)
		var al := r.next() * TAU
		var a1 := t1 * cos(al) + t2 * sin(al)
		var a2 := t2 * cos(al) - t1 * sin(al)
		var sz := size * r.between(0.8, 1.15)
		var g := r.between(0.8, 1.08)
		var hue := r.between(-0.05, 0.05)
		var out := (c - crown).normalized()
		var ao := (0.5 + 0.5 * q) * (0.62 + 0.38 * clampf(0.5 + 0.6 * out.y, 0.0, 1.0))
		_card(buf, c, a1, a2, sz, sz, region, [tint[0] * g * (1.0 + hue) * ao, tint[1] * g * ao, tint[2] * g * (1.0 - hue) * ao], crown, 0.65)


## A broad-leaved tree about 4.5 m tall: a trunk, four or five boughs with two twigs each, and clumps of leaves.
static func _round_tree(bark: Buf, leaves: Buf, r: Rng, s: int) -> void:
	var lean_a := r.next() * TAU
	var lean := r.between(0.0, 0.14)
	var lx := cos(lean_a) * lean
	var lz := sin(lean_a) * lean
	var trunk := []
	var radii := []
	for i in 7:
		var t := i / 6.0
		var y := -0.25 + 2.95 * t
		var f := maxf(0.0, 1.0 - y / 0.45)
		trunk.append(Vector3(lx * t * t * 2.95, y, lz * t * t * 2.95))
		radii.append(0.27 * (1.0 - 0.45 * t) + 0.16 * f * f)
	_tube(bark, trunk, radii, 10, BARK_ROUND, s, 0.06)
	var crown := Vector3(lx * 2.0, 3.2, lz * 2.0)
	var clumps := []
	var nb := 4 + int(floorf(r.next() * 2.0))
	var az0 := r.next() * TAU
	for b in nb:
		var h := 1.85 + 0.8 * b / (nb - 1) + r.between(-0.08, 0.08)
		var th := (h + 0.25) / 2.95
		var start := Vector3(lx * th * th * 2.95, -0.25 + 2.95 * th, lz * th * th * 2.95)
		var az := az0 + b * 2.39996 + r.between(-0.35, 0.35)
		var up := r.between(0.5, 1.0)
		var d := Vector3(cos(az), up, sin(az)).normalized()
		var length := r.between(0.7, 0.95)
		var pts := []
		var rr := []
		for k in 4:
			var u := k / 3.0
			pts.append(start + d * (length * u) + Vector3(0.0, 0.18 * length * u * u, 0.0))
			rr.append(lerpf(0.11, 0.025, u))
		_tube(bark, pts, rr, 6, BARK_ROUND, s + 10 + b, 0.0)
		clumps.append([pts[3], r.between(0.68, 0.82)])
		for sb in 2:
			var u0 := 0.5 + 0.3 * sb
			var base: Vector3 = start + d * (length * u0) + Vector3(0.0, 0.18 * length * u0 * u0, 0.0)
			var side := Vector3(-sin(az), 0.0, cos(az)) * (1.0 if sb == 0 else -1.0)
			var spread := r.between(0.4, 0.8)
			var rise := r.between(0.1, 0.4)
			var sd := (d + side * spread + Vector3(0.0, rise, 0.0)).normalized()
			var sl := r.between(0.3, 0.45)
			_tube(bark, [base, base + sd * (sl * 0.5), base + sd * sl], [0.045, 0.03, 0.012], 4, BARK_ROUND, s + 20 + b * 2 + sb, 0.0)
			clumps.append([base + sd * sl, r.between(0.48, 0.6)])
	clumps.append([trunk[6] + Vector3(0.0, 0.35, 0.0), r.between(0.72, 0.86)])
	for c in clumps:
		_clump(leaves, r, c[0], c[1], crown, BROAD, 1.0, 0.9, LEAF_ROUND)


## A pine about 6 m tall: a tapering trunk with whorls of drooping boughs covered in needles.
static func _pine_tree(bark: Buf, leaves: Buf, r: Rng, s: int) -> void:
	var lean_a := r.next() * TAU
	var lean := r.between(0.0, 0.08)
	var lx := cos(lean_a) * lean
	var lz := sin(lean_a) * lean
	var trunk := []
	var radii := []
	for i in 9:
		var t := i / 8.0
		var y := -0.2 + 6.1 * t
		var f := maxf(0.0, 1.0 - y / 0.35)
		trunk.append(_pine_at(lx, lz, y))
		radii.append(0.24 * (1.0 - t) + 0.012 + 0.12 * f * f)
	_tube(bark, trunk, radii, 8, BARK_PINE, s, 0.05)
	for w in 15:
		var y := 1.35 + 0.3 * w + r.between(-0.06, 0.06)
		var rel := (y - 1.35) / 4.5
		var start := _pine_at(lx, lz, y)
		var n := 5 + int(floorf(r.next() * 2.0))
		var length := 1.1 * pow(maxf(0.0, 1.0 - rel), 0.85) + 0.16
		for b in n:
			var az := w * 0.9 + b * TAU / n + r.between(-0.25, 0.25)
			var droop := r.between(-0.35, -0.12)
			var d := Vector3(cos(az), droop, sin(az)).normalized()
			var end := start + d * length + Vector3(0.0, 0.12 * length, 0.0)
			var mid := start + d * (length * 0.5) + Vector3(0.0, 0.03 * length, 0.0)
			var br := 0.035 * (1.0 - rel * 0.6)
			_tube(bark, [start, mid, end], [br, br * 0.6, 0.008], 4, BARK_PINE, s + 30 + w, 0.0)
			var along := (end - start).normalized()
			var across := Vector3(0.0, 1.0, 0.0).cross(along).normalized()
			var up := along.cross(across)
			for k in 3:
				var u := 0.25 + 0.3 * k
				var c := start.lerp(end, u)
				var beta := r.between(-0.5, 0.5)
				var g := r.between(0.85, 1.1)
				var ao := (0.55 + 0.45 * u) * (0.7 + 0.3 * rel) * g
				var away := Vector3(start.x, c.y - 0.6, start.z)
				for x in 2:
					var bb := beta + 1.25 * x
					var a2 := across * cos(bb) + up * sin(bb)
					_card(leaves, c, along, a2, length * 0.75 + 0.25, 0.5 + 0.3 * (1.0 - rel), NEEDLES, [LEAF_PINE[0] * ao, LEAF_PINE[1] * ao, LEAF_PINE[2] * ao], away, 0.7)
	var top: Vector3 = trunk[8]
	for k in 3:
		var az := k * TAU / 3.0 + r.next()
		_card(leaves, top + Vector3(0.0, -0.25, 0.0), Vector3(0.0, 1.0, 0.0), Vector3(cos(az), 0.0, sin(az)), 0.7, 0.55, NEEDLES, LEAF_PINE, Vector3(top.x, top.y - 1.0, top.z), 0.7)


## The pine's trunk at height y (it leans a little more towards the top).
static func _pine_at(lx: float, lz: float, y: float) -> Vector3:
	var t := (y + 0.2) / 6.1
	return Vector3(lx * t * t * 6.1, y, lz * t * t * 6.1)


## A baobab: a thick, folded trunk about 3.6 m tall with crooked boughs and a flat, open crown.
static func _baobab_tree(bark: Buf, leaves: Buf, r: Rng, s: int) -> void:
	var rb := r.between(0.78, 0.88)
	var trunk := []
	var radii := []
	for i in 8:
		var t := i / 7.0
		var y := -0.25 + 3.95 * t
		var f := maxf(0.0, 1.0 - y / 0.6)
		trunk.append(Vector3(0.0, y, 0.0))
		radii.append(rb * (1.15 - 0.38 * t + 0.14 * sin(PI * t)) + 0.3 * f * f)
	_tube(bark, trunk, radii, 14, BARK_BAOBAB, s, 0.1)
	var top_r: float = radii[7]
	var crown := Vector3(0.0, 4.1, 0.0)
	var nb := 6 + int(floorf(r.next() * 3.0))
	var az0 := r.next() * TAU
	for b in nb:
		var az := az0 + b * TAU / nb + r.between(-0.3, 0.3)
		var out := Vector3(cos(az), 0.0, sin(az))
		var start := Vector3(0.0, 3.5 + r.between(0.0, 0.2), 0.0) + out * (top_r * 0.55)
		var up := r.between(0.2, 0.45)
		var d := (out + Vector3(0.0, up, 0.0)).normalized()
		var length := r.between(1.0, 1.45)
		var side := Vector3(-out.z, 0.0, out.x)
		var pts := [start]
		var rr := [0.26]
		for k in range(1, 4):
			var u := k / 3.0
			var wob := r.between(-0.12, 0.12)
			pts.append(start + d * (length * u) + side * wob + Vector3(0.0, 0.12 * length * u * u, 0.0))
			rr.append(lerpf(0.26, 0.07, u))
		_tube(bark, pts, rr, 7, BARK_BAOBAB, s + 40 + b, 0.0)
		var tip: Vector3 = pts[3]
		_clump(leaves, r, tip + Vector3(0.0, 0.15, 0.0), r.between(0.55, 0.7), crown, BROAD, 0.55, 0.75, LEAF_BAOBAB)
		var base: Vector3 = pts[2]
		var spread := r.between(-0.9, 0.9)
		var sd := (d + side * spread + Vector3(0.0, 0.3, 0.0)).normalized()
		var sl := r.between(0.5, 0.8)
		_tube(bark, [base, base + sd * sl], [0.08, 0.03], 5, BARK_BAOBAB, s + 60 + b, 0.0)
		_clump(leaves, r, base + sd * sl + Vector3(0.0, 0.1, 0.0), r.between(0.4, 0.5), crown, BROAD, 0.55, 0.65, LEAF_BAOBAB)


# ---- meshes and materials -----------------------------------------------------------------------

## The meshes of one shape, made once: [rock] for a rock, [bark, leaves] for a tree.
static func meshes(kind: String, variant: int) -> Array:
	var key := "%s|%d" % [kind, variant]
	if _meshes.has(key):
		return _meshes[key]
	var made := []
	if kind == "rock":
		made = [_mesh(_rock(variant))]
	else:
		var start := (37001 if kind == "tall" else 51001 if kind == "baobab" else 23001) + variant
		var r := Rng.new(start)
		var bark := Buf.new()
		var leaves := Buf.new()
		if kind == "tall":
			_pine_tree(bark, leaves, r, start)
		elif kind == "baobab":
			_baobab_tree(bark, leaves, r, start)
		else:
			_round_tree(bark, leaves, r, start)
		made = [_mesh(bark), _mesh(leaves)]
	_meshes[key] = made
	return made


static func _mesh(b: Buf) -> ArrayMesh:
	var arrays := []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = b.pos
	arrays[Mesh.ARRAY_NORMAL] = b.nrm
	arrays[Mesh.ARRAY_COLOR] = b.col
	arrays[Mesh.ARRAY_TEX_UV] = b.uv
	# Godot's front faces wind clockwise.
	var idx := PackedInt32Array()
	for i in range(0, b.idx.size(), 3):
		idx.append(b.idx[i])
		idx.append(b.idx[i + 2])
		idx.append(b.idx[i + 1])
	arrays[Mesh.ARRAY_INDEX] = idx
	var mesh := ArrayMesh.new()
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	return mesh


## Bark and rock: their colours are in the mesh.
static func solid_material() -> StandardMaterial3D:
	if not _materials.has("solid"):
		var m := StandardMaterial3D.new()
		m.vertex_color_use_as_albedo = true
		m.vertex_color_is_srgb = true
		m.roughness = 0.92
		_materials["solid"] = m
	return _materials["solid"]


## Leaves: the leaf picture, cut out where it is clear, tinted by the mesh's colours.
static func leaf_material() -> StandardMaterial3D:
	if not _materials.has("leaves"):
		var m := StandardMaterial3D.new()
		m.albedo_texture = leaf_texture()
		m.vertex_color_use_as_albedo = true
		m.vertex_color_is_srgb = true
		m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA_SCISSOR
		m.alpha_scissor_threshold = 0.4
		m.roughness = 0.8
		m.texture_filter = BaseMaterial3D.TEXTURE_FILTER_LINEAR_WITH_MIPMAPS_ANISOTROPIC
		_materials["leaves"] = m
	return _materials["leaves"]


static func leaf_texture() -> Texture2D:
	if _atlas == null:
		var img := Image.new()
		img.load_png_from_buffer(Marshalls.base64_to_raw(LeafAtlas.PNG))
		img.generate_mipmaps()
		_atlas = ImageTexture.create_from_image(img)
	return _atlas

# Imports Game Studio's realistic nature and people into /Game/GameStudioNature (realistic Unreal template).
# Run by Unreal's editor (-run=pythonscript) after Game Studio has prepared Intermediate/GameStudioNature
# (src-tauri/src/unreal_nature.rs). The game draws simple shapes for anything missing (StudioGameMode.cpp),
# so names here must match NatureMesh, Person, Surface and CoverHair there.
import math, os, glob
import unreal

EL = unreal.EditorAssetLibrary
AT = unreal.AssetToolsHelpers.get_asset_tools()
ML = unreal.MaterialEditingLibrary
P = unreal.MaterialProperty
R = "/Game/GameStudioNature"
SRC = os.path.join(unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_intermediate_dir()), "GameStudioNature")
CONTENT = unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_content_dir())


def log(*a):
    unreal.log_warning("nature: " + " ".join(map(str, a)))


def imp(path, dest, options=None):
    t = unreal.AssetImportTask()
    t.filename = path
    t.destination_path = dest
    t.automated = True
    t.replace_existing = True
    t.save = False
    if options:
        t.options = options
    AT.import_asset_tasks([t])
    return list(t.imported_object_paths)


def fresh(path):
    if EL.does_asset_exist(path):
        EL.delete_asset(path)


# ---- Textures -------------------------------------------------------------------------------
T = {}


def textures():
    for f in sorted(glob.glob(os.path.join(SRC, "tex", "*.jpg"))):
        n = os.path.basename(f)[:-4]
        imp(f, R + "/T")
        x = EL.load_asset(R + "/T/" + n)
        if not x:
            continue
        T[n] = x
        l = n.lower()
        if "nor_" in l:
            x.set_editor_property("compression_settings", unreal.TextureCompressionSettings.TC_NORMALMAP)
            x.set_editor_property("srgb", False)
            # Poly Haven's _nor_gl maps are OpenGL style; Unreal's are DirectX style.
            x.set_editor_property("flip_green_channel", "nor_gl" in l)
        elif "arm" in l or "rough" in l or "alpha" in l:
            x.set_editor_property("compression_settings", unreal.TextureCompressionSettings.TC_MASKS)
            x.set_editor_property("srgb", False)
    log("textures", len(T))


# ---- Materials ------------------------------------------------------------------------------
def E(m, c):
    return ML.create_material_expression(m, c, -600, 0)


def tex(m, t, kind="c"):
    e = E(m, unreal.MaterialExpressionTextureSample)
    e.texture = t
    e.sampler_type = {"c": unreal.MaterialSamplerType.SAMPLERTYPE_COLOR, "n": unreal.MaterialSamplerType.SAMPLERTYPE_NORMAL, "m": unreal.MaterialSamplerType.SAMPLERTYPE_MASKS}[kind]
    return e


def new_material(n, folder="/M"):
    fresh(R + folder + "/" + n)
    return AT.create_asset(n, R + folder, unreal.Material, unreal.MaterialFactoryNew())


def vec(m, rgb):
    c = E(m, unreal.MaterialExpressionConstant3Vector)
    c.constant = unreal.LinearColor(rgb[0], rgb[1], rgb[2], 1)
    return c


def up_normal(m):
    # Leaves and grass lit as if facing the sky: cards seen edge-on otherwise turn dark.
    m.set_editor_property("tangent_space_normal", False)
    ML.connect_material_property(vec(m, (0, 0, 1)), "", P.MP_NORMAL)


def instanced(m):
    m.set_editor_property("used_with_instanced_static_meshes", True)


def make(n, pre, alpha=None, tint=None, metal=False, up=False):
    m = new_material("M_" + n)
    d = tex(m, T[pre + "_diff_1k"])
    a = tex(m, T[pre + "_arm_1k"], "m")
    src = (d, "RGB")
    if tint:
        mu = E(m, unreal.MaterialExpressionMultiply)
        ML.connect_material_expressions(d, "RGB", mu, "A")
        ML.connect_material_expressions(vec(m, tint), "", mu, "B")
        src = (mu, "")
    ML.connect_material_property(src[0], src[1], P.MP_BASE_COLOR)
    ML.connect_material_property(a, "G", P.MP_ROUGHNESS)
    if metal:
        ML.connect_material_property(a, "B", P.MP_METALLIC)
    if up:
        up_normal(m)
    else:
        ML.connect_material_property(tex(m, T[pre + "_nor_gl_1k"], "n"), "RGB", P.MP_NORMAL)
    if alpha:
        m.set_editor_property("two_sided", True)
        m.set_editor_property("blend_mode", unreal.BlendMode.BLEND_MASKED)
        m.set_editor_property("opacity_mask_clip_value", 0.18)
        m.set_editor_property("shading_model", unreal.MaterialShadingModel.MSM_TWO_SIDED_FOLIAGE)
        ML.connect_material_property(tex(m, T[alpha], "m"), "R", P.MP_OPACITY_MASK)
        ML.connect_material_property(src[0], src[1], P.MP_SUBSURFACE_COLOR)
    instanced(m)
    ML.recompile_material(m)
    return m


def ground():
    # Two photographed grounds in world space, mixed by large soft noise; far away it takes the grass's colour.
    m = new_material("M_Ground")
    pos = E(m, unreal.MaterialExpressionWorldPosition)
    xy = E(m, unreal.MaterialExpressionComponentMask)
    for k, v in (("R", True), ("G", True), ("B", False), ("A", False)):
        xy.set_editor_property(k, v)
    ML.connect_material_expressions(pos, "", xy, "")

    def uv(cm):
        d = E(m, unreal.MaterialExpressionDivide)
        d.set_editor_property("const_b", cm)
        ML.connect_material_expressions(xy, "", d, "A")
        return d

    u1, u2 = uv(230.0), uv(310.0)
    no = E(m, unreal.MaterialExpressionNoise)
    for k, v in (("scale", 0.0011), ("levels", 4), ("output_min", -0.45), ("output_max", 0.75), ("quality", 1)):
        no.set_editor_property(k, v)
    ML.connect_material_expressions(pos, "", no, "Position")
    mix_k = E(m, unreal.MaterialExpressionSaturate)
    ML.connect_material_expressions(no, "", mix_k, "")
    cp = E(m, unreal.MaterialExpressionCameraPositionWS)
    di = E(m, unreal.MaterialExpressionDistance)
    ML.connect_material_expressions(cp, "", di, "A")
    ML.connect_material_expressions(pos, "", di, "B")
    sb = E(m, unreal.MaterialExpressionSubtract)
    sb.set_editor_property("const_b", 2500.0)
    ML.connect_material_expressions(di, "", sb, "A")
    dv = E(m, unreal.MaterialExpressionDivide)
    dv.set_editor_property("const_b", 2500.0)
    ML.connect_material_expressions(sb, "", dv, "A")
    far = E(m, unreal.MaterialExpressionSaturate)
    ML.connect_material_expressions(dv, "", far, "")

    def mix(a, b, kind, out):
        A, B = tex(m, T[a], kind), tex(m, T[b], kind)
        ML.connect_material_expressions(u1, "", A, "UVs")
        ML.connect_material_expressions(u2, "", B, "UVs")
        l = E(m, unreal.MaterialExpressionLinearInterpolate)
        o = "R" if kind == "m" else "RGB"
        ML.connect_material_expressions(A, o, l, "A")
        ML.connect_material_expressions(B, o, l, "B")
        ML.connect_material_expressions(mix_k, "", l, "Alpha")
        if kind == "c":
            mu = E(m, unreal.MaterialExpressionMultiply)
            ML.connect_material_expressions(l, "", mu, "A")
            ML.connect_material_expressions(vec(m, (0.40, 0.52, 0.25)), "", mu, "B")
            fm = E(m, unreal.MaterialExpressionMultiply)
            ML.connect_material_expressions(mu, "", fm, "A")
            ML.connect_material_expressions(vec(m, (0.62, 0.74, 0.78)), "", fm, "B")
            fl = E(m, unreal.MaterialExpressionLinearInterpolate)
            ML.connect_material_expressions(mu, "", fl, "A")
            ML.connect_material_expressions(fm, "", fl, "B")
            ML.connect_material_expressions(far, "", fl, "Alpha")
            l = fl
        ML.connect_material_property(l, "", out)

    mix("leafy_grass_Diffuse", "sparse_grass_Diffuse", "c", P.MP_BASE_COLOR)
    mix("leafy_grass_nor_dx", "sparse_grass_nor_dx", "n", P.MP_NORMAL)
    mix("leafy_grass_Rough", "sparse_grass_Rough", "m", P.MP_ROUGHNESS)
    ML.recompile_material(m)


def grass_material():
    G = "grass_bermuda_01"
    m = new_material("M_grass")
    d = tex(m, T[G + "_diff_1k"])
    a = tex(m, T[G + "_arm_1k"], "m")
    # Each clump a little greener or yellower than the next.
    r = E(m, unreal.MaterialExpressionPerInstanceRandom)
    pw = E(m, unreal.MaterialExpressionPower)
    pw.set_editor_property("const_exponent", 2.5)
    ML.connect_material_expressions(r, "", pw, "Base")
    lr = E(m, unreal.MaterialExpressionLinearInterpolate)
    ML.connect_material_expressions(vec(m, (0.95, 1.12, 0.62)), "", lr, "A")
    ML.connect_material_expressions(vec(m, (1.25, 1.18, 0.55)), "", lr, "B")
    ML.connect_material_expressions(pw, "", lr, "Alpha")
    mu = E(m, unreal.MaterialExpressionMultiply)
    ML.connect_material_expressions(d, "RGB", mu, "A")
    ML.connect_material_expressions(lr, "", mu, "B")
    ML.connect_material_property(mu, "", P.MP_BASE_COLOR)
    ML.connect_material_property(mu, "", P.MP_SUBSURFACE_COLOR)
    ML.connect_material_property(a, "G", P.MP_ROUGHNESS)
    m.set_editor_property("two_sided", True)
    m.set_editor_property("blend_mode", unreal.BlendMode.BLEND_MASKED)
    m.set_editor_property("opacity_mask_clip_value", 0.18)
    m.set_editor_property("shading_model", unreal.MaterialShadingModel.MSM_TWO_SIDED_FOLIAGE)
    ML.connect_material_property(tex(m, T[G + "_alpha"], "m"), "R", P.MP_OPACITY_MASK)
    up_normal(m)
    # Far away each clump sinks into its own root, so the grass thins out instead of ending in a line.
    op = E(m, unreal.MaterialExpressionObjectPositionWS)
    wp = E(m, unreal.MaterialExpressionWorldPosition)
    cp = E(m, unreal.MaterialExpressionCameraPositionWS)
    di = E(m, unreal.MaterialExpressionDistance)
    ML.connect_material_expressions(op, "", di, "A")
    ML.connect_material_expressions(cp, "", di, "B")
    sb = E(m, unreal.MaterialExpressionSubtract)
    sb.set_editor_property("const_b", 2600.0)
    ML.connect_material_expressions(di, "", sb, "A")
    dv = E(m, unreal.MaterialExpressionDivide)
    dv.set_editor_property("const_b", 1700.0)
    ML.connect_material_expressions(sb, "", dv, "A")
    sat = E(m, unreal.MaterialExpressionSaturate)
    ML.connect_material_expressions(dv, "", sat, "")
    to = E(m, unreal.MaterialExpressionSubtract)
    ML.connect_material_expressions(op, "", to, "A")
    ML.connect_material_expressions(wp, "", to, "B")
    wpo = E(m, unreal.MaterialExpressionMultiply)
    ML.connect_material_expressions(to, "", wpo, "A")
    ML.connect_material_expressions(sat, "", wpo, "B")
    ML.connect_material_property(wpo, "", P.MP_WORLD_POSITION_OFFSET)
    instanced(m)
    ML.recompile_material(m)
    return m


def aligned_material(n, t, size):
    # Photographed stone or wood projected in world space, for the game's simple boxes (Surface()).
    WAT = unreal.load_object(None, "/Engine/Functions/Engine_MaterialFunctions01/Texturing/WorldAlignedTexture.WorldAlignedTexture")
    WAN = unreal.load_object(None, "/Engine/Functions/Engine_MaterialFunctions01/Texturing/WorldAlignedNormal.WorldAlignedNormal")
    m = new_material(n)
    sz = vec(m, (size, size, size))

    def aligned(fn, x, kind):
        to = E(m, unreal.MaterialExpressionTextureObject)
        to.texture = x
        if kind == "n":
            to.sampler_type = unreal.MaterialSamplerType.SAMPLERTYPE_NORMAL
        if kind == "m":
            to.sampler_type = unreal.MaterialSamplerType.SAMPLERTYPE_MASKS
        f = E(m, unreal.MaterialExpressionMaterialFunctionCall)
        f.set_editor_property("material_function", fn)
        ML.connect_material_expressions(to, "", f, "TextureObject")
        ML.connect_material_expressions(sz, "", f, "TextureSize")
        return f

    ML.connect_material_property(aligned(WAT, T[t + "_Diffuse"], "c"), "XYZ Texture", P.MP_BASE_COLOR)
    ML.connect_material_property(aligned(WAT, T[t + "_Rough"], "m"), "XYZ Texture", P.MP_ROUGHNESS)
    ML.connect_material_property(aligned(WAN, T[t + "_nor_dx"], "n"), "XYZ Texture", P.MP_NORMAL)
    m.set_editor_property("tangent_space_normal", False)
    ML.recompile_material(m)


def glass_material():
    m = new_material("M_glass")
    m.set_editor_property("blend_mode", unreal.BlendMode.BLEND_TRANSLUCENT)
    ML.connect_material_property(vec(m, (0.8, 0.75, 0.6)), "", P.MP_BASE_COLOR)
    o = E(m, unreal.MaterialExpressionConstant)
    o.r = 0.25
    ML.connect_material_property(o, "", P.MP_OPACITY)
    ML.recompile_material(m)
    return m


# ---- Models ---------------------------------------------------------------------------------
def models(MM):
    for f in sorted(glob.glob(os.path.join(SRC, "glb", "*.glb"))):
        n = os.path.basename(f)[:-4]
        folder = R + "/Import/" + n
        if EL.does_directory_exist(folder):
            EL.delete_directory(folder)
        imp(f, folder)
        sm = next((x for x in EL.list_assets(folder, True) if isinstance(EL.load_asset(x), unreal.StaticMesh)), None)
        if not sm:
            log("could not import", n)
            continue
        fresh(R + "/" + n)
        EL.rename_asset(sm, R + "/" + n)
        sm = EL.load_asset(R + "/" + n)
        for i, s in enumerate(sm.static_materials):
            k = str(s.material_slot_name)
            mat = MM.get(k) or next((v for q, v in MM.items() if k.startswith(q)), None)
            if mat:
                sm.set_material(i, mat)
            else:
                log("no material for", n, k)
        log("model", n)


# ---- People ---------------------------------------------------------------------------------
def woman():
    # Microsoft Rocketbox Female_Adult_11 with her idle; the game sets her materials by slot name (Person()).
    F = os.path.join(SRC, "people")
    D = R + "/People/Woman"
    ui = unreal.FbxImportUI()
    ui.import_mesh = True
    ui.import_as_skeletal = True
    ui.import_animations = False
    ui.import_materials = False
    ui.import_textures = False
    ui.mesh_type_to_import = unreal.FBXImportType.FBXIT_SKELETAL_MESH
    imp(os.path.join(F, "Female_Adult_11.fbx"), D, ui)
    mesh = EL.load_asset(D + "/Female_Adult_11")
    if not mesh:
        log("the villager did not import")
        return
    ui2 = unreal.FbxImportUI()
    ui2.import_mesh = False
    ui2.import_animations = True
    ui2.import_materials = False
    ui2.import_textures = False
    ui2.skeleton = mesh.get_editor_property("skeleton")
    ui2.mesh_type_to_import = unreal.FBXImportType.FBXIT_ANIMATION
    imp(os.path.join(F, "f_idle_neutral_01.max.fbx"), D + "/Anim", ui2)
    W = {}
    for n in ("f011_body_color", "f011_body_normal", "f011_head_color", "f011_head_normal", "f011_opacity_color"):
        imp(os.path.join(F, n + ".tga"), D + "/T")
        x = EL.load_asset(D + "/T/" + n)
        if "normal" in n:
            x.set_editor_property("compression_settings", unreal.TextureCompressionSettings.TC_NORMALMAP)
            x.set_editor_property("srgb", False)
        W[n] = x

    def mat(n, color, normal=None, masked=False):
        fresh(D + "/" + n)
        m = AT.create_asset(n, D, unreal.Material, unreal.MaterialFactoryNew())
        c = tex(m, W[color])
        ML.connect_material_property(c, "RGB", P.MP_BASE_COLOR)
        if normal:
            ML.connect_material_property(tex(m, W[normal], "n"), "RGB", P.MP_NORMAL)
        r = E(m, unreal.MaterialExpressionConstant)
        r.r = 0.62
        ML.connect_material_property(r, "", P.MP_ROUGHNESS)
        if masked:
            m.set_editor_property("blend_mode", unreal.BlendMode.BLEND_MASKED)
            m.set_editor_property("two_sided", True)
            m.set_editor_property("opacity_mask_clip_value", 0.4)
            ML.connect_material_property(c, "A", P.MP_OPACITY_MASK)
        m.set_editor_property("used_with_skeletal_mesh", True)
        ML.recompile_material(m)

    mat("M_WomanBody", "f011_body_color", "f011_body_normal")
    mat("M_WomanHead", "f011_head_color", "f011_head_normal")
    mat("M_WomanOpacity", "f011_opacity_color", None, True)
    log("villager")


def hair_cap():
    # Kellan's hair is strands only, which Metal SM5 cannot draw: short hair over his scalp instead, shaped from
    # the sample's own head (skin section, above a hairline set by the angle around the head).
    face = EL.load_asset("/Game/MetaHumans/Kellan/Face/Kellan_FaceMesh")
    if not face:
        log("no Kellan head in this project; no hair cap")
        return
    G = unreal.GeometryScript_List
    Q = unreal.GeometryScript_MeshQueries
    dm = unreal.DynamicMesh()
    lod = unreal.GeometryScriptMeshReadLOD()
    lod.lod_index = 0
    unreal.GeometryScript_AssetUtils.copy_mesh_from_skeletal_mesh(face, dm, unreal.GeometryScriptCopyMeshFromAssetOptions(), lod)

    def pick(r):
        r = r if isinstance(r, tuple) else (r,)
        return next(x for x in r if not isinstance(x, (unreal.DynamicMesh, bool)))

    V = [(v.x, v.y, v.z) for v in G.convert_vector_list_to_array(pick(Q.get_all_vertex_positions(dm, False)))]
    T = [(t.x, t.y, t.z) for t in G.convert_triangle_list_to_array(pick(Q.get_all_triangle_indices(dm, False)))]
    M = list(G.convert_index_list_to_array(pick(unreal.GeometryScript_Materials.get_all_triangle_material_i_ds(dm))))
    counts = {}
    for m in M:
        counts[m] = counts.get(m, 0) + 1
    skin = max(counts, key=counts.get)
    T = [t for t, m in zip(T, M) if m == skin]
    N = [[0.0, 0.0, 0.0] for _ in V]
    for a, b, c in T:
        pa, pb, pc = V[a], V[b], V[c]
        u = (pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2])
        w = (pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2])
        n = (u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0])
        for i in (a, b, c):
            for k in range(3):
                N[i][k] += n[k]
    for n in N:
        l = math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]) or 1.0
        for k in range(3):
            n[k] = -n[k] / l  # Unreal's winding: the summed normal points inwards.
    # Hairline height (cm) by degrees from the front (+Y), with sideburns just in front of the ears.
    K = [(0, 169.0), (30, 168.3), (55, 166.3), (72, 164.6), (80, 161.8), (88, 161.0), (94, 163.6), (100, 163.6), (120, 160.0), (140, 156.6), (160, 155.2), (180, 155.0)]

    def line(a):
        for (a0, z0), (a1, z1) in zip(K, K[1:]):
            if a <= a1:
                return z0 + (z1 - z0) * (a - a0) / (a1 - a0)
        return K[-1][1]

    above, alpha = [], []
    for (x, y, z) in V:
        a = abs(math.degrees(math.atan2(x, y - 0.5)))
        s = z - line(a)
        if abs(x) > 7.4 and z < 164.2 and a > 86:
            s = -5.0  # the ears stay bare
        above.append(s)
        k = min(max(s, 0.0), 1.0)
        alpha.append(k * k * (3 - 2 * k))
    keep = [t for t in T if all(above[i] > -0.6 for i in t)]
    used = sorted({i for t in keep for i in t})
    remap = {v: i for i, v in enumerate(used)}
    b = unreal.GeometryScriptSimpleMeshBuffers()
    verts = []
    for v in used:
        o = 0.12 + 0.18 * alpha[v]
        verts.append(unreal.Vector(V[v][0] + N[v][0] * o, V[v][1] + N[v][1] * o, V[v][2] + N[v][2] * o))
    b.set_editor_property("vertices", verts)
    b.set_editor_property("normals", [unreal.Vector(*N[v]) for v in used])
    b.set_editor_property("vertex_colors", [unreal.LinearColor(alpha[v], alpha[v], alpha[v], alpha[v]) for v in used])
    b.set_editor_property("uv0", [unreal.Vector2D(V[v][0] / 20.0, V[v][1] / 20.0) for v in used])
    b.set_editor_property("triangles", [unreal.IntVector(remap[a], remap[b2], remap[c]) for a, b2, c in keep])
    cap = unreal.DynamicMesh()
    unreal.GeometryScript_MeshEdits.append_buffers_to_mesh(cap, b, -1)
    D = R + "/People/Kellan"
    m = new_material("M_HairCap", "/People/Kellan")
    m.set_editor_property("blend_mode", unreal.BlendMode.BLEND_MASKED)
    m.set_editor_property("opacity_mask_clip_value", 0.5)
    vc = E(m, unreal.MaterialExpressionVertexColor)
    lp = E(m, unreal.MaterialExpressionLocalPosition)
    no = E(m, unreal.MaterialExpressionNoise)
    for k, v in (("scale", 3.0), ("levels", 3), ("output_min", 0.0), ("output_max", 1.0), ("quality", 1)):
        no.set_editor_property(k, v)
    ML.connect_material_expressions(lp, "", no, "Position")
    lr = E(m, unreal.MaterialExpressionLinearInterpolate)
    ML.connect_material_expressions(vec(m, (0.012, 0.009, 0.008)), "", lr, "A")
    ML.connect_material_expressions(vec(m, (0.032, 0.024, 0.019)), "", lr, "B")
    ML.connect_material_expressions(no, "", lr, "Alpha")
    ML.connect_material_property(lr, "", P.MP_BASE_COLOR)
    fine = E(m, unreal.MaterialExpressionNoise)
    for k, v in (("scale", 9.0), ("levels", 2), ("output_min", -0.35), ("output_max", 0.35), ("quality", 1)):
        fine.set_editor_property(k, v)
    ML.connect_material_expressions(lp, "", fine, "Position")
    ad = E(m, unreal.MaterialExpressionAdd)
    ML.connect_material_expressions(vc, "R", ad, "A")
    ML.connect_material_expressions(fine, "", ad, "B")
    ML.connect_material_property(ad, "", P.MP_OPACITY_MASK)
    ro = E(m, unreal.MaterialExpressionConstant)
    ro.r = 0.82
    ML.connect_material_property(ro, "", P.MP_ROUGHNESS)
    ML.recompile_material(m)
    o = unreal.GeometryScriptCreateNewStaticMeshAssetOptions()
    o.set_editor_property("enable_recompute_normals", False)
    o.set_editor_property("enable_recompute_tangents", True)
    o.set_editor_property("enable_nanite", False)
    fresh(D + "/HairCap")
    unreal.GeometryScript_NewAssetUtils.create_new_static_mesh_asset_from_mesh(cap, D + "/HairCap", o)
    sm = EL.load_asset(D + "/HairCap")
    sm.set_material(0, m)
    log("hair cap", len(keep), "triangles")


def main():
    version_file = os.path.join(SRC, "version.txt")
    if not os.path.isfile(version_file):
        log("nothing prepared; the game keeps its simple shapes")
        return
    version = open(version_file).read().strip()
    textures()
    I, J, B = "island_tree_01", "jacaranda_tree", "Lantern_01_brass"
    MM = {
        J + "_branches": make("jb", J + "_branches"),
        J + "_trunk": make("jt", J + "_trunk"),
        J + "_leaves": make("jl", J + "_leaves", J + "_leaves_alpha", up=True),
        I: make("it", I),
        I + "_branches": make("ib", I + "_branches"),
        I + "_leaves": make("il", I + "_leaves", I + "_leaves_alpha", up=True),
        "boulder_01": make("rock", "boulder_01"),
        "fern_02": make("fern", "fern_02", "fern_02_alpha", up=True),
        "grass_bermuda_01": grass_material(),
        "large_castle_door": make("door", "large_castle_door"),
        B: make("brass", B, metal=True),
        "Lantern_01_glass": glass_material(),
    }
    ground()
    aligned_material("M_Stone", "castle_wall_slates", 160.0)
    aligned_material("M_Wood", "weathered_planks", 140.0)
    models(MM)
    woman()
    hair_cap()
    EL.save_directory(R, False, True)
    os.makedirs(os.path.join(CONTENT, "GameStudioNature"), exist_ok=True)
    credits = os.path.join(SRC, "CREDITS.txt")
    if os.path.isfile(credits):
        open(os.path.join(CONTENT, "GameStudioNature", "CREDITS.txt"), "w").write(open(credits).read())
    open(os.path.join(CONTENT, "GameStudioNature", ".studio-nature"), "w").write(version)
    log("imported, version", version)


try:
    main()
except Exception as e:  # reported, not fatal: the game keeps its simple shapes for what is missing
    import traceback
    log("stopped:", e)
    for line in traceback.format_exc().splitlines()[-6:]:
        log(line)

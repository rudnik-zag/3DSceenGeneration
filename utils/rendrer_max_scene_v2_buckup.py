# Blender 5.x batch render script:
# - Import .max (via "Import Autodesk MAX (.max)" extension) OR FBX/OBJ/GLB/GLTF
# - Create 16 cameras on a Fibonacci sphere, all looking at the object (aimed at "chest" height)
# - Load HDRI world (.hdr/.exr)
# - Set fast Cycles GPU render at 768x768
# - Render JPEGs to OUTPUT_DIR as cam_00.jpg ... cam_15.jpg

import bpy
import os
import math
from mathutils import Vector

# =========================
# USER SETTINGS (EDIT THESE)
# =========================
MODEL_PATH   = "/media/dusan/New Volume/ML_DATASET/ARMCHAIRS/003_estel/003_estel/Polpetta_2011_Vray2.0.max"     # .max, .fbx, .obj, .glb/.gltf supported
HDRI_PATH    = "/media/dusan/VERBATIM HD/ASSETS/10 SAMPLE INTERIOR FROM 3DARCSHOP VOL 08/custom_sceen/pav_studio_03_4k.exr"      # .hdr or .exr
OUTPUT_DIR   = "/media/dusan/New Volume/ML_DATASET/ARMCHAIRS/003_estel/003_estel//output_renders"     # folder for cam_00.jpg ... cam_15.jpg

N_CAMERAS = 16
RES = 768
SAMPLES = 64
NOISE_THRESH = 0.05      # 0.1 faster, 0.03 cleaner
JPEG_QUALITY = 95

RENDER_ENGINE = "EEVEE"  # "EEVEE" or "CYCLES"

FOCAL_MM = 24.0          # 24 good for interiors, 35 more natural
HDRI_STRENGTH = 1.0
HDRI_ROT_DEG = 0.0
EEVEE_HDRI_STRENGTH = 1.0  # stronger for Eevee if needed

RECENTER_TO_ORIGIN = True
JOIN_MESHES = False      # keep False to preserve separate materials
CAMERA_RADIUS = None     # None -> auto from bounds
RADIUS_MULT = 2.8        # sphere radius multiplier relative to bounds radius

USE_DOF = True
FSTOP = 8.0

CAM_CLIP_START = 0.01
CAM_CLIP_END   = 10_000_000

# Color management
VIEW_TRANSFORM = "Filmic"  # "Standard" or "Filmic"
EXPOSURE = 0.0

# =========================
# Helpers
# =========================
def purge_scene():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)

    # Purge orphan data (best effort)
    try:
        bpy.ops.outliner.orphans_purge(do_recursive=True)
    except Exception:
        pass

    # Ensure a world exists
    if bpy.data.worlds:
        bpy.context.scene.world = bpy.data.worlds[0]
    else:
        bpy.context.scene.world = bpy.data.worlds.new("World")

def ensure_dir(path):
    os.makedirs(path, exist_ok=True)
    if not os.path.isdir(path):
        raise RuntimeError(f"Could not create output directory: {path}")
    if not os.access(path, os.W_OK):
        raise RuntimeError(f"Output directory is not writable: {path}")

def snapshot_objects():
    return set(bpy.data.objects)

def imported_objects(before_set):
    return [obj for obj in bpy.data.objects if obj not in before_set]

def get_meshes(objs):
    return [o for o in objs if o.type == 'MESH']

def get_visible_meshes(objs):
    visible = []
    for o in objs:
        if o.type != 'MESH':
            continue
        try:
            is_visible = o.visible_get()
        except Exception:
            is_visible = not o.hide_get()
        if is_visible and not o.hide_render:
            visible.append(o)
    return visible

def get_world_aabb(mesh_objs, depsgraph=None):
    if depsgraph is None:
        depsgraph = bpy.context.evaluated_depsgraph_get()
    min_v = Vector(( float("inf"),  float("inf"),  float("inf")))
    max_v = Vector((-float("inf"), -float("inf"), -float("inf")))
    for obj in mesh_objs:
        eval_obj = obj.evaluated_get(depsgraph)
        for corner in eval_obj.bound_box:
            w = eval_obj.matrix_world @ Vector(corner)
            min_v.x = min(min_v.x, w.x); min_v.y = min(min_v.y, w.y); min_v.z = min(min_v.z, w.z)
            max_v.x = max(max_v.x, w.x); max_v.y = max(max_v.y, w.y); max_v.z = max(max_v.z, w.z)
    return min_v, max_v

def mesh_bounds_volume(obj):
    min_v, max_v = get_world_aabb([obj])
    size = max_v - min_v
    return max(0.0, size.x) * max(0.0, size.y) * max(0.0, size.z)

def bounds_center_and_radius(mesh_objs):
    min_v, max_v = get_world_aabb(mesh_objs)
    center = (min_v + max_v) * 0.5
    radius = (max_v - min_v).length * 0.5
    return center, max(1e-6, radius), min_v, max_v

def translate_objects(objs, delta: Vector):
    for o in objs:
        o.location = o.location + delta

def fibonacci_sphere_dirs(n):
    dirs = []
    golden = (1 + 5 ** 0.5) / 2
    for i in range(n):
        t = (i + 0.5) / n
        incl = math.acos(1 - 2 * t)
        azim = 2 * math.pi * i / golden
        x = math.sin(incl) * math.cos(azim)
        y = math.sin(incl) * math.sin(azim)
        z = math.cos(incl)
        dirs.append(Vector((x, y, z)).normalized())
    return dirs

def make_empty(name, loc):
    empty = bpy.data.objects.new(name, None)
    empty.empty_display_type = 'PLAIN_AXES'
    empty.location = loc
    bpy.context.collection.objects.link(empty)
    return empty

def create_camera(name, location, look_at_obj):
    cam_data = bpy.data.cameras.new(name)
    cam = bpy.data.objects.new(name, cam_data)
    cam.location = location
    bpy.context.collection.objects.link(cam)

    cam_data.lens = FOCAL_MM
    cam_data.clip_start = CAM_CLIP_START
    cam_data.clip_end = CAM_CLIP_END

    # Track to target
    c = cam.constraints.new(type='TRACK_TO')
    c.target = look_at_obj
    c.track_axis = 'TRACK_NEGATIVE_Z'
    c.up_axis = 'UP_Y'

    if USE_DOF:
        cam_data.dof.use_dof = True
        cam_data.dof.focus_object = look_at_obj
        cam_data.dof.aperture_fstop = FSTOP

    return cam

def setup_hdri_world(hdri_path, strength=1.0, rot_deg=0.0):
    if not os.path.isfile(hdri_path):
        raise FileNotFoundError(f"HDRI file not found: {hdri_path}")

    world = bpy.context.scene.world
    world.use_nodes = True
    nt = world.node_tree
    nodes = nt.nodes
    links = nt.links
    nodes.clear()

    n_out = nodes.new("ShaderNodeOutputWorld")
    n_bg  = nodes.new("ShaderNodeBackground")
    n_env = nodes.new("ShaderNodeTexEnvironment")
    n_tex = nodes.new("ShaderNodeTexCoord")
    n_map = nodes.new("ShaderNodeMapping")

    n_tex.location = (-900, 0)
    n_map.location = (-700, 0)
    n_env.location = (-500, 0)
    n_bg.location  = (-250, 0)
    n_out.location = (  50, 0)

    n_env.image = bpy.data.images.load(hdri_path, check_existing=True)
    n_bg.inputs["Strength"].default_value = strength
    n_map.inputs["Rotation"].default_value[2] = math.radians(rot_deg)

    links.new(n_tex.outputs["Generated"], n_map.inputs["Vector"])
    links.new(n_map.outputs["Vector"], n_env.inputs["Vector"])
    links.new(n_env.outputs["Color"], n_bg.inputs["Color"])
    links.new(n_bg.outputs["Background"], n_out.inputs["Surface"])

def setup_cycles_gpu_fast():
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'

    # Try to set GPU
    try:
        scene.cycles.device = 'GPU'
    except Exception:
        print("WARNING: Could not set Cycles device to GPU (will use CPU or default).")

    # Resolution
    scene.render.resolution_x = RES
    scene.render.resolution_y = RES
    scene.render.resolution_percentage = 100

    # Output
    scene.render.image_settings.file_format = 'JPEG'
    scene.render.image_settings.quality = int(JPEG_QUALITY)
    scene.render.use_file_extension = True  # IMPORTANT so Blender appends .jpg

    # Sampling
    scene.cycles.samples = int(SAMPLES)
    if hasattr(scene.cycles, "use_adaptive_sampling"):
        scene.cycles.use_adaptive_sampling = True
    if hasattr(scene.cycles, "adaptive_threshold"):
        scene.cycles.adaptive_threshold = float(NOISE_THRESH)

    # Denoising (Blender 5-safe)
    if hasattr(scene.cycles, "use_denoising"):
        scene.cycles.use_denoising = True
    if hasattr(scene.cycles, "denoiser"):
        try:
            scene.cycles.denoiser = 'OPTIX'
        except Exception:
            try:
                scene.cycles.denoiser = 'OPENIMAGEDENOISE'
            except Exception:
                pass

    # Fast bounces
    if hasattr(scene.cycles, "max_bounces"):
        scene.cycles.max_bounces = 4
    if hasattr(scene.cycles, "diffuse_bounces"):
        scene.cycles.diffuse_bounces = 2
    if hasattr(scene.cycles, "glossy_bounces"):
        scene.cycles.glossy_bounces = 2
    if hasattr(scene.cycles, "transmission_bounces"):
        scene.cycles.transmission_bounces = 2
    if hasattr(scene.cycles, "transparent_max_bounces"):
        scene.cycles.transparent_max_bounces = 2

    # Disable slow stuff
    scene.render.use_motion_blur = False
    if hasattr(scene.cycles, "caustics_reflective"):
        scene.cycles.caustics_reflective = False
    if hasattr(scene.cycles, "caustics_refractive"):
        scene.cycles.caustics_refractive = False

def setup_eevee_fast():
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_EEVEE'

    # Resolution
    scene.render.resolution_x = RES
    scene.render.resolution_y = RES
    scene.render.resolution_percentage = 100

    # Output
    scene.render.image_settings.file_format = 'JPEG'
    scene.render.image_settings.quality = int(JPEG_QUALITY)
    scene.render.use_file_extension = True  # IMPORTANT so Blender appends .jpg

    eevee = scene.eevee
    # Reasonable defaults for speed
    if hasattr(eevee, "taa_render_samples"):
        eevee.taa_render_samples = 32
    if hasattr(eevee, "taa_samples"):
        eevee.taa_samples = 16
    if hasattr(eevee, "use_gtao"):
        eevee.use_gtao = True
    if hasattr(eevee, "gtao_distance"):
        eevee.gtao_distance = 1.0
    if hasattr(eevee, "use_bloom"):
        eevee.use_bloom = False
    if hasattr(eevee, "use_ssr"):
        eevee.use_ssr = False
    if hasattr(eevee, "use_motion_blur"):
        eevee.use_motion_blur = False

def setup_color_management():
    scene = bpy.context.scene
    if hasattr(scene, "view_settings"):
        scene.view_settings.view_transform = VIEW_TRANSFORM
        scene.view_settings.exposure = float(EXPOSURE)
def list_possible_max_import_ops():
    candidates = []
    namespaces = [
        ("import_scene", getattr(bpy.ops, "import_scene", None)),
        ("wm", getattr(bpy.ops, "wm", None)),
        ("scene", getattr(bpy.ops, "scene", None)),
    ]
    for ns_label, ns in namespaces:
        if ns is None:
            continue
        for name in dir(ns):
            lname = name.lower()
            if "max" in lname and ("import" in lname or "load" in lname):
                candidates.append((ns_label, name))
    return candidates

def try_import_model(path):
    ext = os.path.splitext(path)[1].lower()
    if not os.path.isfile(path):
        raise FileNotFoundError(f"Model file not found: {path}")

    before = snapshot_objects()
    used_op = None

    if ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=path)
        used_op = "import_scene.fbx"
    elif ext == ".obj":
        if hasattr(bpy.ops.wm, "obj_import"):
            bpy.ops.wm.obj_import(filepath=path)
            used_op = "wm.obj_import"
        else:
            bpy.ops.import_scene.obj(filepath=path)
            used_op = "import_scene.obj"
    elif ext in [".glb", ".gltf"]:
        bpy.ops.import_scene.gltf(filepath=path)
        used_op = "import_scene.gltf"
    elif ext == ".max":
        # Try common guesses first
        common = [
            ("import_scene", "max"),
            ("import_scene", "autodesk_max"),
            ("import_scene", "import_max"),
            ("wm", "max_import"),
            ("wm", "import_max"),
        ]

        def call_op(ns_name, op_name):
            ns = getattr(bpy.ops, ns_name, None)
            if ns is None:
                return False
            op = getattr(ns, op_name, None)
            if op is None:
                return False
            op(filepath=path)
            return True

        for ns_name, op_name in common:
            try:
                if call_op(ns_name, op_name):
                    used_op = f"{ns_name}.{op_name}"
                    break
            except Exception as e:
                print(f"Failed {ns_name}.{op_name}: {e}")

        # Scan for addon operator containing "max"
        if used_op is None:
            candidates = list_possible_max_import_ops()
            print("Detected possible .max import operators:")
            for ns_label, name in candidates:
                print(f" - {ns_label}.{name}")

            for ns_label, name in candidates:
                try:
                    getattr(getattr(bpy.ops, ns_label), name)(filepath=path)
                    used_op = f"{ns_label}.{name}"
                    break
                except Exception as e:
                    print(f"Failed {ns_label}.{name}: {e}")

        if used_op is None:
            raise RuntimeError(
                "Could not import .max with any detected operator.\n"
                "Open File > Import and tell me the exact operator name if needed, "
                "or export FBX as a fallback."
            )
    else:
        raise RuntimeError(f"Unsupported extension: {ext}")

    imported = imported_objects(before)
    print(f"Import used operator: {used_op}")
    print(f"Imported objects: {len(imported)}")
    return imported

def join_mesh_objects(meshes, name="TARGET"):
    bpy.ops.object.select_all(action='DESELECT')
    for m in meshes:
        m.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.join()
    joined = bpy.context.view_layer.objects.active
    joined.name = name
    return joined

def keep_largest_mesh_visible(meshes):
    if len(meshes) <= 1:
        return meshes
    largest = max(meshes, key=mesh_bounds_volume)
    for m in meshes:
        keep = (m == largest)
        m.hide_render = not keep
        m.hide_set(not keep)
    return [largest]

def safe_dir_name(name):
    name = name.replace(os.sep, "_")
    name = name.replace("..", "_")
    return name or "object"

def set_mesh_visibility(all_meshes, visible_mesh):
    for m in all_meshes:
        keep = (m == visible_mesh)
        m.hide_render = not keep
        m.hide_set(not keep)

def store_object_locations(objs):
    return {o.name: o.location.copy() for o in objs}

def restore_object_locations(objs, locs):
    for o in objs:
        if o.name in locs:
            o.location = locs[o.name].copy()

def cleanup_temp_objects(objs):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        if o and o.name in bpy.data.objects:
            o.select_set(True)
    bpy.ops.object.delete(use_global=False)

# =========================
# Main
# =========================
def main():
    ensure_dir(OUTPUT_DIR)
    purge_scene()

    print("MODEL_PATH:", MODEL_PATH)
    imported = try_import_model(MODEL_PATH)
    bpy.context.view_layer.update()

    meshes = get_meshes(imported)
    if not meshes:
        raise RuntimeError("Import succeeded but no mesh objects were found.")

    # Ensure meshes are render-visible
    for o in meshes:
        o.hide_render = False
        o.hide_set(False)

    # Optional join
    if JOIN_MESHES and len(meshes) > 1:
        target = join_mesh_objects(meshes, name="TARGET")
        meshes = [target]

    # HDRI
    hdri_strength = EEVEE_HDRI_STRENGTH if RENDER_ENGINE.upper() == "EEVEE" else HDRI_STRENGTH
    setup_hdri_world(HDRI_PATH, strength=hdri_strength, rot_deg=HDRI_ROT_DEG)

    # Color management
    setup_color_management()

    # Render settings
    if RENDER_ENGINE.upper() == "EEVEE":
        setup_eevee_fast()
    else:
        setup_cycles_gpu_fast()

    # Temporary camera data to read sensor values
    tmp_cam = bpy.data.cameras.new("TMP_CAM")
    tmp_cam.lens = FOCAL_MM
    sensor_h = tmp_cam.sensor_height
    lens_mm = tmp_cam.lens
    bpy.data.cameras.remove(tmp_cam)
    vfov = 2.0 * math.atan((sensor_h * 0.5) / lens_mm)

    original_locations = store_object_locations(imported)

    targets = meshes if len(meshes) > 1 else meshes
    for idx, target_mesh in enumerate(targets):
        set_mesh_visibility(meshes, target_mesh)
        bpy.context.view_layer.update()

        center, radius, min_v, max_v = bounds_center_and_radius([target_mesh])
        print("Target:", target_mesh.name, "center:", center, "radius:", radius)

        if RECENTER_TO_ORIGIN:
            delta = Vector((0, 0, 0)) - center
            translate_objects(imported, delta)
            bpy.context.view_layer.update()
            center, radius, min_v, max_v = bounds_center_and_radius([target_mesh])
            print("Recentered. New target center:", center)

        height = max(1e-6, (max_v.z - min_v.z))
        aim_point = Vector((center.x, center.y, min_v.z + 0.6 * height))
        look_at = make_empty("LOOK_AT", aim_point)

        extent = Vector((max_v.x - min_v.x, max_v.y - min_v.y, max_v.z - min_v.z))
        max_half = 0.5 * max(extent.x, extent.y, extent.z)

        margin = 1.2
        cam_r_fit = max(0.1, (max_half * margin) / math.tan(vfov * 0.5))
        cam_r_bounds = radius * RADIUS_MULT

        if CAMERA_RADIUS is not None:
            cam_r = float(CAMERA_RADIUS)
        else:
            cam_r = max(cam_r_fit, cam_r_bounds)

        print("Auto camera radius:", cam_r)

        dirs = fibonacci_sphere_dirs(N_CAMERAS)
        cameras = []
        for i, d in enumerate(dirs):
            cam_loc = center + d * cam_r
            cam = create_camera(f"CAM_{i:02d}", cam_loc, look_at)
            cameras.append(cam)

        render_dir = OUTPUT_DIR
        if len(meshes) > 1:
            name = safe_dir_name(target_mesh.name)
            render_dir = os.path.join(OUTPUT_DIR, name)
            ensure_dir(render_dir)

        scene = bpy.context.scene
        for i, cam in enumerate(cameras):
            scene.camera = cam
            scene.render.filepath = os.path.join(render_dir, f"cam_{i:02d}")
            print("Rendering:", scene.render.filepath + ".jpg")
            bpy.ops.render.render(write_still=True)

        cleanup_temp_objects(cameras + [look_at])
        restore_object_locations(imported, original_locations)
        bpy.context.view_layer.update()

    print("DONE ✅")
    if len(meshes) > 1:
        print(f"Saved renders per-object under: {OUTPUT_DIR}")
    else:
        print(f"Saved renders to: {OUTPUT_DIR}")

if __name__ == "__main__":
    main()

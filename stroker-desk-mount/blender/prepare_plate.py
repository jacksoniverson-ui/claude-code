"""Build a Bambu Studio print plate from the OpenSCAD STLs.

Run headless from the stroker-desk-mount folder:
    blender -b -P blender/prepare_plate.py

It imports the STLs, cleans the meshes, turns each part to its print
orientation, lays them out on the bed, and writes:
    blender/stroker_mount.blend    - the Blender scene
    stroker_mount_plate.3mf        - open this in Bambu Studio
    blender/plate.png              - preview render
"""
import bmesh
import bpy
import math
import os
import sys
import zipfile
from mathutils import Matrix

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BED = 256.0      # X1 / P1 / A1 bed. Use 180 for an A1 mini.
GAP = 8.0

# part file, copies, rotation into print orientation (see README)
PARTS = [
    ("cradle", 1, Matrix.Rotation(math.radians(-90), 4, "Y")),  # stand on the lip end
    ("clamp",  1, Matrix.Rotation(math.radians(90), 4, "X")),   # flat side down, teeth up
    ("knob",   2, Matrix.Identity(4)),                          # hex pocket up
    ("pad",    1, Matrix.Identity(4)),
]

bpy.ops.wm.read_factory_settings(use_empty=True)


def clean(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    bmesh.ops.dissolve_degenerate(bm, edges=bm.edges, dist=1e-4)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(obj.data)
    open_edges = sum(1 for e in bm.edges if not e.is_manifold)
    bm.free()
    return open_edges


def drop_to_bed(obj):
    zs = [v.co.z for v in obj.data.vertices]
    obj.data.transform(Matrix.Translation((0, 0, -min(zs))))


objects = []
for name, copies, rot in PARTS:
    bpy.ops.wm.stl_import(filepath=os.path.join(HERE, f"{name}.stl"))
    src = bpy.context.selected_objects[0]
    src.name = name
    src.data.transform(rot)
    drop_to_bed(src)
    bad = clean(src)
    print(f"{name}: {len(src.data.polygons)} faces, non-manifold edges: {bad}")
    if bad:
        sys.exit(f"{name} is not watertight")
    objects.append(src)
    for i in range(1, copies):
        dup = src.copy()
        dup.data = src.data.copy()
        dup.name = f"{name}.{i + 1}"
        bpy.context.collection.objects.link(dup)
        objects.append(dup)

# Centre each mesh on its own XY origin, then shelf-pack onto the bed.
sizes = {}
for o in objects:
    xs = [v.co.x for v in o.data.vertices]
    ys = [v.co.y for v in o.data.vertices]
    o.data.transform(Matrix.Translation((-(min(xs) + max(xs)) / 2, -(min(ys) + max(ys)) / 2, 0)))
    sizes[o.name] = (max(xs) - min(xs), max(ys) - min(ys))

x = y = GAP
row_h = 0.0
for o in sorted(objects, key=lambda o: -sizes[o.name][1]):
    w, d = sizes[o.name]
    if x + w + GAP > BED:
        x, y, row_h = GAP, y + row_h + GAP, 0.0
    o.location = (x + w / 2, y + d / 2, 0)
    x += w + GAP
    row_h = max(row_h, d)
if y + row_h + GAP > BED:
    sys.exit(f"parts do not fit on a {BED} mm bed")
print(f"plate uses {BED:.0f} x {y + row_h + GAP:.0f} mm")

# ---- 3MF (core spec, millimetres) ----
def mesh_xml(o, oid):
    me = o.data
    m = o.matrix_world
    verts = "".join(
        '<vertex x="%.4f" y="%.4f" z="%.4f"/>' % tuple(m @ v.co) for v in me.vertices)
    me.calc_loop_triangles()
    tris = "".join(
        '<triangle v1="%d" v2="%d" v3="%d"/>' % tuple(t.vertices) for t in me.loop_triangles)
    return (f'<object id="{oid}" name="{o.name}" type="model"><mesh>'
            f'<vertices>{verts}</vertices><triangles>{tris}</triangles></mesh></object>')


bpy.context.view_layer.update()
resources = "".join(mesh_xml(o, i + 1) for i, o in enumerate(objects))
build = "".join(f'<item objectid="{i + 1}"/>' for i in range(len(objects)))
model = ('<?xml version="1.0" encoding="UTF-8"?>'
         '<model unit="millimeter" xml:lang="en-US" '
         'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
         '<metadata name="Title">Stroker desk mount</metadata>'
         f'<resources>{resources}</resources><build>{build}</build></model>')
out = os.path.join(HERE, "stroker_mount_plate.3mf")
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml",
               '<?xml version="1.0" encoding="UTF-8"?>'
               '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
               '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
               '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>'
               '</Types>')
    z.writestr("_rels/.rels",
               '<?xml version="1.0" encoding="UTF-8"?>'
               '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
               '<Relationship Target="/3D/3dmodel.model" Id="rel0" '
               'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>'
               '</Relationships>')
    z.writestr("3D/3dmodel.model", model)
print("wrote", out)

# ---- preview render + .blend ----
bpy.ops.mesh.primitive_plane_add(size=BED, location=(BED / 2, BED / 2, -0.05))
bed = bpy.context.object
bed.name = "bed"
mat = bpy.data.materials.new("bed")
mat.diffuse_color = (0.15, 0.15, 0.17, 1)
bed.data.materials.append(mat)
part_mat = bpy.data.materials.new("petg")
part_mat.diffuse_color = (0.85, 0.85, 0.88, 1)
for o in objects:
    o.data.materials.append(part_mat)

cam_data = bpy.data.cameras.new("cam")
cam = bpy.data.objects.new("cam", cam_data)
bpy.context.collection.objects.link(cam)
cam.location = (BED / 2 + 170, BED / 2 - 260, 250)
cam.rotation_euler = (math.radians(55), 0, math.radians(33))
cam_data.lens = 38
scene = bpy.context.scene
scene.camera = cam
scene.render.engine = "BLENDER_WORKBENCH"
scene.display.shading.light = "STUDIO"
scene.display.shading.color_type = "MATERIAL"
scene.display.shading.show_shadows = True
scene.display.shading.show_cavity = True
scene.render.resolution_x, scene.render.resolution_y = 1200, 900
scene.render.filepath = os.path.join(HERE, "blender", "plate.png")
try:
    bpy.ops.render.render(write_still=True)
except RuntimeError as e:
    print("render skipped:", e)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, "blender", "stroker_mount.blend"))

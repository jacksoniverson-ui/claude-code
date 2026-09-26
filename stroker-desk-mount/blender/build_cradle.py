"""Oval-sleeve cradle, authored in Blender (replaces the round cradle() in stroker_desk_mount.scad).

Run headless from the stroker-desk-mount folder:
    blender -b -P blender/build_cradle.py -- [--len 125 --w 65 --h 60 --squeeze 1.0]

Writes cradle.stl in the same frame the .scad used, so prepare_plate.py and the
clamp's pivot teeth are unchanged:
    origin = pivot centre, tooth face at y=0 facing -y, tube axis along +x (toward you),
    retaining lip at the back end. Sleeve width (--w) is horizontal (y), height (--h) vertical (z).

The sleeve is a plain oval with no waist, so it is held by the squeeze fit
(bore is --squeeze smaller than the sleeve on both axes) and stopped from
being pushed through by the lip at the back.
"""
import argparse
import math
import os
import sys

import bmesh
import bpy

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument("--len", type=float, default=125.0, help="sleeve overall length")
ap.add_argument("--w", type=float, default=65.0, help="sleeve width (horizontal)")
ap.add_argument("--h", type=float, default=60.0, help="sleeve height (vertical)")
ap.add_argument("--squeeze", type=float, default=1.0, help="bore is this much smaller than the sleeve")
ap.add_argument("--proud", type=float, default=10.0, help="how far the entrance sticks out of the tube")
ap.add_argument("--ledge", type=float, default=6.0, help="how far the back lip reaches in, per side")
A = ap.parse_args(argv)

# must match stroker_desk_mount.scad
WALL, LIP_T = 3.2, 4.0
ROSETTE_R, TEETH, TOOTH_H, BOSS_LEN = 22.0, 24, 2.5, 16.0
BOLT_D, NUT_AF, NUT_H = 8.6, 13.3, 6.8
NUT_D = NUT_AF / math.cos(math.radians(30))
SEG = 160

IA, IB = (A.w - A.squeeze) / 2, (A.h - A.squeeze) / 2          # bore semi-axes (y, z)
OA, OB = IA + WALL, IB + WALL
LA, LB = IA - A.ledge, IB - A.ledge                              # lip opening
TUBE_LEN = LIP_T + 3 + A.len - A.proud
TB = -ROSETTE_R - 1.0                                                # tube back end (x)
TE = TB + TUBE_LEN
CY = BOSS_LEN + OA                                               # tube axis, sideways from the pivot
print(f"bore {2*IA:.1f} x {2*IB:.1f}, outside {2*OA:.1f} x {2*OB:.1f}, lip hole {2*LA:.1f} x {2*LB:.1f}, tube {TUBE_LEN:.1f} long")

bpy.ops.wm.read_factory_settings(use_empty=True)


def link(name, bm):
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(o)
    return o


def loft_x(name, rings, cy=CY, cz=0.0):
    """closed solid through oval rings [(x, semi_y, semi_z)] along +x"""
    bm = bmesh.new()
    loops = [[bm.verts.new((x, cy + a * math.cos(2 * math.pi * i / SEG), cz + b * math.sin(2 * math.pi * i / SEG)))
              for i in range(SEG)] for x, a, b in rings]
    for r0, r1 in zip(loops, loops[1:]):
        for i in range(SEG):
            bm.faces.new((r0[i], r0[(i + 1) % SEG], r1[(i + 1) % SEG], r1[i]))
    bm.faces.new(loops[0])
    bm.faces.new(loops[-1][::-1])
    return link(name, bm)


def prism(name, pts, z0, z1):
    """polygon in local XY extruded along local Z; returns object (caller rotates)"""
    bm = bmesh.new()
    f = bm.faces.new([bm.verts.new((x, y, z0)) for x, y in pts])
    e = bmesh.ops.extrude_face_region(bm, geom=[f])
    bmesh.ops.translate(bm, verts=[g for g in e["geom"] if isinstance(g, bmesh.types.BMVert)], vec=(0, 0, z1 - z0))
    return link(name, bm)


def circle(r, n=96, cx=0.0, cy=0.0, rot=0.0):
    return [(cx + r * math.cos(rot + 2 * math.pi * i / n), cy + r * math.sin(rot + 2 * math.pi * i / n)) for i in range(n)]


def along_y(o):
    """local Z -> world +Y (like the .scad's rotate([-90,0,0]))"""
    o.data.transform(__import__("mathutils").Matrix.Rotation(math.radians(-90), 4, "X"))
    return o


def rosette():
    """Hirth ring from the .scad: teeth on +z, then turned to face -y (rotate([90,0,0]))"""
    m, ri, ro, h = 2 * TEETH, 5.0, ROSETTE_R, TOOTH_H
    zt = lambda k, r: 0.0 if k % 2 == 0 else h * r / ro
    ang = [math.radians(k * 180 / TEETH) for k in range(m)]
    bm = bmesh.new()
    ti = [bm.verts.new((ri * math.cos(a), ri * math.sin(a), zt(k, ri))) for k, a in enumerate(ang)]
    to = [bm.verts.new((ro * math.cos(a), ro * math.sin(a), zt(k, ro))) for k, a in enumerate(ang)]
    bi = [bm.verts.new((ri * math.cos(a), ri * math.sin(a), -1.0)) for a in ang]
    bo = [bm.verts.new((ro * math.cos(a), ro * math.sin(a), -1.0)) for a in ang]
    for k in range(m):
        j = (k + 1) % m
        bm.faces.new((ti[k], ti[j], to[j], to[k]))
        bm.faces.new((bi[k], bo[k], bo[j], bi[j]))
        bm.faces.new((to[k], to[j], bo[j], bo[k]))
        bm.faces.new((ti[k], bi[k], bi[j], ti[j]))
    o = link("rosette", bm)
    o.data.transform(__import__("mathutils").Matrix.Rotation(math.radians(90), 4, "X"))
    return o


def boolean(target, cutter, op="DIFFERENCE"):
    m = target.modifiers.new("b", "BOOLEAN")
    m.operation, m.solver, m.object = op, "EXACT", cutter
    bpy.context.view_layer.objects.active = target
    bpy.ops.object.modifier_apply(modifier=m.name)
    bpy.data.objects.remove(cutter, do_unlink=True)


# ---- body: oval tube + boss + teeth ----
cradle = loft_x("cradle", [(TB, OA - 1.2, OB - 1.2), (TB + 1.2, OA, OB), (TE - 0.8, OA, OB), (TE, OA - 0.8, OB - 0.8)])
boss = along_y(prism("boss", circle(ROSETTE_R - 0.3), 0.5, CY - IA + 1.0))  # r-0.3: a shared radius with the teeth breaks the boolean
boolean(cradle, boss, "UNION")
boolean(cradle, rosette(), "UNION")

# ---- bore: lip hole (bed chamfer) -> 3 mm cone -> squeeze bore -> 3 mm entrance lead-in ----
boolean(cradle, loft_x("bore", [
    (TB - 1, LA + 2.2, LB + 2.2), (TB + 1.2, LA, LB), (TB + LIP_T, LA, LB), (TB + LIP_T + 3, IA, IB),
    (TE - 3, IA, IB), (TE, IA + 1.5, IB + 1.5), (TE + 1, IA + 1.5, IB + 1.5)]))

# ---- pivot: blind bolt hole + captive-nut slot opening to +x ----
boolean(cradle, along_y(prism("bolt", circle(BOLT_D / 2, 48), -TOOTH_H - 1, BOSS_LEN - 3)))
hexa = circle(NUT_D / 2, 6)
def hull(pts):
    pts = sorted(set(pts))
    def half(seq):
        out = []
        for p in seq:
            while len(out) >= 2 and (out[-1][0] - out[-2][0]) * (p[1] - out[-2][1]) - (out[-1][1] - out[-2][1]) * (p[0] - out[-2][0]) <= 0:
                out.pop()
            out.append(p)
        return out[:-1]
    return half(pts) + half(pts[::-1])
slot = hull([(round(x, 4), round(y, 4)) for x, y in hexa + [(x + ROSETTE_R + 1, y) for x, y in hexa]])
boolean(cradle, along_y(prism("nut", slot, 4.0, 4.0 + NUT_H)))

# ---- drainage / flex windows (none on the boss side) ----
WIN = 14.0
for a in (0, 60, 120, 240, 300):
    x0 = ROSETTE_R + 5 if a in (120, 240) else TB + LIP_T + 8
    x1 = TE - 9
    if x1 - x0 <= WIN:
        continue
    pts = [(x0 + WIN / 2 + WIN / 2 * math.cos(t), WIN / 2 * math.sin(t)) for t in [math.pi / 2 + math.pi * i / 24 for i in range(25)]]
    pts += [(x1 - WIN / 2 + WIN / 2 * math.cos(t), WIN / 2 * math.sin(t)) for t in [-math.pi / 2 + math.pi * i / 24 for i in range(25)]]
    w = prism(f"win{a}", pts, 0.0, OA + OB)                       # local +z radial
    w.data.transform(__import__("mathutils").Matrix.Rotation(math.radians(a), 4, "X"))
    w.data.transform(__import__("mathutils").Matrix.Translation((0, CY, 0)))
    boolean(cradle, w)

# ---- check + export ----
bm = bmesh.new()
bm.from_mesh(cradle.data)
bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
bad = sum(1 for e in bm.edges if not e.is_manifold)
bm.to_mesh(cradle.data)
bm.free()
par = list(range(len(cradle.data.vertices)))
def root(i):
    while par[i] != i:
        par[i] = par[par[i]]
        i = par[i]
    return i
for e in cradle.data.edges:
    par[root(e.vertices[0])] = root(e.vertices[1])
bodies = len({root(i) for i in range(len(par))})
xs, ys, zs = zip(*(v.co[:] for v in cradle.data.vertices))
print(f"cradle: {len(cradle.data.polygons)} faces, non-manifold {bad}, bodies {bodies}, "
      f"x {min(xs):.1f}..{max(xs):.1f} y {min(ys):.1f}..{max(ys):.1f} z {min(zs):.1f}..{max(zs):.1f}")
if bad or bodies != 1:
    sys.exit("cradle mesh is not a single watertight body")
bpy.ops.object.select_all(action="DESELECT")
cradle.select_set(True)
bpy.ops.wm.stl_export(filepath=os.path.join(HERE, "cradle.stl"), export_selected_objects=True, ascii_format=False)
print("wrote cradle.stl")

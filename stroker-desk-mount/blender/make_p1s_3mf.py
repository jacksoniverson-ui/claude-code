"""stroker_mount_plate.3mf (plain, from prepare_plate.py) -> Bambu P1S PETG project."""
import os, re, json, zipfile
TC = "/Users/jackiverson/canopy/hardware/trim-cell-ue/print_model"
src = open(os.path.join(TC, "make_3mf.py")).read(); g = {"__file__": os.path.join(TC, "make_3mf.py")}
cwd = os.getcwd(); os.chdir(TC); exec(src[:src.index("os.makedirs(OUT, exist_ok=True)")], g); os.chdir(cwd)
CT, RELS, project_config, _s, MODEL_HEAD = (g[k] for k in ("CT", "RELS", "project_config", "_s", "MODEL_HEAD"))
hp = open("/Users/jackiverson/canopy/hardware/hash-hole-press/print_model/make_3mf.py").read()
PETG = eval(hp[hp.index("PETG = {"):hp.index("def petg_config")].split("=", 1)[1])
D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
m = zipfile.ZipFile(f"{D}/stroker_mount_plate.3mf").read("3D/3dmodel.model").decode()
DX, DY = 14.0, 24.0                      # clear the P1S front-left exclusion zone (x<18, y<28) + brim
objs, cfgs, items, inst = [], [], [], []
for i, ob in enumerate(re.finditer(r'<object id="(\d+)" name="([^"]+)" type="model"><mesh><vertices>(.*?)</vertices>(<triangles>.*?</triangles>)', m)):
    oid, name = i + 1, ob.group(2)
    verts = re.sub(r'<vertex x="([-\d.]+)" y="([-\d.]+)" z="([-\d.]+)"/>',
                   lambda v: '<vertex x="%.4f" y="%.4f" z="%s"/>' % (float(v.group(1)) + DX, float(v.group(2)) + DY, v.group(3)), ob.group(3))
    objs.append(f'<object id="{oid}" type="model"><mesh><vertices>{verts}</vertices>{ob.group(4)}</mesh></object>')
    items.append(f'<item objectid="{oid}" transform="1 0 0 0 1 0 0 0 1 0 0 0" printable="1"/>')
    st = _s(walls=4, infill=35, support=(name == "cradle"), brim=3.0 if name in ("cradle", "clamp") else 0)
    cfgs.append(f'<object id="{oid}"><metadata key="name" value="{name}"/><metadata key="extruder" value="1"/>{st}'
                f'<part id="1" subtype="normal_part"><metadata key="name" value="{name}"/><metadata key="extruder" value="1"/></part></object>')
    inst.append(f'<model_instance><metadata key="object_id" value="{oid}"/><metadata key="instance_id" value="0"/></model_instance>')
cfg = json.loads(project_config(["black"], "plants"))
cfg.update(PETG); cfg["sparse_infill_pattern"] = "gyroid"; cfg["name"] = "Stroker desk mount PETG"
cf = ('<?xml version="1.0" encoding="UTF-8"?>\n<config>' + "".join(cfgs) +
      '<plate><metadata key="plater_id" value="1"/><metadata key="plater_name" value="stroker mount"/>' + "".join(inst) + '</plate></config>')
out = f"{D}/stroker_mount_P1S_PETG.3mf"
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", CT); z.writestr("_rels/.rels", RELS)
    z.writestr("3D/3dmodel.model", MODEL_HEAD + f'<resources>{"".join(objs)}</resources><build>{"".join(items)}</build></model>')
    z.writestr("Metadata/model_settings.config", cf); z.writestr("Metadata/project_settings.config", json.dumps(cfg, indent=1))
print("wrote", out, len(objs), "objects")

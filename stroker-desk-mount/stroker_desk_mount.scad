// Stroker desk mount - parametric
// NOTE 2026-09-26: cradle.stl now comes from blender/build_cradle.py (oval 125 x 65 x 60 sleeve).
// cradle() below is the original round design, kept for reference. clamp/knob/pad still export from here.
// ------------------------------------------------------------
// Four printed parts:
//   clamp  - C-clamp for the desk edge, with a toothed pivot ear
//   cradle - tube that grips the sleeve body, lip locks into the waist
//   knob   - star knob that holds an M8 hex bolt head (print 2)
//   pad    - swivel pad for the tip of the clamp bolt
//
// Hardware: 2x M8x60 hex bolt, 2x M8 hex nut.
//
// Export one part at a time, e.g.:
//   openscad -D 'part="cradle"' -o cradle.stl stroker_desk_mount.scad
//
// All dimensions in mm. MEASURE YOUR SLEEVE and edit the first block.

part = "assembly"; // [assembly, clamp, cradle, knob, pad]

/* [Sleeve - measure yours] */
body_d     = 72;   // diameter of the wide (entrance) section
body_len   = 75;   // length of the wide section, entrance face -> start of waist
waist_d    = 55;   // diameter at the narrowest point of the waist
rear_d     = 64;   // diameter of the rear flare (only used for the preview)
sleeve_len = 150;  // overall length (only used for the preview)

/* [Fit] */
squeeze    = 1.0;  // cradle bore is this much smaller than body_d (grip)
lip_play   = 2.0;  // lip bore is this much bigger than waist_d

/* [Desk] */
desk_max   = 50;   // widest desk top the clamp opens to
jaw_depth  = 60;   // how far the jaws reach in over the desk

/* [Pivot position, relative to the top front edge of the desk] */
pivot_fwd  = 40;   // forward of the desk edge
pivot_up   = 45;   // above the desk top (make negative to hang below)

/* [Structure] */
wall       = 3.2;  // cradle wall
lip_t      = 4;    // thickness of the retaining lip
clamp_t    = 16;   // clamp jaw / spine thickness
clamp_w    = 40;   // clamp width (also the pivot ear thickness)
rosette_r  = 22;   // pivot tooth disc radius
teeth      = 24;   // 24 teeth = 15 degree steps
tooth_h    = 2.5;
boss_len   = 16;   // cradle boss, tooth face to tube wall

/* [Hardware] */
bolt_d     = 8.6;  // M8 clearance
nut_af     = 13.3; // M8 nut across flats + clearance
nut_h      = 6.8;
head_af    = 13.3; // M8 hex head across flats + clearance
head_h     = 5.6;

$fn = 96;
eps = 0.01;

tube_len = body_len - 3;           // entrance sits ~10 mm proud of the tube
R_in     = (body_d - squeeze) / 2;
R_out    = R_in + wall;
R_lip    = (waist_d + lip_play) / 2;
nut_d    = nut_af / cos(30);       // across corners

// ------------------------------------------------------------
// Hirth-style tooth ring, sitting on z=0, teeth pointing +z.
// Tooth height grows with radius so any two rosettes mesh flat.
module rosette(ro = rosette_r, ri = 5, n = teeth, h = tooth_h) {
    m = 2 * n;
    zt = function(k, r) (k % 2 == 0) ? 0 : h * r / ro;
    pts = concat(
        [for (k = [0:m-1]) [ri*cos(k*180/n), ri*sin(k*180/n), zt(k, ri)]],  // top inner
        [for (k = [0:m-1]) [ro*cos(k*180/n), ro*sin(k*180/n), zt(k, ro)]],  // top outer
        [for (k = [0:m-1]) [ri*cos(k*180/n), ri*sin(k*180/n), -1]],         // bottom inner
        [for (k = [0:m-1]) [ro*cos(k*180/n), ro*sin(k*180/n), -1]]          // bottom outer
    );
    ti = function(k) k % m;
    to = function(k) m + k % m;
    bi = function(k) 2*m + k % m;
    bo = function(k) 3*m + k % m;
    polyhedron(pts, concat(
        [for (k = [0:m-1]) [ti(k), ti(k+1), to(k+1), to(k)]],
        [for (k = [0:m-1]) [bi(k), bo(k), bo(k+1), bi(k+1)]],
        [for (k = [0:m-1]) [to(k), to(k+1), bo(k+1), bo(k)]],
        [for (k = [0:m-1]) [ti(k), bi(k), bi(k+1), ti(k+1)]]
    ));
}

// ------------------------------------------------------------
// CLAMP. Origin = top front edge of the desk. +x toward you, +z up.
// Printed lying on its side (the -y face), teeth up.
module clamp_profile() {
    r = 3;
    offset(r = r) offset(delta = -r) union() {
        translate([-jaw_depth, 0]) square([jaw_depth + clamp_t, clamp_t]);                   // top jaw
        translate([0, -desk_max - clamp_t]) square([clamp_t, desk_max + 2*clamp_t]);         // spine
        translate([-jaw_depth, -desk_max - clamp_t]) square([jaw_depth + clamp_t, clamp_t]); // bottom jaw
        hull() {                                                                             // pivot ear
            translate([-25, 0]) square([25 + clamp_t, clamp_t]);
            translate([pivot_fwd, pivot_up]) circle(r = rosette_r);
        }
        hull() {                                                                             // ear brace
            translate([0, -desk_max / 2]) square([clamp_t, desk_max / 2 + clamp_t]);
            translate([pivot_fwd, pivot_up]) circle(r = rosette_r);
        }
    }
    // inside-corner fillets on the spine side
    for (z = [0, -desk_max]) translate([0, z])
        mirror([0, z == 0 ? 1 : 0]) difference() {
            translate([-4, 0]) square(4);
            translate([-4, 4]) circle(r = 4);
        }
}

module clamp() {
    screw_x = -jaw_depth / 2 + 5;
    difference() {
        union() {
            rotate([90, 0, 0]) linear_extrude(height = clamp_w, center = true) clamp_profile();
            translate([pivot_fwd, clamp_w / 2 - eps, pivot_up]) rotate([-90, 0, 0]) rosette();
        }
        // pivot bolt
        translate([pivot_fwd, 0, pivot_up]) rotate([90, 0, 0]) cylinder(d = bolt_d, h = 3 * clamp_w, center = true);
        // clamp screw + captive nut (nut drops in from inside the C)
        translate([screw_x, 0, -desk_max - clamp_t - 1]) cylinder(d = bolt_d, h = clamp_t + 2);
        translate([screw_x, 0, -desk_max - nut_h]) rotate([0, 0, 30]) cylinder(d = nut_d, h = nut_h + 1, $fn = 6);
    }
}

// ------------------------------------------------------------
// CRADLE. Origin = pivot centre, tooth face at y=0 facing -y.
// Tube axis runs along +x (toward you); lip is at the back end.
// Print standing on the lip end.
tube_back = -rosette_r;
tube_cy   = boss_len + R_out;

module tube_profile() {   // (r, axial) for rotate_extrude, axial 0 = lip end
    offset(r = 0.8) offset(delta = -0.8) polygon([
        [R_lip + 1.2, 0], [R_out, 0], [R_out, tube_len], [R_in + 1.5, tube_len],
        [R_in, tube_len - 3], [R_in, lip_t + 3], [R_lip, lip_t], [R_lip, 1.2]
    ]);
}

module cradle() {
    win_w = 14;
    difference() {
        union() {
            translate([tube_back, tube_cy, 0]) rotate([0, 90, 0]) rotate_extrude() tube_profile();
            // boss joining the pivot to the tube
            rotate([-90, 0, 0]) cylinder(r = rosette_r, h = tube_cy);
            rotate([90, 0, 0]) translate([0, 0, -eps]) rosette();
        }
        // keep the bore clear of the boss
        translate([tube_back + lip_t + 3, tube_cy, 0]) rotate([0, 90, 0]) cylinder(r = R_in - eps, h = tube_len);
        // blind pivot hole + captive nut, nut drops in from the front (+x)
        rotate([-90, 0, 0]) translate([0, 0, -tooth_h - 1]) cylinder(d = bolt_d, h = tooth_h + 1 + boss_len + 0.5);
        translate([0, 4, 0]) rotate([-90, 0, 0]) rotate([0, 0, 0]) hull() {
            cylinder(d = nut_d, h = nut_h, $fn = 6);
            translate([rosette_r + 1, 0, 0]) cylinder(d = nut_d, h = nut_h, $fn = 6);
        }
        // drainage / flex windows (none on the boss side)
        for (a = [0, 60, 120, 240, 300]) {
            x0 = (a == 120 || a == 240) ? rosette_r + 5 : tube_back + lip_t + 8;
            x1 = tube_back + tube_len - 9;
            if (x1 - x0 > win_w)
                translate([0, tube_cy, 0]) rotate([a, 0, 0])
                    hull() for (x = [x0 + win_w/2, x1 - win_w/2])
                        translate([x, 0, 0]) rotate([0, 0, 0]) cylinder(d = win_w, h = R_out + 2);
        }
    }
}

// ------------------------------------------------------------
module knob() {
    h = 10;
    difference() {
        union() {
            cylinder(r = 13, h = h);
            for (i = [0:5]) rotate([0, 0, i * 60]) translate([15, 0, 0]) cylinder(r = 7, h = h);
            hull() for (i = [0:5]) rotate([0, 0, i * 60]) translate([10, 0, 0]) cylinder(r = 5, h = h);
        }
        translate([0, 0, -1]) cylinder(d = bolt_d, h = h + 2);
        translate([0, 0, h - head_h]) cylinder(d = head_af / cos(30), h = head_h + 1, $fn = 6);
    }
}

module pad() {
    difference() {
        cylinder(d = 30, h = 6);
        translate([0, 0, 2]) cylinder(d = bolt_d, h = 5);
    }
}

// ------------------------------------------------------------
module sleeve_ghost() {
    rotate_extrude() polygon([
        [0, 0], [body_d/2 - 3, 0], [body_d/2, 3], [body_d/2, body_len - 3],
        [waist_d/2, body_len + 5], [waist_d/2, body_len + 15],
        [rear_d/2, sleeve_len - 5], [rear_d/2 - 5, sleeve_len], [0, sleeve_len]
    ]);
}

module desk() {
    color("burlywood", 0.5) translate([-300, -150, -25]) cube([300, 300, 25]);
}

if (part == "clamp") clamp();
else if (part == "cradle") cradle();
else if (part == "knob") knob();
else if (part == "pad") pad();
else {
    desk();
    color("dimgray") clamp();
    translate([pivot_fwd, clamp_w / 2 + tooth_h, pivot_up]) {
        color("silver") cradle();
        // sleeve: entrance flush-ish with the tube mouth, waist in the lip
        color("peachpuff", 0.6)
            translate([tube_back + lip_t + 3 + body_len, tube_cy, 0]) rotate([0, -90, 0]) sleeve_ghost();
    }
    color("dimgray") translate([pivot_fwd, -clamp_w / 2, pivot_up]) rotate([90, 0, 0]) knob();
}

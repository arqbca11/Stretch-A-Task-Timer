// The die. A CPU ray tracer plus a small physics loop, ported verbatim from the Roll app
// (legacy/roll/src/js/app.js; see legacy/roll/README.md for a map). The die is a cube
// intersected with a sphere, satin white plastic under one desk lamp, with a real soft shadow
// on the table. Chinese-style: the 1 and the 4 are red.
//
// What changed in the port: the Roll page's `state` became a local lifecycle (roll → bounce →
// land → vanish → onDone), the roll stops by itself after a moment instead of on a click (a
// click still stops it early), the table's `--table` colour comes from Stretch's theme, and
// `thud` (which shook the Roll app's dial) is gone. The renderer and the physics are untouched.
// The face it lands on is decorative — the rolled number was always drawn separately.
//
// The die is drawn at the Roll app's 76px and scaled to half by .st-die in the CSS, so it lands
// about as wide as a block.
export { rollDie, cancelRoll, dieBusy };

"use strict";

// cube rotation (x, y in degrees) that brings each face to the front
var FACE_ROT = { 1:[0,0], 6:[0,180], 2:[0,-90], 5:[0,90], 3:[-90,0], 4:[90,0] };
var TILT_X = -16, TILT_Y = 22;   // resting tilt so three faces show
var anim = { x: 0, y: 0, vx: 0, vy: 0, raf: 0, n: null, face: 1 };
// ---- ray-traced die ----------------------------------------------------------------
// Shape: a cube intersected with a sphere centred on it, the classic dice shape. Edges stay
// crisp (just a hair of softening) while each corner is a big spherical cap.
var DH = 38;         // half the cube's size (the die box is 76px)
var RS = 54.5;       // sphere radius: DH*sqrt2 = 53.7 rounds the edges away entirely, DH*sqrt3 = 65.8 does nothing
var SOFT = 1.6;      // width of the slight softening where two surfaces meet
var CAM = 420;       // camera distance, for perspective
var VIEW = 140;      // canvas size in CSS px (room for rotated corners and vertical blur)
var SS = 2;          // render at 2x for smooth edges
var PIP_G = 17, PIP_R = 5.6, PIP_R1 = 12.5, CONE = 0.8;
var PIP_UV = { 1:[[0,0]], 2:[[-1,-1],[1,1]], 3:[[-1,-1],[0,0],[1,1]], 4:[[-1,-1],[1,-1],[-1,1],[1,1]],
               5:[[-1,-1],[1,-1],[0,0],[-1,1],[1,1]], 6:[[-1,-1],[-1,0],[-1,1],[1,-1],[1,0],[1,1]] };
// local axes: x right, y down, z toward the viewer (CSS convention). Face value, and the face's
// own right (U) / down (V) directions, for each axis direction; 1 and 4 are red.
var FACEINFO = {};
[[2,1,1,[1,0,0],[0,1,0]], [2,-1,6,[-1,0,0],[0,1,0]], [0,1,2,[0,0,-1],[0,1,0]],
 [0,-1,5,[0,0,1],[0,1,0]], [1,-1,3,[1,0,0],[0,0,1]], [1,1,4,[1,0,0],[0,0,-1]]].forEach(function(f){
  var val = f[2], r = val === 1 ? PIP_R1 : PIP_R;
  FACEINFO[f[0] + (f[1] > 0 ? "+" : "-")] = { U: f[3], V: f[4], red: val === 1 || val === 4,
    pips: PIP_UV[val].map(function(c){ return [c[0] * PIP_G, c[1] * PIP_G, r]; }) };
});
// a desk lamp to the viewer's left, a little in front of the screen and above (view space, px)
var LAMP = [-120, -190, 260];
var LAMP_R = 26;                   // lamp size, for soft shadow edges
var WHITE = [0.955, 0.948, 0.928], BLACK = [0.05, 0.05, 0.055], RED = [0.72, 0.09, 0.07];
function norm(v){ var m = Math.hypot(v[0], v[1], v[2]); return [v[0]/m, v[1]/m, v[2]/m]; }
// CSS "rotateX(a) rotateY(b)" maps a vector v to Rx(a) * Ry(b) * v
function rotateVec(v, ax, ay){
  var a = ax * Math.PI / 180, b = ay * Math.PI / 180;
  var x1 = v[0] * Math.cos(b) + v[2] * Math.sin(b), y1 = v[1], z1 = -v[0] * Math.sin(b) + v[2] * Math.cos(b);
  return [x1, y1 * Math.cos(a) - z1 * Math.sin(a), y1 * Math.sin(a) + z1 * Math.cos(a)];
}

// ---- renderer: everything that doesn't change between frames is precomputed once ----------
var canvasEl = document.createElement("canvas");
var CW = Math.round(VIEW * SS);
canvasEl.width = canvasEl.height = CW;
var ctx2 = canvasEl.getContext("2d");
var frame = ctx2.createImageData(CW, CW);
var buf32 = new Uint32Array(frame.data.buffer);        // one write per pixel (little-endian RGBA)
var INV_RS = 1 / RS, INV_SOFT = 1 / SOFT;
var SH = [0, 0, 0];                                   // shade() output, reused

// The bounding sphere looks identical from every rotation, so which pixels can see the die, their
// ray directions, and where each ray enters/leaves the sphere never change. Only those pixels are
// visited each frame; the rest of the canvas stays transparent.
var BLUR_MARGIN = 12;   // px of vertical smear allowed beyond the die's bounding circle
var RAY = (function(){
  var idx = [], dx = [], dy = [], dz = [], bay = [];
  var reach = CAM * Math.tan(Math.asin(RS / CAM)) + BLUR_MARGIN;
  // 4x4 Bayer order: each 2x2 block of render pixels (one CSS pixel) gets four well-spread time slots
  var B4 = [0,8,2,10, 12,4,14,6, 3,11,1,9, 15,7,13,5];
  for (var j = 0; j < CW; j++){
    for (var i = 0; i < CW; i++){
      var sx = (i + 0.5) / SS - VIEW / 2, sy = (j + 0.5) / SS - VIEW / 2;
      if (sx * sx + sy * sy > reach * reach) continue;
      var il = 1 / Math.sqrt(sx * sx + sy * sy + CAM * CAM);
      idx.push(j * CW + i); dx.push(sx * il); dy.push(sy * il); dz.push(-CAM * il);
      bay.push(B4[(j & 3) * 4 + (i & 3)]);
    }
  }
  return { n: idx.length, idx: Int32Array.from(idx), dx: Float64Array.from(dx), dy: Float64Array.from(dy),
           dz: Float64Array.from(dz), bay: Uint8Array.from(bay) };
})();

// ---- motion blur: the shutter stays open for part of the frame. Each pixel picks one moment
// inside that interval (by the Bayer pattern above) and renders the die as it was then; the
// browser's 2x downscale averages four moments per screen pixel. Same cost as a sharp frame.
var MB_SAMPLES = 16;
var SAMP = new Float64Array(MB_SAMPLES * 14);   // per moment: rotation (9), camera origin (3), lift, dy

// satin plastic under one lamp:
//  - a soft, blurry highlight blob that sits where the lamp reflects, and slides across faces as they turn
//  - that highlight is broken up by micro-grain: satin is a textured surface, so its sheen sparkles faintly
//  - wrapped diffuse (light bleeds past the terminator, like the subsurface glow of white plastic)
//  - the lamp is close, so light falls off across the die: faces get gradients instead of flat fills
//  - a sheen at grazing angles, and slightly warm shadows
// powers by repeated squaring instead of Math.pow
var LAMP_D = Math.hypot(LAMP[0], LAMP[1], LAMP[2]);
var REFLECT = 0.85;                       // how much of the Fresnel reflection shows
var ENV_S = [1.0, 1.0, 1.0], ENV_G = [0.8, 0.84, 0.81];   // room above / table below (set from the theme)
function readEnv(){
  try {
    var c = getComputedStyle(document.documentElement).getPropertyValue("--table").trim();
    var m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c);
    if (m){
      var tr = parseInt(m[1], 16) / 255, tg = parseInt(m[2], 16) / 255, tb = parseInt(m[3], 16) / 255;
      var dark = tr + tg + tb < 1.2;
      ENV_G = [tr * 0.88, tg * 0.88, tb * 0.88];
      ENV_S = dark ? [0.72, 0.74, 0.74] : [1.0, 1.0, 1.0];
    }
  } catch(e){}
}
function shade(n0, n1, n2, alb, ao, L0, L1, L2, H0, H1, H2, V0, V1, V2, g, atten, refK){
  var ndl = n0 * L0 + n1 * L1 + n2 * L2;
  var wrap = (ndl + 0.3) / 1.3; if (wrap < 0) wrap = 0;
  var ndv = n0 * V0 + n1 * V1 + n2 * V2; if (ndv < 0) ndv = 0;
  var h = n0 * H0 + n1 * H1 + n2 * H2; if (h < 0) h = 0;
  var h2 = h * h, h4 = h2 * h2, h8 = h4 * h4, h16 = h8 * h8, h32 = h16 * h16;
  var sp = (0.2 * h32 * h16 * (0.35 + 1.3 * g) + 0.045 * h4 * h2) * atten;   // h^48 textured blob + broad h^6
  var lum = (0.6 + 0.43 * wrap * atten + 0.05 * (0.5 - 0.5 * n1)) * ao * (1 + (g - 0.5) * 0.06);
  var warm = (1 - wrap) * 0.05;
  var r = alb[0] * lum + sp, gg = alb[1] * lum * (1 - warm * 0.45) + sp, b = alb[2] * lum * (1 - warm) + sp;
  // reflection of the room: the view ray bounced off the surface looks up at a bright room or down at
  // the table. Schlick's Fresnel: ~6% straight on, climbing toward grazing angles. Blurred by nature
  // (a smooth sky/table gradient), which keeps it satin rather than mirror.
  var rx = 2 * ndv * n0 - V0, ry = 2 * ndv * n1 - V1;                    // screen y: negative = up
  var t = 0.5 - ry * 2.2; t = t < 0 ? 0 : t > 1 ? 1 : t; t = t * t * (3 - 2 * t);
  var side = 0.5 - rx * 0.9; side = side < 0 ? 0 : side > 1 ? 1 : side;   // the lamp side of the room is brighter
  var sk = 0.74 + 0.26 * side;
  var er = ENV_G[0] + (ENV_S[0] * sk - ENV_G[0]) * t, eg = ENV_G[1] + (ENV_S[1] * sk - ENV_G[1]) * t, eb = ENV_G[2] + (ENV_S[2] * sk - ENV_G[2]) * t;
  var f5 = 1 - ndv, f2 = f5 * f5; f5 = f2 * f2 * f5;
  var refl = (0.06 + 0.94 * f5) * refK * ao;
  r += (er - r) * refl; gg += (eg - gg) * refl; b += (eb - b) * refl;
  SH[0] = r > 1 ? 1 : r; SH[1] = gg > 1 ? 1 : gg; SH[2] = b > 1 ? 1 : b;
}
// surface grain: a hash of the point snapped to a fine lattice in die space (0..1), so it's fixed
// to the plastic and turns with the die instead of shimmering on the screen
function grainAt(p0, p1, p2){
  var x = Math.floor(p0 * 1.25), y = Math.floor(p1 * 1.25), z = Math.floor(p2 * 1.25);
  var hsh = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return hsh - Math.floor(hsh);
}

var PR = new Float32Array(CW * CW), PG = new Float32Array(CW * CW), PB = new Float32Array(CW * CW), PA = new Float32Array(CW * CW);
var QR = new Float32Array(CW * CW), QG = new Float32Array(CW * CW), QB = new Float32Array(CW * CW), QA = new Float32Array(CW * CW);
function resolveBlur(){
  var n = CW * CW, i, x, y, k, a;
  for (i = 0; i < n; i++){
    var c = buf32[i]; a = (c >>> 24) / 255;
    PR[i] = (c & 255) * a; PG[i] = ((c >>> 8) & 255) * a; PB[i] = ((c >>> 16) & 255) * a; PA[i] = a;
  }
  for (y = 0; y < CW; y++){                       // horizontal [1 2 1]
    var row = y * CW;
    for (x = 0; x < CW; x++){
      k = row + x; var l = x > 0 ? k - 1 : k, rr = x < CW - 1 ? k + 1 : k;
      QR[k] = (PR[l] + 2 * PR[k] + PR[rr]) * 0.25; QG[k] = (PG[l] + 2 * PG[k] + PG[rr]) * 0.25;
      QB[k] = (PB[l] + 2 * PB[k] + PB[rr]) * 0.25; QA[k] = (PA[l] + 2 * PA[k] + PA[rr]) * 0.25;
    }
  }
  for (y = 0; y < CW; y++){                       // vertical [1 2 1], then un-premultiply
    for (x = 0; x < CW; x++){
      k = y * CW + x; var u = y > 0 ? k - CW : k, d = y < CW - 1 ? k + CW : k;
      a = (QA[u] + 2 * QA[k] + QA[d]) * 0.25;
      if (a < 0.004){ buf32[k] = 0; continue; }
      var ia = 1 / a;
      var r = (QR[u] + 2 * QR[k] + QR[d]) * 0.25 * ia, g = (QG[u] + 2 * QG[k] + QG[d]) * 0.25 * ia, b = (QB[u] + 2 * QB[k] + QB[d]) * 0.25 * ia;
      buf32[k] = ((a * 255) << 24) | ((b > 255 ? 255 : b) << 16) | ((g > 255 ? 255 : g) << 8) | (r > 255 ? 255 : r);
    }
  }
}

// blurX/blurY/blurLift: how far the die rotated / rose during the open shutter (0 = sharp frame)
function renderDie(ax, ay, blurX, blurY, blurLift){
  var K = (blurX || blurY || blurLift) ? MB_SAMPLES : 1;   // MB_SAMPLES must be 16 (the Bayer pattern)
  for (var s = 0; s < K; s++){
    var f = K === 1 ? 0 : s / (K - 1) - 1;                 // -1 .. 0: from shutter open to now
    var sax = ax + (blurX || 0) * f, say = ay + (blurY || 0) * f, sl = phys.y + (blurLift || 0) * f;
    var ccx = rotateVec([1,0,0], sax, say), ccy = rotateVec([0,1,0], sax, say), ccz = rotateVec([0,0,1], sax, say);
    var dyk = sl - phys.y;                                 // die higher than now -> camera sits lower relative to it
    var b = s * 14;
    SAMP[b] = ccx[0]; SAMP[b+1] = ccx[1]; SAMP[b+2] = ccx[2];
    SAMP[b+3] = ccy[0]; SAMP[b+4] = ccy[1]; SAMP[b+5] = ccy[2];
    SAMP[b+6] = ccz[0]; SAMP[b+7] = ccz[1]; SAMP[b+8] = ccz[2];
    // camera (0, dyk, CAM) relative to the die centre, expressed in die space
    SAMP[b+9] = ccx[1] * dyk + ccx[2] * CAM; SAMP[b+10] = ccy[1] * dyk + ccy[2] * CAM; SAMP[b+11] = ccz[1] * dyk + ccz[2] * CAM;
    SAMP[b+12] = sl; SAMP[b+13] = dyk;
  }
  var LX = LAMP[0], LY = LAMP[1], LZ = LAMP[2], R2 = RS * RS, CAM2 = CAM * CAM;
  var RDX = RAY.dx, RDY = RAY.dy, RDZ = RAY.dz, RIDX = RAY.idx, RBAY = RAY.bay;
  for (var r = 0, N = RAY.n; r < N; r++){
    var vx = RDX[r], vy = RDY[r], vz = RDZ[r];
    var sb = K === 1 ? 0 : RBAY[r] * 14;   // K is 16: one moment per Bayer slot
    var dyk2 = SAMP[sb + 13], lift = SAMP[sb + 12];
    // bounding sphere (rotation-invariant): camera at (0, dyk, CAM) relative to the die centre
    var bq = dyk2 * vy + CAM * vz, disc = bq * bq - (dyk2 * dyk2 + CAM2 - R2);
    var o = RIDX[r];
    if (disc < 0){ buf32[o] = 0; continue; }
    var sqd = Math.sqrt(disc), ts0 = -bq - sqd, ts1 = -bq + sqd;
    var X0 = SAMP[sb], X1 = SAMP[sb+1], X2 = SAMP[sb+2], Y0 = SAMP[sb+3], Y1 = SAMP[sb+4], Y2 = SAMP[sb+5];
    var Z0 = SAMP[sb+6], Z1 = SAMP[sb+7], Z2 = SAMP[sb+8], O0 = SAMP[sb+9], O1 = SAMP[sb+10], O2 = SAMP[sb+11];
    var D0 = X0 * vx + X1 * vy + X2 * vz, D1 = Y0 * vx + Y1 * vy + Y2 * vz, D2 = Z0 * vx + Z1 * vy + Z2 * vz;
    // cube slabs, unrolled
    var inv = 1 / D0, t1 = (-DH - O0) * inv, t2 = (DH - O0) * inv, tt;
    if (t1 > t2){ tt = t1; t1 = t2; t2 = tt; }
    var tmin = t1, tmax = t2, hitAx = 0;
    inv = 1 / D1; t1 = (-DH - O1) * inv; t2 = (DH - O1) * inv;
    if (t1 > t2){ tt = t1; t1 = t2; t2 = tt; }
    if (t1 > tmin){ tmin = t1; hitAx = 1; } if (t2 < tmax) tmax = t2;
    inv = 1 / D2; t1 = (-DH - O2) * inv; t2 = (DH - O2) * inv;
    if (t1 > t2){ tt = t1; t1 = t2; t2 = tt; }
    if (t1 > tmin){ tmin = t1; hitAx = 2; } if (t2 < tmax) tmax = t2;
    var tIn = tmin > ts0 ? tmin : ts0, tOut = tmax < ts1 ? tmax : ts1;
    if (tIn > tOut){ buf32[o] = 0; continue; }

    var p0 = O0 + D0 * tIn, p1 = O1 + D1 * tIn, p2 = O2 + D2 * tIn;
    var onSphere = ts0 >= tmin, n0, n1, n2;
    if (onSphere){ n0 = p0 * INV_RS; n1 = p1 * INV_RS; n2 = p2 * INV_RS; }
    else {
      n0 = 0; n1 = 0; n2 = 0;
      if (hitAx === 0) n0 = p0 > 0 ? 1 : -1; else if (hitAx === 1) n1 = p1 > 0 ? 1 : -1; else n2 = p2 > 0 ? 1 : -1;
    }
    // a hair of softening where surfaces meet
    var dq;
    if (onSphere || hitAx !== 0){ dq = DH - (p0 < 0 ? -p0 : p0); if (dq < SOFT) n0 += (p0 > 0 ? 0.9 : -0.9) * (1 - dq * INV_SOFT); }
    if (onSphere || hitAx !== 1){ dq = DH - (p1 < 0 ? -p1 : p1); if (dq < SOFT) n1 += (p1 > 0 ? 0.9 : -0.9) * (1 - dq * INV_SOFT); }
    if (onSphere || hitAx !== 2){ dq = DH - (p2 < 0 ? -p2 : p2); if (dq < SOFT) n2 += (p2 > 0 ? 0.9 : -0.9) * (1 - dq * INV_SOFT); }
    if (!onSphere){
      var ds = RS - Math.sqrt(p0 * p0 + p1 * p1 + p2 * p2);
      if (ds < SOFT){ var w = (1 - ds * INV_SOFT) * 0.9 * INV_RS; n0 += p0 * w; n1 += p1 * w; n2 += p2 * w; }
    }
    var nl = 1 / Math.sqrt(n0 * n0 + n1 * n1 + n2 * n2); n0 *= nl; n1 *= nl; n2 *= nl;

    // light from the lamp to this point (die centre is lifted by the hop)
    var wx = X0 * p0 + Y0 * p1 + Z0 * p2, wy = X1 * p0 + Y1 * p1 + Z1 * p2 - lift, wz = X2 * p0 + Y2 * p1 + Z2 * p2;
    var L0 = LX - wx, L1 = LY - wy, L2 = LZ - wz, lm = 1 / Math.sqrt(L0 * L0 + L1 * L1 + L2 * L2);
    L0 *= lm; L1 *= lm; L2 *= lm;
    var atten = LAMP_D * lm; atten = 0.4 + 0.6 * atten * atten;   // softened inverse-square falloff, 1 at the die centre
    // view direction is this pixel's own ray (reversed), so highlights have a real position on the face
    var V0 = -vx, V1 = -vy, V2 = -vz;
    var H0 = L0 + V0, H1 = L1 + V1, H2 = L2 + V2, hm = 1 / Math.sqrt(H0 * H0 + H1 * H1 + H2 * H2);
    H0 *= hm; H1 *= hm; H2 *= hm;

    var grain = grainAt(p0, p1, p2);
    shade(X0 * n0 + Y0 * n1 + Z0 * n2, X1 * n0 + Y1 * n1 + Z1 * n2, X2 * n0 + Y2 * n1 + Z2 * n2, WHITE, 1, L0, L1, L2, H0, H1, H2, V0, V1, V2, grain, atten, REFLECT);
    var cr = SH[0], cg = SH[1], cb = SH[2];

    // pips: drilled cones filled with paint
    if (!onSphere){
      var F = FACEINFO[hitAx + ((hitAx === 0 ? p0 : hitAx === 1 ? p1 : p2) > 0 ? "+" : "-")];
      var U = F.U, V = F.V;
      var u = p0 * U[0] + p1 * U[1] + p2 * U[2], v = p0 * V[0] + p1 * V[1] + p2 * V[2];
      var pips = F.pips;
      for (var e = 0; e < pips.length; e++){
        var pp = pips[e], du = u - pp[0], dv = v - pp[1], pr = pp[2], lim = pr + 1;
        if (du > lim || du < -lim || dv > lim || dv < -lim) continue;
        var d2 = du * du + dv * dv;
        if (d2 > lim * lim) continue;
        var d = Math.sqrt(d2) || 1e-4;
        var cover = (pr - d) * SS + 0.5; if (cover <= 0) break; if (cover > 1) cover = 1;
        var ru = du / d, rv = dv / d;
        var m0 = n0 - CONE * (U[0] * ru + V[0] * rv), m1 = n1 - CONE * (U[1] * ru + V[1] * rv), m2 = n2 - CONE * (U[2] * ru + V[2] * rv);
        var ml = 1 / Math.sqrt(m0 * m0 + m1 * m1 + m2 * m2); m0 *= ml; m1 *= ml; m2 *= ml;
        var aoPip = d < pr ? 0.55 + 0.45 * d / pr : 1;
        shade(X0 * m0 + Y0 * m1 + Z0 * m2, X1 * m0 + Y1 * m1 + Z1 * m2, X2 * m0 + Y2 * m1 + Z2 * m2,
              F.red ? RED : BLACK, aoPip, L0, L1, L2, H0, H1, H2, V0, V1, V2, grain, atten, REFLECT * 0.3);   // paint is duller
        cr += (SH[0] - cr) * cover; cg += (SH[1] - cg) * cover; cb += (SH[2] - cb) * cover;
        break;
      }
    }
    buf32[o] = 0xFF000000 | ((cb * 255) << 16) | ((cg * 255) << 8) | (cr * 255);
  }
  if (K > 1) resolveBlur();
  ctx2.putImageData(frame, 0, 0);
}

// ---- shadow on the table ----------------------------------------------------------
// The table is a horizontal plane under the die, seen from slightly above (the same 16-degree
// look-down as the die's resting tilt). From each table point, rays go to five spots on the lamp;
// the fraction the die blocks sets the darkness, which gives a real penumbra. The table points and
// the lamp directions never change, so they're precomputed; the shadow is traced at half
// resolution because it's blurred anyway.
var shCanvas = document.createElement("canvas");
var SH_W = 200, SH_H = 70, SH_X0 = -70, SH_Y0 = 18, SH_SS = 0.5;
var SW = Math.round(SH_W * SH_SS), SHH = Math.round(SH_H * SH_SS), SN = SW * SHH;
shCanvas.width = SW; shCanvas.height = SHH;
var shCtx = shCanvas.getContext("2d"), shImg = shCtx.createImageData(SW, SHH), sh32 = new Uint32Array(shImg.data.buffer);
var TILT = 16 * Math.PI / 180, TN = [0, -Math.cos(TILT), Math.sin(TILT)];
var LAMP_SAMPLES = [[0,0],[1,0],[-1,0],[0,1],[0,-1]], NS = LAMP_SAMPLES.length;
var TBL = (function(){
  var tx = new Float64Array(SN), ty = new Float64Array(SN), tz = new Float64Array(SN);
  var ex = new Float64Array(SN * NS), ey = new Float64Array(SN * NS), ez = new Float64Array(SN * NS);
  var toDie = norm([-LAMP[0], -LAMP[1], -LAMP[2]]);
  var s1 = norm([toDie[2], 0, -toDie[0]]);
  var s2 = [toDie[1]*s1[2] - toDie[2]*s1[1], toDie[2]*s1[0] - toDie[0]*s1[2], toDie[0]*s1[1] - toDie[1]*s1[0]];
  var lamps = LAMP_SAMPLES.map(function(q){
    return [LAMP[0] + LAMP_R * (q[0]*s1[0] + q[1]*s2[0]), LAMP[1] + LAMP_R * (q[0]*s1[1] + q[1]*s2[1]), LAMP[2] + LAMP_R * (q[0]*s1[2] + q[1]*s2[2])];
  });
  for (var j = 0; j < SHH; j++){
    for (var i = 0; i < SW; i++){
      var k = j * SW + i;
      var sx = SH_X0 + (i + 0.5) / SH_SS, sy = SH_Y0 + (j + 0.5) / SH_SS;
      var d = norm([sx, sy, -CAM]);
      var t = (DH * TN[1] - CAM * TN[2]) / (d[0] * TN[0] + d[1] * TN[1] + d[2] * TN[2]);
      tx[k] = d[0] * t; ty[k] = d[1] * t; tz[k] = CAM + d[2] * t;
      for (var m = 0; m < NS; m++){
        var e = norm([lamps[m][0] - tx[k], lamps[m][1] - ty[k], lamps[m][2] - tz[k]]);
        ex[k * NS + m] = e[0]; ey[k * NS + m] = e[1]; ez[k * NS + m] = e[2];
      }
    }
  }
  return { tx: tx, ty: ty, tz: tz, ex: ex, ey: ey, ez: ez };
})();
var shBlur = -1;
function renderShadow(ax, ay){
  var cx = rotateVec([1,0,0], ax, ay), cy = rotateVec([0,1,0], ax, ay), cz = rotateVec([0,0,1], ax, ay);
  var X0 = cx[0], X1 = cx[1], X2 = cx[2], Y0 = cy[0], Y1 = cy[1], Y2 = cy[2], Z0 = cz[0], Z1 = cz[1], Z2 = cz[2];
  var lift = phys.y > 0 ? phys.y : 0, R2 = RS * RS;
  var alphaMax = 255 * 0.4 / (1 + lift / 70) / NS;            // higher = fainter
  var TX = TBL.tx, TY = TBL.ty, TZ = TBL.tz, EX = TBL.ex, EY = TBL.ey, EZ = TBL.ez;
  for (var k = 0; k < SN; k++){
    // table point relative to the die centre (lifted by the hop)
    var ox = TX[k], oy = TY[k] + lift, oz = TZ[k];
    var cc = ox * ox + oy * oy + oz * oz - R2;
    var q0 = X0 * ox + X1 * oy + X2 * oz, q1 = Y0 * ox + Y1 * oy + Y2 * oz, q2 = Z0 * ox + Z1 * oy + Z2 * oz;
    var blocked = 0;
    for (var m = 0, km = k * NS; m < NS; m++, km++){
      var dx = EX[km], dy = EY[km], dz = EZ[km];
      // bounding sphere first (rotation-invariant, so no need to rotate the ray yet)
      var b = ox * dx + oy * dy + oz * dz, disc = b * b - cc;
      if (disc < 0) continue;
      var sq = Math.sqrt(disc), t0 = -b - sq, t1 = -b + sq;
      if (t1 <= 0) continue;
      var D0 = X0 * dx + X1 * dy + X2 * dz, D1 = Y0 * dx + Y1 * dy + Y2 * dz, D2 = Z0 * dx + Z1 * dy + Z2 * dz;
      var inv = 1 / D0, u1 = (-DH - q0) * inv, u2 = (DH - q0) * inv, tt;
      if (u1 > u2){ tt = u1; u1 = u2; u2 = tt; } if (u1 > t0) t0 = u1; if (u2 < t1) t1 = u2;
      inv = 1 / D1; u1 = (-DH - q1) * inv; u2 = (DH - q1) * inv;
      if (u1 > u2){ tt = u1; u1 = u2; u2 = tt; } if (u1 > t0) t0 = u1; if (u2 < t1) t1 = u2;
      inv = 1 / D2; u1 = (-DH - q2) * inv; u2 = (DH - q2) * inv;
      if (u1 > u2){ tt = u1; u1 = u2; u2 = tt; } if (u1 > t0) t0 = u1; if (u2 < t1) t1 = u2;
      if (t0 <= t1 && t1 > 0) blocked++;
    }
    sh32[k] = blocked ? ((((alphaMax * blocked) | 0) << 24) | (22 << 16) | (30 << 8) | 24) : 0;
  }
  shCtx.putImageData(shImg, 0, 0);
  // only restyle when the blur actually changes (quantised to quarter pixels)
  var blur = Math.round((1 + lift / 22) * 4) / 4;
  if (blur !== shBlur){ shBlur = blur; shCanvas.style.filter = "blur(" + blur + "px)"; }
}

var G = 4300;                 // px/s^2: a heavy die falls fast and lands hard
var SQUASH_T = 0.11;          // seconds a squash lasts
var phys = { y: 0, vy: 0, crouch: 0, sqT: 0, sqAmt: 0, last: 0 };

// ---- the die's place in Stretch: one wrap element, built on first roll, shown per roll -------
var wrapEl = null, liftEl = null, dieEl = null;
var rolling = false;          // false | "rolling" | "landing"
var onDone = null, autoStop = 0;

function ensureDom(laneEl){
  if (wrapEl) return;
  wrapEl = document.createElement("div");
  wrapEl.className = "st-die";
  liftEl = document.createElement("div");
  liftEl.className = "st-die-lift";
  dieEl = document.createElement("div");
  dieEl.className = "st-die-cube";
  dieEl.appendChild(canvasEl);
  liftEl.appendChild(dieEl);
  wrapEl.append(shCanvas, liftEl);
  shCanvas.className = "st-die-shadow";
  wrapEl.hidden = true;
  laneEl.append(wrapEl);
  // a click mid-roll lands it, like catching the die
  wrapEl.addEventListener("pointerdown", function(e){
    e.stopPropagation();
    if (rolling === "rolling") stopRoll();
  });
  var start = FACE_ROT[5];
  anim.x = start[0] + TILT_X; anim.y = start[1] + TILT_Y;
}

// ---- die physics: ballistic hops under gravity, squash on impact, decaying bounces on stop
function rand(a, b){ return a + Math.random() * (b - a); }
function launchSpeed(h){ return Math.sqrt(2 * G * h); }   // speed to reach height h

// motion since the previous frame drives the blur; the shutter covers 80% of that interval
var SHUTTER = 0.8, prevFrame = null;
function drawDie(){
  var now = performance.now(), bx = 0, by = 0, bl = 0;
  if (rolling && prevFrame && now - prevFrame.t < 100){
    bx = (anim.x - prevFrame.x) * SHUTTER; by = (anim.y - prevFrame.y) * SHUTTER; bl = (phys.y - prevFrame.l) * SHUTTER;
    if (Math.abs(bx) + Math.abs(by) < 0.8 && Math.abs(bl) < 0.5){ bx = by = bl = 0; }   // barely moving: stay sharp
  }
  prevFrame = { x: anim.x, y: anim.y, l: phys.y, t: now };
  renderDie(anim.x, anim.y, bx, by, bl);
  renderShadow(anim.x, anim.y);
  var sq = phys.crouch > 0 ? 0.5 : (phys.sqT > 0 ? phys.sqAmt * (phys.sqT / SQUASH_T) : 0);
  // stretch along the fall while moving fast, squash on contact: speed made visible
  var st = phys.y > 0 && !phys.crouch ? Math.min(1, Math.abs(phys.vy) / 900) : 0;
  // a solid die barely deforms: just a hint of compression on impact, no rubbery stretch
  var sx = (1 + 0.025 * sq) * (1 - 0.006 * st), sy = (1 - 0.04 * sq) * (1 + 0.01 * st);
  liftEl.style.transform = "translateY(" + (-phys.y) + "px) scale(" + sx + "," + sy + ")";
}
function alignUp(v, target){ return target + Math.ceil((v - target) / 360) * 360; }

function dieBusy(){ return !!rolling; }

// Roll the die at (x, y) in the lane — y is the table it bounces on. `n` is the number being
// rolled for (carried through to `done`; the face the die lands on is its own). The roll throws
// itself a few times, then lands by itself (or on a click), tips onto a face, rocks, and
// vanishes; then done(n). With reduced motion there's no die at all: done(n) right away.
function rollDie(laneEl, x, y, n, done){
  if (rolling) return;
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches){ done(n); return; }
  ensureDom(laneEl);
  readEnv();
  anim.n = n;
  onDone = done;
  rolling = "rolling";
  wrapEl.hidden = false;
  wrapEl.classList.remove("vanish");
  wrapEl.style.left = (x - DH) + "px";       // the box is 2*DH wide; the CSS halves it around
  wrapEl.style.top = (y - 2 * DH) + "px";    // its bottom centre, which sits at (x, y)
  anim.vx = 0; anim.vy = 0;          // no spin while crouching
  phys.y = 0; phys.vy = 0; phys.sqT = 0;
  phys.crouch = 0.08;                // brief wind-up before the throw
  phys.last = performance.now();
  prevFrame = null;
  drawDie();                         // the wrap mustn't show a blank canvas for its first frame
  cancelAnimationFrame(anim.raf);
  anim.raf = requestAnimationFrame(step);
  clearTimeout(autoStop);
  autoStop = setTimeout(stopRoll, rand(700, 1100));   // nobody holds the die: it lands on its own
}

function stopRoll(){
  if (rolling !== "rolling") return;
  rolling = "landing";                // the loop keeps running; bounces now lose energy
  clearTimeout(autoStop);
  anim.face = Math.floor(Math.random() * 6) + 1;
}

function cancelRoll(){
  if (!rolling) return;
  rolling = false;
  clearTimeout(autoStop);
  cancelAnimationFrame(anim.raf);
  wrapEl.hidden = true;
  onDone = null;
}

function impact(speed){
  phys.sqT = SQUASH_T;
  phys.sqAmt = Math.min(1, speed / 600);
  if (rolling === "rolling"){
    // still being shaken: throw it up again, and let the contact nudge the spin
    phys.vy = launchSpeed(rand(20, 38));
    anim.vx *= rand(0.8, 1.2); anim.vy *= rand(0.8, 1.2);
    anim.vx = Math.max(380, Math.min(950, anim.vx));
    anim.vy = Math.max(300, Math.min(850, anim.vy));
  } else {
    // stopped: each bounce keeps half its speed and friction bleeds off spin
    phys.vy = speed * 0.3;                         // dense material: most of the energy dies on impact
    anim.vx *= 0.38; anim.vy *= 0.38;
    if (phys.vy < 95){ phys.vy = 0; settle(); return false; }
  }
  return true;
}

function step(now){
  var dt = Math.min(0.033, (now - phys.last) / 1000);
  phys.last = now;
  if (phys.sqT > 0) phys.sqT = Math.max(0, phys.sqT - dt);
  if (phys.crouch > 0){
    phys.crouch -= dt;
    if (phys.crouch <= 0){                       // the throw
      phys.crouch = 0;
      phys.vy = launchSpeed(62);
      anim.vx = rand(560, 820); anim.vy = rand(420, 700);
    }
  } else {
    phys.vy -= G * dt;
    phys.y += phys.vy * dt;
    if (phys.y <= 0 && phys.vy < 0){
      phys.y = 0;
      if (!impact(-phys.vy)){ drawDie(); return; }
    }
  }
  drawDie();
  anim.raf = requestAnimationFrame(step);
}

// last contact: tip over onto the chosen face and rock briefly before coming to rest
function settle(){
  var rot = FACE_ROT[anim.face || 1];
  var D = 0.42;
  var x0 = anim.x, y0 = anim.y;
  var tx = alignUp(x0 + anim.vx * D / 4, rot[0] + TILT_X);
  var ty = alignUp(y0 + anim.vy * D / 4, rot[1] + TILT_Y);
  var t0 = performance.now();
  function easeOutBack(u){ var c = 1.9; return 1 + (c + 1) * Math.pow(u - 1, 3) + c * Math.pow(u - 1, 2); }
  (function rest(now){
    var dt = Math.min(0.033, (now - phys.last) / 1000); phys.last = now;
    if (!rolling) return;                         // cancelled mid-rock
    if (phys.sqT > 0) phys.sqT = Math.max(0, phys.sqT - dt);
    var u = Math.min(1, (now - t0) / 1000 / D);
    var e = easeOutBack(u);
    anim.x = x0 + (tx - x0) * e;
    anim.y = y0 + (ty - y0) * e;
    drawDie();
    if (u < 1){ anim.raf = requestAnimationFrame(rest); return; }
    anim.x = tx; anim.y = ty; drawDie();
    setTimeout(function(){
      if (!rolling) return;
      wrapEl.classList.add("vanish");
      setTimeout(function(){
        if (!rolling) return;
        rolling = false;
        wrapEl.hidden = true;
        var cb = onDone, n = anim.n;
        onDone = null;
        if (cb) cb(n);
      }, 220);
    }, 300);
  })(t0);
}

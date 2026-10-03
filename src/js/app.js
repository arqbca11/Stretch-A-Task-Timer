// Ported from reference/switch-card.html. Storage goes through window.switchcard (bridge.js),
// which writes to the app's log; there is no localStorage copy and no merge.
import {
  MIN, MAX, AUTO_LOG_MS, pad, keyOf, dayKeyAt, tsOn, latestEnd,
  idleBefore, carveIdle, rewardFor, describeReward
} from "./rules.js";

(function(){
  "use strict";

  var state = { days: {}, rolled: null, rolling: false, prefill: "" };
  var tickTimer = null;
  var renderedDay = null;
  var storageDown = false;   // load() failed: render nothing that could write

  /* ---------- dates ---------- */
  function todayKey(){ return dayKeyAt(Date.now()); }
  function prettyDate(key){
    var p = key.split("-");
    var d = new Date(+p[0], +p[1]-1, +p[2]);
    return d.toLocaleDateString(undefined, { weekday:"long", month:"long", day:"numeric" });
  }
  // "12:00–12:40 PM" rather than "12:00 PM–12:40 PM" when both share a suffix
  function rangeText(a, b){
    var x = clockOf(a), y = clockOf(b);
    var sx = x.split(/\s+/), sy = y.split(/\s+/);
    if (sx.length === 2 && sy.length === 2 && sx[1] === sy[1]) x = sx[0];
    return x + "–" + y;
  }
  function clockOf(ts){
    return new Date(ts).toLocaleTimeString(undefined, { hour:"numeric", minute:"2-digit" });
  }

  /* ---------- storage ---------- */
  function dayDoc(key){
    var d = state.days[key];
    if (!d) { d = { date:key, entries:[], updatedAt:0 }; state.days[key] = d; }
    return d;
  }
  // A failed write stays on screen until a later write succeeds.
  function saveFailed(err){
    var note = document.getElementById("save-note");
    note.className = "save-err";
    note.textContent = "Not saved: " + err;
  }
  function saved(){
    var note = document.getElementById("save-note");
    if (note.className === "save-err"){ note.className = ""; note.textContent = ""; }
  }
  function persist(key){
    var d = state.days[key];
    if (!d) return;
    d.updatedAt = Date.now();
    window.switchcard.putDay(d).then(saved, saveFailed);
  }

  // Re-file any entry whose start time belongs to a different day than the one it's stored
  // under (e.g. blocks started after midnight before the 4:30 roll-over existed).
  function normalizeDays(){
    var touched = {};
    Object.keys(state.days).forEach(function(k){
      var d = state.days[k], keep = [];
      d.entries.forEach(function(e){
        var want = e.startedAt ? dayKeyAt(e.startedAt) : k;
        if (want === k) keep.push(e);
        else { dayDoc(want).entries.push(e); touched[want] = true; touched[k] = true; }
      });
      d.entries = keep;
    });
    Object.keys(touched).forEach(function(k){
      state.days[k].entries.sort(function(a, b){ return (a.startedAt || 0) - (b.startedAt || 0); });
      persist(k);
    });
    return Object.keys(touched).length > 0;
  }

  /* ---------- model ---------- */
  // The running block is the newest unfinished entry started in the last 3h,
  // whichever day it belongs to (a block belongs to the day it started).
  function findRunning(){
    var best = null;
    var now = Date.now();
    Object.keys(state.days).forEach(function(k){
      state.days[k].entries.forEach(function(e){
        if (e.type !== "idle" && e.startedAt && e.worked == null && now - e.startedAt < AUTO_LOG_MS){
          if (!best || e.startedAt > best.entry.startedAt) best = { entry:e, key:k };
        }
      });
    });
    return best;
  }
  // Any block left unfinished for 3h is logged as 180 min, flagged "auto".
  function autoLogStale(){
    var now = Date.now(), changed = false;
    Object.keys(state.days).forEach(function(k){
      var touched = false;
      state.days[k].entries.forEach(function(e){
        if (e.type !== "idle" && e.startedAt && e.worked == null && now - e.startedAt >= AUTO_LOG_MS){
          e.worked = Math.round(AUTO_LOG_MS / 60000);
          e.endedAt = e.startedAt + AUTO_LOG_MS;
          e.auto = true;
          e.reward = 0;
          touched = true;
        }
      });
      if (touched){ persist(k); changed = true; }
    });
    return changed;
  }

  // Tell the menu bar what's running. Sent only when it changes.
  var lastStatus = null;
  function reportStatus(){
    var r = findRunning(), e = r && r.entry;
    var s = e
      ? { running: true, id: e.id, task: e.task, startedAt: e.startedAt, planned: e.planned }
      : { running: false, id: null, task: null, startedAt: null, planned: null };
    var json = JSON.stringify(s);
    if (json === lastStatus) return;
    lastStatus = json;
    window.switchcard.status(s);
  }

  function elapsedMin(e){ return Math.max(0, Math.floor((Date.now() - e.startedAt) / 60000)); }

  /* ---------- die ---------- */
  // Chinese-style die: the 1 and the 4 are red.
  // cube rotation (x, y in degrees) that brings each face to the front
  var FACE_ROT = { 1:[0,0], 6:[0,180], 2:[0,-90], 5:[0,90], 3:[-90,0], 4:[90,0] };
  var TILT_X = -16, TILT_Y = 22;   // resting tilt so three faces show
  var dieEl = document.getElementById("die"),
      liftEl = document.getElementById("die-lift"),
      wrapEl = document.getElementById("die-wrap");
  var anim = { x: 0, y: 0, vx: 0, vy: 0, raf: 0, n: null };
  // ---- ray-traced die ----------------------------------------------------------------
  // Shape: a cube intersected with a sphere centred on it, the classic dice shape. Edges stay
  // crisp (just a hair of softening) while each corner is a big spherical cap.
  var DH = 38;         // half the cube's size (the die box is 76px)
  var RS = 54.5;       // sphere radius: DH*sqrt2 = 53.7 rounds the edges away entirely, DH*sqrt3 = 65.8 does nothing
  var SOFT = 1.6;      // width of the slight softening where two surfaces meet
  var CAM = 420;       // camera distance, for perspective
  var VIEW = 140;      // canvas size in CSS px (room for rotated corners and vertical blur)
  var SS = 2;          // render at 2x for smooth edges (3x phones gain little and cost 2.25x the pixels)
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
  function dot(a, b){ return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
  // CSS "rotateX(a) rotateY(b)" maps a vector v to Rx(a) * Ry(b) * v
  function rotateVec(v, ax, ay){
    var a = ax * Math.PI / 180, b = ay * Math.PI / 180;
    var x1 = v[0] * Math.cos(b) + v[2] * Math.sin(b), y1 = v[1], z1 = -v[0] * Math.sin(b) + v[2] * Math.cos(b);
    return [x1, y1 * Math.cos(a) - z1 * Math.sin(a), y1 * Math.sin(a) + z1 * Math.cos(a)];
  }
  // satin white plastic: soft key + sky fill, a broad low sheen
  // satin plastic under one strong lamp: dim room light + lamp diffuse + a satin highlight
  function shade(nv, alb, ao, out, L, H){
    var diff = Math.max(0, nv[0]*L[0] + nv[1]*L[1] + nv[2]*L[2]);
    var hemi = 0.5 - 0.5 * nv[1];
    var h = Math.max(0, nv[0]*H[0] + nv[1]*H[1] + nv[2]*H[2]);
    var lum = (0.54 + 0.5 * diff + 0.07 * hemi) * ao;
    var sp = 0.17 * Math.pow(h, 40) + 0.05 * Math.pow(h, 6);
    out[0] = Math.min(1, alb[0] * lum + sp); out[1] = Math.min(1, alb[1] * lum + sp); out[2] = Math.min(1, alb[2] * lum + sp);
  }

  // ---- renderer: everything that doesn't change between frames is precomputed once ----------
  var canvasEl = document.createElement("canvas");
  var CW = Math.round(VIEW * SS);
  canvasEl.width = canvasEl.height = CW;
  dieEl.appendChild(canvasEl);
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
  readEnv();
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
  var shCanvas = document.getElementById("die-shadow");
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

  (function buildDie(){
    var start = FACE_ROT[5];
    anim.x = start[0] + TILT_X; anim.y = start[1] + TILT_Y;
    drawDie();
    wrapEl.onclick = function(){
      if (state.rolling === "rolling") stopRoll();
      else if (!state.rolling && !findRunning()) roll();
    };
  })();

  // ---- die physics: ballistic hops under gravity, squash on impact, decaying bounces on stop
  function rand(a, b){ return a + Math.random() * (b - a); }
  function launchSpeed(h){ return Math.sqrt(2 * G * h); }   // speed to reach height h

  // motion since the previous frame drives the blur; the shutter covers 80% of that interval
  var SHUTTER = 0.8, prevFrame = null;
  function drawDie(){
    var now = performance.now(), bx = 0, by = 0, bl = 0;
    if (state.rolling && prevFrame && now - prevFrame.t < 100){
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
  function reducedMotion(){
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function roll(){
    if (state.rolling) return;
    anim.n = Math.floor(Math.random() * (MAX - MIN + 1)) + MIN;
    if (reducedMotion()){ state.rolled = anim.n; render(); focusTask(); return; }
    state.rolled = null;
    state.rolling = "rolling";
    wrapEl.classList.remove("vanish");
    anim.vx = 0; anim.vy = 0;          // no spin while crouching
    phys.y = 0; phys.vy = 0; phys.sqT = 0;
    phys.crouch = 0.08;                // brief wind-up before the throw
    phys.last = performance.now();
    cancelAnimationFrame(anim.raf);
    anim.raf = requestAnimationFrame(step);
    render();
  }

  function stopRoll(){
    if (state.rolling !== "rolling") return;
    state.rolling = "landing";          // the loop keeps running; bounces now lose energy
    anim.face = Math.floor(Math.random() * 6) + 1;
    render();
  }

  var dialEl = document.querySelector(".dial");
  function thud(speed){
    if (speed < 220 || !dialEl.animate) return;
    var amp = Math.min(3.6, speed / 260);       // the weight shows up in the table, not in the die
    dialEl.animate([{ transform: "translateY(0)" }, { transform: "translateY(" + amp + "px)", offset: 0.25 },
      { transform: "translateY(" + (-amp * 0.3) + "px)", offset: 0.6 }, { transform: "translateY(0)" }],
      { duration: 170, easing: "ease-out" });
  }
  function impact(speed){
    phys.sqT = SQUASH_T;
    phys.sqAmt = Math.min(1, speed / 600);
    thud(speed);
    if (state.rolling === "rolling"){
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
      anim.x += anim.vx * dt; anim.y += anim.vy * dt;
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
      if (phys.sqT > 0) phys.sqT = Math.max(0, phys.sqT - dt);
      var u = Math.min(1, (now - t0) / 1000 / D);
      var e = easeOutBack(u);
      anim.x = x0 + (tx - x0) * e;
      anim.y = y0 + (ty - y0) * e;
      drawDie();
      if (u < 1){ anim.raf = requestAnimationFrame(rest); return; }
      anim.x = tx; anim.y = ty; drawDie();
      setTimeout(function(){
        wrapEl.classList.add("vanish");
        setTimeout(function(){
          state.rolling = false;
          state.rolled = anim.n;
          state.justLanded = true;
          render();
          focusTask();
        }, 220);
      }, 300);
    })(t0);
  }
  function focusTask(){
    var i = document.getElementById("task-in");
    if (!i) return;
    i.focus();
    if (i.value) i.select();
  }

  function startTask(){
    var input = document.getElementById("task-in");
    if (!input || state.rolled == null) return;
    var name = input.value.trim() || "Untitled";
    var key = todayKey();
    var now = Date.now();
    var gap = idleBefore(state.days[key], key, now);
    var day = dayDoc(key);
    if (gap) day.entries.push(gap);
    day.entries.push({
      id: String(now) + Math.random().toString(36).slice(2,6),
      task: name,
      planned: state.rolled,
      startedAt: now,
      worked: null
    });
    state.rolled = null;
    state.prefill = "";
    persist(key);
    render();
  }

  function logRunning(){
    var r = findRunning();
    if (!r) return null;
    var now = Date.now();
    r.entry.worked = Math.max(1, Math.round((now - r.entry.startedAt) / 60000));
    r.entry.endedAt = now;
    r.entry.auto = false;
    var rw = null;
    if (r.entry.reward == null){
      rw = rewardFor(r.entry);
      r.entry.reward = rw.n;
    }
    persist(r.key);
    if (rw) grantPieces(rw);
    return r;
  }
  function finish(){
    logRunning();
    render();
  }
  function keepGoing(){
    var r = logRunning();
    if (!r) return;
    state.prefill = r.entry.task;
    render();
    roll();
  }

  function removeEntry(key, id){
    var day = state.days[key];
    if (!day) return;
    day.entries = day.entries.filter(function(x){ return x.id !== id; });
    persist(key);
    render();
  }

  /* ---------- reward game ---------- */
  var COLS = 10, ROWS = 20, CELL = 14, NCELL = 8;
  var KINDS = ["I","O","T","S","Z","J","L"];
  var SHAPES = {
    I:[[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]],
    O:[[1,1],[1,1]],
    T:[[0,1,0],[1,1,1],[0,0,0]],
    S:[[0,1,1],[1,1,0],[0,0,0]],
    Z:[[1,1,0],[0,1,1],[0,0,0]],
    J:[[1,0,0],[1,1,1],[0,0,0]],
    L:[[0,0,1],[1,1,1],[0,0,0]]
  };
  var LINE_PTS = [0, 100, 300, 500, 800];

  // Rewards (REWARD, rewardFor, describeReward) live in rules.js.
  var game = null;      // persisted
  var piece = null;     // falling piece, not persisted
  var gravity = null;

  function emptyRow(){ return ".........."; }
  function emptyBoard(){ var b = []; for (var i = 0; i < ROWS; i++) b.push(emptyRow()); return b; }
  function freshGame(){
    return { board: emptyBoard(), score:0, total:0, games:1, best:0, lines:0, bank:0, bag:[], backfilled:false, updatedAt:0 };
  }
  function validGame(g){ return g && Array.isArray(g.board) && g.board.length === ROWS && typeof g.total === "number"; }
  function saveGame(){
    game.updatedAt = Date.now();
    window.switchcard.putGame(game).then(saved, saveFailed);
  }
  function setMsg(t){ document.getElementById("g-msg").textContent = t || ""; }

  function shuffle(a){
    for (var i = a.length - 1; i > 0; i--){ var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  function peekKind(){ if (!game.bag.length) game.bag = shuffle(KINDS.slice()); return game.bag[0]; }
  function takeKind(){ var k = peekKind(); game.bag.shift(); return k; }

  function cellAt(x, y){
    if (x < 0 || x >= COLS || y >= ROWS) return "#";
    if (y < 0) return ".";
    return game.board[y].charAt(x);
  }
  function collides(m, px, py){
    for (var r = 0; r < m.length; r++)
      for (var c = 0; c < m[r].length; c++)
        if (m[r][c] && cellAt(px + c, py + r) !== ".") return true;
    return false;
  }
  function rotateM(m){
    var n = m.length, out = [];
    for (var i = 0; i < n; i++){ out.push([]); for (var j = 0; j < n; j++) out[i].push(m[n - 1 - j][i]); }
    return out;
  }

  function grantPieces(rw){
    game.bank += rw.n;
    saveGame();
    setMsg("+" + rw.n + (rw.n === 1 ? " piece" : " pieces") + " (" + describeReward(rw) + ").");
    renderGameSide();
  }

  function topOut(){
    game.best = Math.max(game.best, game.score);
    game.games += 1;
    game.score = 0;
    game.board = emptyBoard();
    setMsg("Board topped out. New game; the total carries over.");
  }

  function spawn(){
    if (piece || game.bank <= 0) return;
    var k = takeKind(), m = SHAPES[k];
    var x = Math.floor((COLS - m[0].length) / 2), y = k === "I" ? -1 : 0;
    if (collides(m, x, y)){ topOut(); saveGame(); }
    piece = { k:k, m:m, x:x, y:y };
    startGravity();
    drawGame(); renderGameSide();
  }

  function move(dx, dy){
    if (!piece || collides(piece.m, piece.x + dx, piece.y + dy)) return false;
    piece.x += dx; piece.y += dy;
    return true;
  }
  function rotatePiece(){
    if (!piece || piece.k === "O") return;
    var m2 = rotateM(piece.m), kicks = [0, -1, 1, -2, 2];
    for (var i = 0; i < kicks.length; i++){
      if (!collides(m2, piece.x + kicks[i], piece.y)){ piece.m = m2; piece.x += kicks[i]; return; }
    }
  }
  function hardDrop(){ if (!piece) return; while (move(0, 1)){} lock(); }
  function tick(){ if (!piece) return; if (!move(0, 1)) lock(); else drawGame(); }

  function lock(){
    if (!piece) return;
    var above = false, m = piece.m;
    for (var r = 0; r < m.length; r++){
      for (var c = 0; c < m[r].length; c++){
        if (!m[r][c]) continue;
        var y = piece.y + r, x = piece.x + c;
        if (y < 0){ above = true; continue; }
        var row = game.board[y];
        game.board[y] = row.substring(0, x) + piece.k + row.substring(x + 1);
      }
    }
    var kept = game.board.filter(function(row){ return row.indexOf(".") >= 0; });
    var cleared = ROWS - kept.length;
    while (kept.length < ROWS) kept.unshift(emptyRow());
    game.board = kept;

    var pts = 10 + LINE_PTS[Math.min(cleared, 4)];
    game.score += pts; game.total += pts; game.lines += cleared;
    game.best = Math.max(game.best, game.score);
    game.bank = Math.max(0, game.bank - 1);
    piece = null;
    stopGravity();

    if (cleared) setMsg((cleared === 4 ? "Four lines! +" : cleared + (cleared === 1 ? " line, +" : " lines, +")) + pts + ".");
    else setMsg(game.bank ? "" : "Out of pieces. Next ones come with the next logged block.");
    if (above) topOut();
    saveGame();
    if (game.bank > 0) spawn();
    drawGame(); renderGameSide();
  }

  function startGravity(){
    stopGravity();
    if (!piece || panelHidden()) return;
    gravity = setInterval(tick, 480);   // ms per row
  }
  function panelHidden(){ return document.hidden || !window.switchcard.panelVisible; }
  function stopGravity(){ if (gravity){ clearInterval(gravity); gravity = null; } }

  function tokens(){
    var cs = getComputedStyle(document.documentElement), t = {};
    KINDS.forEach(function(k){ t[k] = cs.getPropertyValue("--t-" + k).trim(); });
    t.line = cs.getPropertyValue("--line").trim();
    t.card = cs.getPropertyValue("--card").trim();
    return t;
  }
  function setupCanvas(cv, w, h){
    var dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr)){
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      cv.style.width = w + "px"; cv.style.height = h + "px";
    }
    var ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }
  function drawGame(){
    if (!game) return;
    var cv = document.getElementById("board");
    var W = COLS * CELL, H = ROWS * CELL;
    var ctx = setupCanvas(cv, W, H), t = tokens();
    ctx.fillStyle = t.card; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = t.line; ctx.lineWidth = 1; ctx.globalAlpha = .5;
    ctx.beginPath();
    for (var x = 1; x < COLS; x++){ ctx.moveTo(x * CELL + .5, 0); ctx.lineTo(x * CELL + .5, H); }
    for (var y = 1; y < ROWS; y++){ ctx.moveTo(0, y * CELL + .5); ctx.lineTo(W, y * CELL + .5); }
    ctx.stroke(); ctx.globalAlpha = 1;

    for (var r = 0; r < ROWS; r++){
      for (var c = 0; c < COLS; c++){
        var k = game.board[r].charAt(c);
        if (k !== "."){ ctx.fillStyle = t[k] || t.line; ctx.fillRect(c * CELL + 1, r * CELL + 1, CELL - 2, CELL - 2); }
      }
    }
    if (piece){
      var gy = piece.y;
      while (!collides(piece.m, piece.x, gy + 1)) gy++;
      ctx.strokeStyle = t[piece.k]; ctx.globalAlpha = .45;
      eachCell(piece.m, function(cc, rr){
        if (gy + rr >= 0) ctx.strokeRect((piece.x + cc) * CELL + 1.5, (gy + rr) * CELL + 1.5, CELL - 3, CELL - 3);
      });
      ctx.globalAlpha = 1; ctx.fillStyle = t[piece.k];
      eachCell(piece.m, function(cc, rr){
        if (piece.y + rr >= 0) ctx.fillRect((piece.x + cc) * CELL + 1, (piece.y + rr) * CELL + 1, CELL - 2, CELL - 2);
      });
    }
    drawNext(t);
  }
  function eachCell(m, fn){
    for (var r = 0; r < m.length; r++) for (var c = 0; c < m[r].length; c++) if (m[r][c]) fn(c, r);
  }
  function drawNext(t){
    var wrap = document.getElementById("g-next-wrap");
    var show = piece && game.bank > 1;
    wrap.hidden = !show;
    if (!show) return;
    var k = peekKind(), m = SHAPES[k];
    var cv = document.getElementById("g-next");
    var ctx = setupCanvas(cv, 4 * NCELL, 2 * NCELL);
    ctx.clearRect(0, 0, 4 * NCELL, 2 * NCELL);
    ctx.fillStyle = t[k];
    var rows = m.filter(function(row){ return row.some(Boolean); });
    var w = rows[0].length, ox = (4 - w) / 2;
    rows.forEach(function(row, rr){
      row.forEach(function(v, cc){ if (v) ctx.fillRect((ox + cc) * NCELL + 1, rr * NCELL + 1, NCELL - 2, NCELL - 2); });
    });
  }

  function renderGameSide(){
    if (!game) return;
    document.getElementById("g-total").textContent = game.total.toLocaleString();
    document.getElementById("g-stats").innerHTML =
      "This game <b>" + game.score.toLocaleString() + "</b><br>" +
      "Best game <b>" + game.best.toLocaleString() + "</b><br>" +
      "Game <b>" + game.games + "</b>, <b>" + game.lines + "</b> lines total";
    var bank = document.getElementById("g-bank");
    if (piece){
      var left = game.bank - 1;
      bank.innerHTML = left > 0 ? "Playing. <b>" + left + "</b> more after this one." : "Playing your last piece.";
    } else if (game.bank > 0){
      bank.innerHTML = "<b>" + game.bank + "</b> " + (game.bank === 1 ? "piece" : "pieces") + " to play.";
    } else {
      bank.textContent = "Each logged block earns pieces: more for longer blocks and for running a bit over.";
    }
    var actions = document.getElementById("g-actions");
    actions.innerHTML = "";
    if (!piece && game.bank > 0){
      var b = document.createElement("button");
      b.className = "ghost";
      b.textContent = "Play";
      b.onclick = function(){ spawn(); document.getElementById("board").focus(); };
      actions.appendChild(b);
    }
    document.getElementById("pad").hidden = !piece;
  }

  function padAction(act){
    if (!piece) return;
    if (act === "left") move(-1, 0);
    else if (act === "right") move(1, 0);
    else if (act === "down"){ if (!move(0, 1)){ lock(); return; } }
    else if (act === "rotate") rotatePiece();
    else if (act === "drop"){ hardDrop(); return; }
    drawGame();
  }
  Array.prototype.forEach.call(document.querySelectorAll("#pad button"), function(btn){
    btn.tabIndex = -1;
    btn.addEventListener("pointerdown", function(ev){ ev.preventDefault(); });
    btn.addEventListener("click", function(){ padAction(btn.getAttribute("data-act")); });
  });

  function backfillRewards(){
    if (game.backfilled) return;
    var k = todayKey(), d = state.days[k], n = 0;
    if (d) d.entries.forEach(function(e){
      if (e.type !== "idle" && e.worked != null && !e.auto && e.reward == null){
        e.reward = rewardFor(e).n;
        n += e.reward;
      }
    });
    game.backfilled = true;
    if (n){ persist(k); game.bank += n; setMsg("+" + n + " pieces for today's blocks so far."); }
    saveGame();
    renderGameSide(); drawGame();
  }

  /* ---------- log without rolling ---------- */
  var manualOpen = false;
  function hhmm(ts){ var d = new Date(ts); return pad(d.getHours()) + ":" + pad(d.getMinutes()); }
  // tsOn, latestEnd and carveIdle live in rules.js.

  function logManual(task, startVal, endVal){
    var key = todayKey();
    if (!startVal || !endVal) return "Pick a start and an end time.";
    var s = tsOn(key, startVal), e = tsOn(key, endVal);
    if (e <= s) return "The end has to be after the start.";
    if (e > Date.now() + 60000) return "That end time hasn't happened yet.";
    var mins = Math.round((e - s) / 60000);
    if (mins < 1) return "That's under a minute.";
    var day = dayDoc(key);
    var last = latestEnd(day);
    if (last == null || s >= last){
      var gap = idleBefore(state.days[key], key, s);   // same idle rule as a rolled start
      if (gap) day.entries.push(gap);
    } else {
      carveIdle(day, s, e);              // filling in a gap that was logged as idle
    }
    var entry = {
      id: "m" + String(Date.now()) + Math.random().toString(36).slice(2,6),
      type: "manual",
      task: task || "Untitled",
      planned: null,
      startedAt: s,
      endedAt: e,
      worked: mins
    };
    var rw = rewardFor(entry);
    entry.reward = rw.n;
    day.entries.push(entry);
    day.entries.sort(function(a, b){ return (a.startedAt || 0) - (b.startedAt || 0); });
    persist(key);
    grantPieces(rw);
    return null;
  }

  function renderManual(){
    var box = document.getElementById("manual");
    box.innerHTML = "";
    if (!manualOpen){
      var add = document.createElement("button");
      add.className = "add-log";
      add.textContent = "+ Log something you did without rolling";
      add.onclick = function(){ manualOpen = true; renderManual(); document.getElementById("m-task").focus(); };
      box.appendChild(add);
      return;
    }
    var now = Date.now();
    var form = document.createElement("div");
    form.className = "mform";
    form.innerHTML =
      '<input class="task-in" id="m-task" type="text" placeholder="What did you do?" autocomplete="off">' +
      '<div class="times"><input type="time" id="m-start" aria-label="Start time"><span>to</span>' +
      '<input type="time" id="m-end" aria-label="End time"><span id="m-len"></span></div>' +
      '<div class="err" id="m-err" hidden></div>' +
      '<div class="acts"><button id="m-log">Log it</button><button class="quiet" id="m-cancel">Cancel</button></div>';
    box.appendChild(form);
    var st = document.getElementById("m-start"), en = document.getElementById("m-end");
    st.value = hhmm(now - 30 * 60000); en.value = hhmm(now);
    function showLen(){
      var el = document.getElementById("m-len");
      if (!st.value || !en.value){ el.textContent = ""; return; }
      var k = todayKey(), m = Math.round((tsOn(k, en.value) - tsOn(k, st.value)) / 60000);
      el.textContent = m > 0 ? m + " min" : "";
    }
    st.oninput = showLen; en.oninput = showLen; showLen();
    function submit(){
      var err = logManual(document.getElementById("m-task").value.trim(), st.value, en.value);
      var eb = document.getElementById("m-err");
      if (err){ eb.hidden = false; eb.textContent = err; return; }
      manualOpen = false;
      renderManual();
      render();
    }
    document.getElementById("m-log").onclick = submit;
    document.getElementById("m-task").onkeydown = function(ev){ if (ev.key === "Enter") submit(); };
    document.getElementById("m-cancel").onclick = function(){ manualOpen = false; renderManual(); };
  }

  /* ---------- render ---------- */
  function render(){
    autoLogStale();
    renderedDay = todayKey();
    document.getElementById("today-label").textContent = prettyDate(renderedDay) +
      (keyOf(new Date()) !== renderedDay ? " (late night)" : "");
    renderDial();
    renderToday();
    renderPast();
    manageTick();
    reportStatus();
  }

  function renderDial(){
    var numeral = document.getElementById("numeral");
    var unit = document.getElementById("unit");
    var sub = document.getElementById("sub");
    var bar = document.getElementById("bar");
    var fill = document.getElementById("barfill");
    var controls = document.getElementById("controls");
    controls.innerHTML = "";

    var r = findRunning();
    var showDie = !(r && !state.rolling) && (state.rolled == null || state.rolling);
    wrapEl.hidden = !showDie;
    numeral.hidden = showDie;
    if (showDie && !state.rolling) wrapEl.classList.remove("vanish");

    if (r && !state.rolling){
      var run = r.entry;
      var mins = elapsedMin(run);
      numeral.className = "numeral live";
      numeral.textContent = mins;
      unit.textContent = "of " + run.planned + " min";
      sub.innerHTML = "";
      var strong = document.createElement("span");
      strong.className = "task";
      strong.textContent = run.task;
      sub.appendChild(strong);
      sub.appendChild(document.createTextNode(
        " \u00b7 started " + clockOf(run.startedAt) +
        (r.key !== todayKey() ? " yesterday" : "") +
        (mins > run.planned ? " \u00b7 " + (mins - run.planned) + " over" : "")
      ));
      bar.hidden = false;
      fill.style.width = Math.min(100, (mins / run.planned) * 100) + "%";
      bar.className = mins > run.planned ? "bar over" : "bar";

      var done = document.createElement("button");
      done.textContent = "Done, log it";
      done.onclick = finish;
      var more = document.createElement("button");
      more.className = "ghost";
      more.textContent = "Keep going";
      more.title = "Log this block and roll a new number for the same task";
      more.onclick = keepGoing;
      controls.appendChild(done);
      controls.appendChild(more);
      return;
    }

    bar.hidden = true;

    if (state.rolling || state.rolled == null){
      unit.textContent = "minutes";
      if (state.rolling === "rolling"){
        sub.textContent = "Rolling. Stop it whenever you like.";
        var stop = document.createElement("button");
        stop.textContent = "Stop";
        stop.onclick = stopRoll;
        controls.appendChild(stop);
      } else if (state.rolling === "landing"){
        sub.textContent = "Rolling. Stop it whenever you like.";
      } else {
        sub.textContent = "Roll a number, name the task, start.";
        var b = document.createElement("button");
        b.textContent = "Roll a number";
        b.onclick = roll;
        controls.appendChild(b);
      }
      return;
    }

    numeral.className = "numeral" + (state.justLanded ? " pop" : "");
    state.justLanded = false;
    numeral.textContent = state.rolled;
    unit.textContent = "minutes";
    sub.textContent = state.prefill
      ? "Next block. Set the stopwatch to " + state.rolled + " and start."
      : "What gets these " + state.rolled + " minutes?";

    var row = document.createElement("div");
    row.className = "row-start";
    var input = document.createElement("input");
    input.className = "task-in";
    input.id = "task-in";
    input.type = "text";
    input.placeholder = "Task name";
    input.autocomplete = "off";
    input.value = state.prefill || "";
    input.onkeydown = function(ev){ if (ev.key === "Enter") startTask(); };
    var go = document.createElement("button");
    go.textContent = "Start";
    go.onclick = startTask;
    var again = document.createElement("button");
    again.className = "quiet";
    again.textContent = "Reroll";
    again.onclick = roll;
    row.appendChild(input); row.appendChild(go); row.appendChild(again);
    controls.appendChild(row);
  }

  function summarize(entries){
    var planned = 0, worked = 0, blocks = 0, idle = 0;
    entries.forEach(function(e){
      if (e.type === "idle"){ idle += e.worked || 0; return; }
      blocks++;
      planned += e.planned || 0;
      if (e.worked != null) worked += e.worked;
    });
    if (!entries.length) return "";
    var out = blocks + (blocks === 1 ? " block" : " blocks") +
      " \u00b7 " + planned + " planned \u00b7 " + worked + " worked";
    if (idle) out += " \u00b7 " + idle + " idle";
    return out;
  }

  // bar height: linear in minutes, with a floor so short blocks stay readable and a cap for very long idles
  var BAR_PX_PER_MIN = 1.2, BAR_MIN_PX = 34, BAR_MAX_PX = 480;
  function barPx(mins){
    var h = (mins || 0) * BAR_PX_PER_MIN;
    return Math.round(h < BAR_MIN_PX ? BAR_MIN_PX : h > BAR_MAX_PX ? BAR_MAX_PX : h);
  }
  function entryRow(e, key, runningId){
    var isIdle = e.type === "idle";
    var isManual = e.type === "manual";
    var isRunning = e.id === runningId;
    var row = document.createElement("div");
    row.className = "entry" + (isIdle ? " idle" : "") + (isRunning ? " running" : "");
    var mins = e.worked != null ? e.worked : (isRunning ? elapsedMin(e) : 0);
    row.style.minHeight = barPx(mins) + "px";
    row.title = mins + " min";

    var name = document.createElement("input");
    name.className = "name";
    name.value = e.task;
    name.setAttribute("aria-label", "Task name");
    name.onchange = function(){ e.task = name.value.trim() || (isIdle ? "idle" : "Untitled"); persist(key); render(); };
    row.appendChild(name);
    if (isManual){
      var tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = "no roll";
      tag.title = "Logged after the fact, without rolling";
      row.appendChild(tag);
    }

    var nums = document.createElement("div");
    nums.className = "nums";

    if (isIdle || isManual){
      var range = document.createElement("span");
      range.className = "range";
      range.textContent = rangeText(e.startedAt, e.endedAt);
      nums.appendChild(range);
    } else {
    var p = document.createElement("input");
    p.value = e.planned;
    p.inputMode = "numeric";
    p.title = "minutes planned";
    p.setAttribute("aria-label", "Minutes planned");
    p.onchange = function(){
      var v = parseInt(p.value, 10);
      if (!isNaN(v)) e.planned = Math.max(1, v);
      persist(key); render();
    };
    nums.appendChild(p);

    var arrow = document.createElement("span");
    arrow.className = "arrow";
    arrow.textContent = "\u2192";
    nums.appendChild(arrow);
    }

    var w = document.createElement("input");
    w.className = "done";
    w.value = e.worked == null ? "" : e.worked;
    w.placeholder = "\u2013";
    w.inputMode = "numeric";
    w.title = isIdle ? "minutes idle" : (e.auto ? "Auto-logged at 3 hours; edit if wrong" : "minutes worked");
    w.setAttribute("aria-label", isIdle ? "Minutes idle" : "Minutes worked");
    w.onchange = function(){
      var v = parseInt(w.value, 10);
      e.worked = isNaN(v) ? null : Math.max(0, v);
      e.auto = false;
      persist(key); render();
    };
    nums.appendChild(w);

    var min = document.createElement("span");
    min.className = "min";
    min.textContent = "min";
    nums.appendChild(min);
    if (e.auto){
      var a = document.createElement("span");
      a.className = "auto";
      a.textContent = "auto";
      nums.appendChild(a);
    }
    row.appendChild(nums);

    var del = document.createElement("button");
    del.className = "del";
    del.innerHTML = "&times;";
    del.title = "Remove";
    del.setAttribute("aria-label", "Remove " + e.task);
    del.onclick = function(){ removeEntry(key, e.id); };
    row.appendChild(del);
    return row;
  }

  function renderToday(){
    var key = todayKey();
    var day = state.days[key];
    var box = document.getElementById("today-entries");
    box.innerHTML = "";
    var entries = day ? day.entries : [];
    var r = findRunning();
    document.getElementById("today-summary").textContent = summarize(entries);
    if (!entries.length){
      var p = document.createElement("div");
      p.className = "empty";
      p.textContent = r ? "The running block started yesterday; it's logged there." : "Nothing logged yet today.";
      box.appendChild(p);
      return;
    }
    entries.forEach(function(e){ box.appendChild(entryRow(e, key, r && r.entry.id)); });
  }

  function renderPast(){
    var today = todayKey();
    var keys = Object.keys(state.days)
      .filter(function(k){ return k < today && state.days[k].entries.length; })
      .sort().reverse();
    var body = document.getElementById("past-body");
    body.innerHTML = "";
    document.getElementById("past-summary").textContent =
      keys.length ? "Earlier days (" + keys.length + ")" : "Earlier days";
    if (!keys.length){
      var p = document.createElement("div");
      p.className = "empty";
      p.style.marginTop = "14px";
      p.textContent = "No earlier days yet. Each day's log moves here after midnight.";
      body.appendChild(p);
      return;
    }
    var r = findRunning();
    keys.forEach(function(k){
      var d = state.days[k];
      var wrap = document.createElement("div");
      wrap.className = "day";
      var h = document.createElement("h3");
      var t = document.createElement("span");
      t.textContent = prettyDate(k);
      var s = document.createElement("em");
      s.textContent = summarize(d.entries);
      h.appendChild(t); h.appendChild(s);
      wrap.appendChild(h);
      d.entries.forEach(function(e){ wrap.appendChild(entryRow(e, k, r && r.entry.id)); });
      body.appendChild(wrap);
    });
  }

  function manageTick(){
    if (tickTimer){ clearInterval(tickTimer); tickTimer = null; }
    if (!findRunning()) return;
    tickTimer = setInterval(function(){
      var r = findRunning();
      if (!r){ render(); return; }
      var numeral = document.getElementById("numeral");
      if (numeral.textContent !== String(elapsedMin(r.entry))){
        renderDial();
        var h = barPx(elapsedMin(r.entry)) + "px";
        Array.prototype.forEach.call(document.querySelectorAll(".entry.running"), function(el){ el.style.minHeight = h; });
      }
      else {
        document.getElementById("barfill").style.width =
          Math.min(100, ((Date.now() - r.entry.startedAt) / 60000 / r.entry.planned) * 100) + "%";
      }
    }, 5000);
  }

  /* ---------- day rollover ---------- */
  function checkDay(){
    if (autoLogStale()){ render(); return; }
    if (todayKey() !== renderedDay && !state.rolling && !document.getElementById("task-in")) render();
  }
  setInterval(checkDay, 30000);
  // The panel is hidden (not closed) from the menu bar, which WKWebView doesn't always report
  // as visibilitychange; bridge.js relays Rust's panel-visibility events as well.
  function onVisibility(){
    if (panelHidden()) stopGravity();
    else { checkDay(); if (piece) startGravity(); }
  }
  document.addEventListener("visibilitychange", onVisibility);
  document.addEventListener("switchcard:visibility", onVisibility);

  /* ---------- boot ---------- */
  // The log is the only copy: render what load() returns, write back through the bridge.
  window.switchcard.load().then(function(r){
    state.days = r.days || {};
    game = validGame(r.game) ? r.game : freshGame();
    normalizeDays();
    render();
    renderManual();
    renderGameSide(); drawGame();
    backfillRewards();
  }, function(err){
    // Don't render anything that could write over history the app couldn't read.
    storageDown = true;
    document.querySelector(".wrap").hidden = true;
    var p = document.createElement("p");
    p.className = "note storage-down";
    p.textContent = "Stretch couldn't open your history, so it isn't showing or changing anything. " + err;
    document.body.appendChild(p);
  });

  window.switchcard.onTrayAction({
    done: function(){ if (!storageDown) finish(); },
    keepGoing: function(){ if (!storageDown) keepGoing(); },
    roll: function(){ if (!storageDown && !findRunning()) roll(); }
  });

  if (window.matchMedia){
    var mq = window.matchMedia("(prefers-color-scheme: dark)");
    if (mq.addEventListener) mq.addEventListener("change", function(){ drawGame(); readEnv(); drawDie(); });
  }

  document.addEventListener("keydown", function(ev){
    var tg = ev.target;
    var typing = tg && (tg.tagName === "INPUT" || tg.tagName === "TEXTAREA");
    if (piece && !typing){
      var handled = true;
      switch (ev.key){
        case "ArrowLeft": move(-1, 0); break;
        case "ArrowRight": move(1, 0); break;
        case "ArrowDown": if (!move(0, 1)){ lock(); ev.preventDefault(); return; } break;
        case "ArrowUp": case "x": case "X": rotatePiece(); break;
        case " ": ev.preventDefault(); hardDrop(); return;
        default: handled = false;
      }
      if (handled){ ev.preventDefault(); drawGame(); }
      return;
    }
    if (ev.key === " " && ev.target === document.body){
      ev.preventDefault();
      if (state.rolling === "rolling") stopRoll();
      else if (state.rolling) return;
      else if (findRunning()) finish();
      else if (state.rolled == null) roll();
    }
  });
})();

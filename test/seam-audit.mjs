// Regression tests for the seam-splitting preclip in js/geoPolarPetal.js.
//
// Two independent properties are checked, because they fail independently:
//
//   1. COMPLETENESS - no seam crossing is ever missed. Two consecutive
//      points inside one emitted segment must never sit in different lobes;
//      if they do, d3 will draw a straight chord across the gap between two
//      petals.
//
//   2. FIDELITY - every point emitted lies on the true great circle of the
//      source segment it came from. An earlier implementation densified
//      segments with plain (lambda,phi) interpolation, which satisfied (1)
//      completely while silently bending lines up to 14 degrees off their
//      real path - visible as kinks mid-lobe and misrouted meridians near
//      the poles. (1) alone does not catch that.

import * as d3 from 'd3-geo';
import { geoPolarPetalPreclip } from '../js/geoPolarPetal.js';

const rad = Math.PI / 180;

function angleDelta(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}
function cart(l, p) {
  const c = Math.cos(p);
  return [c * Math.cos(l), c * Math.sin(l), Math.sin(p)];
}
function cross(a, b) {
  return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
}
function dot(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
function norm(v) {
  const L = Math.hypot(v[0], v[1], v[2]);
  return L < 1e-12 ? null : [v[0]/L, v[1]/L, v[2]/L];
}

const rotations = [
  [0, 0, 0],
  [74, 50, 0],
  [74, 50, 35],
  [180, 20, 0],
  [30, -60, 90],
  [0, 90, 0],
  [0, -90, 0],
  [179.9, 0.1, 0],
  [45, 45, 180],
  [123.456, -33.7, 271],
];
const lobeCounts = [4, 8, 12, 24];

// Fidelity tolerance. Emitted points should be on the source great circle to
// floating-point accuracy; 1e-6 rad (~0.00006 deg) is generous but still
// three orders of magnitude tighter than any visible bend.
const FIDELITY_TOL = 1e-6;

let failures = 0;

for (const n of lobeCounts) {
  const sector = 2 * Math.PI / n;
  const graticule = d3.geoGraticule().extent([[-180, -89.999], [180, 89.999]]);
  const lines = graticule.lines();

  for (const rot of rotations) {
    const rotate = d3.geoRotation(rot);
    let missed = 0, worstGap = 0;
    let offCircle = 0, worstOff = 0;

    for (const f of lines) {
      const pts = f.coordinates.map(([lo, la]) => {
        const r = rotate([lo, la]);
        return [r[0] * rad, r[1] * rad];
      });

      // Feed one source segment at a time so each emitted point can be
      // attributed to the exact great circle it should lie on.
      for (let s = 0; s < pts.length - 1; s++) {
        const A = cart(pts[s][0], pts[s][1]);
        const B = cart(pts[s+1][0], pts[s+1][1]);
        const planeNormal = norm(cross(A, B));

        let prev = null;
        const sink = {
          point(l, p) {
            if (prev) {
              // Lobe index is inherently modular - longitude 345 and -15 are
              // the same place, so compare the indices mod n rather than as
              // raw integers.
              const lobe = (x) => (((Math.round(x / sector) % n) + n) % n);
              const k0 = lobe(prev[0]), k1 = lobe(l);
              if (k0 !== k1) {
                missed++;
                const d = Math.abs(angleDelta(l, prev[0]));
                if (d > worstGap) worstGap = d;
              }
            }
            if (planeNormal) {
              const off = Math.abs(Math.asin(Math.max(-1, Math.min(1, dot(cart(l, p), planeNormal)))));
              if (off > FIDELITY_TOL) {
                offCircle++;
                if (off > worstOff) worstOff = off;
              }
            }
            prev = [l, p];
          },
          lineStart() { prev = null; },
          lineEnd() { prev = null; },
          polygonStart() {}, polygonEnd() {}, sphere() {}
        };

        const clip = geoPolarPetalPreclip(n)(sink);
        clip.lineStart();
        clip.point(pts[s][0], pts[s][1]);
        clip.point(pts[s+1][0], pts[s+1][1]);
        clip.lineEnd();
      }
    }

    const ok = missed === 0 && offCircle === 0;
    if (!ok) failures++;
    const detail = [
      missed ? `missed=${missed} (worst gap ${(worstGap/rad).toFixed(1)}deg)` : 'missed=0',
      offCircle ? `off-circle=${offCircle} (worst ${(worstOff/rad).toFixed(4)}deg)` : 'off-circle=0',
    ].join('  ');
    console.log(`${ok ? 'PASS' : 'FAIL'} n=${String(n).padStart(2)} rotate=${JSON.stringify(rot).padEnd(20)} ${detail}`);
  }
}

console.log('\n' + (failures === 0 ? 'ALL PASS' : `${failures} CONFIGURATIONS FAILED`));
process.exit(failures === 0 ? 0 : 1);

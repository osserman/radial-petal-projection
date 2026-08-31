// Fill-clip correctness test.
//
// The n per-lobe clips must PARTITION the sphere: every piece of an input
// polygon lands in exactly one lobe, nothing duplicated, nothing dropped.
//
// Measured as SPHERICAL area (d3.geoArea) of the reconstructed rings, not
// projected area. Spherical area is invariant under rotation and has no
// antimeridian or wrap-around confound, so the invariant is exact and clean:
//
//     sum over lobes of area(clip_k(polygon)) === area(polygon)
//
// A shortfall means land is being cut off - the straight-chord artifact
// slicing across a landmass. An excess means a fragment closed over
// territory it does not cover.

import * as d3 from 'd3-geo';
import { geoPolarPetalFillPreclip } from '../js/geoPolarPetalFillClip.js';

const rad = Math.PI / 180, deg = 180 / Math.PI;

// Collects a clip stream's output back into GeoJSON so it can be measured
// with d3.geoArea.
function collector() {
  let polygons = [], rings = null, ring = null;
  return {
    sink: {
      polygonStart() { rings = []; },
      polygonEnd() { if (rings && rings.length) polygons.push(rings); rings = null; },
      lineStart() { ring = []; },
      lineEnd() {
        if (ring && ring.length > 2) { ring.push(ring[0]); rings.push(ring); }
        ring = null;
      },
      point(l, p) { if (ring) ring.push([l * deg, p * deg]); },
      sphere() {}
    },
    result() { return { type: 'MultiPolygon', coordinates: polygons }; }
  };
}

function runClip(clipFactory, poly) {
  const c = collector();
  const clip = clipFactory(c.sink);
  clip.polygonStart();
  for (const ring of poly.coordinates) {
    clip.lineStart();
    // d3 feeds rings without the repeated closing vertex
    for (let i = 0; i < ring.length - 1; i++) clip.point(ring[i][0] * rad, ring[i][1] * rad);
    clip.lineEnd();
  }
  clip.polygonEnd();
  return c.result();
}

// Rings wound for d3-geo's convention (exterior clockwise seen from outside).
function box(lonMin, lonMax, latMin, latMax) {
  return { type: 'Polygon', coordinates: [[
    [lonMin, latMin], [lonMin, latMax], [lonMax, latMax], [lonMax, latMin], [lonMin, latMin]
  ]] };
}

// A ring encircling a pole, wound so the interior is the small cap rather
// than the rest of the sphere. This is the Antarctica-shaped case: the ring
// never closes in longitude, so every lobe sees it, and the reconstruction
// has to walk the wedge boundary over the pole itself.
function polarCap(lat) {
  const ring = [];
  for (let lon = -180; lon <= 180; lon += 5) ring.push([lon, lat]);
  let poly = { type: 'Polygon', coordinates: [ring] };
  if (d3.geoArea(poly) > 2 * Math.PI) {
    poly = { type: 'Polygon', coordinates: [ring.slice().reverse()] };
  }
  return poly;
}

const cases = [
  ['small box, one lobe',   box(-10, 10, -20, 20)],
  ['wide box, many lobes',  box(-100, 100, -40, 40)],
  ['equatorial band',       box(-170, 170, -10, 10)],
  ['tall box across seams', box(-95, -25, -80, 80)],
  ['near-polar cap',        box(-170, 170, 60, 85)],
  ['straddles antimeridian',box(150, 210, -30, 30)],
  ['encircles north pole',  polarCap(70)],
  ['encircles south pole',  polarCap(-70)],
];

const lobeCounts = [4, 12, 24];
// Each lobe's boundary is deliberately inset by 1e-6 radians (see inward()
// in geoPolarPetalFillClip.js) to keep boundary vertices off the seams, so a
// small area deficit is expected and correct: roughly n * 2 * 1e-6 / (2*pi),
// about 8e-6 relative at n=24. The tolerance sits well above that and still
// far below any real defect - the bugs this test was written to catch ran
// from 3% to 1800% off.
const TOL = 1e-4;
let failures = 0;

for (const n of lobeCounts) {
  const sector = 2 * Math.PI / n, half = sector / 2;
  for (const [label, poly] of cases) {
    const reference = d3.geoArea(poly);
    let measured = 0;
    for (let k = 0; k < n; k++) {
      measured += d3.geoArea(runClip(geoPolarPetalFillPreclip.wedge(k * sector, half), poly));
    }
    const relErr = Math.abs(measured - reference) / reference;
    const ok = relErr < TOL;
    if (!ok) failures++;
    console.log(
      `${ok ? 'PASS' : 'FAIL'} n=${String(n).padStart(2)} ${label.padEnd(24)}` +
      ` expected=${reference.toFixed(6)} got=${measured.toFixed(6)}` +
      ` (${(relErr * 100).toFixed(3)}% off)`
    );
  }
}

console.log('\n' + (failures === 0 ? 'ALL PASS' : `${failures} CASES FAILED`));
process.exit(failures === 0 ? 0 : 1);

// Equal-area test for the "gore" width profile.
//
// Claim: with w(t) = sin(rho)/rho the projection preserves area exactly.
// The projected area element in polar form is
//     dA = r * |d(r,theta)/d(rho,lambda)| drho dlambda = rho * w * spread ...
// and substituting w = sin(rho)/rho collapses it to spread * sin(rho), which
// is the sphere's own element cos(phi) dphi dlambda. Scaling by .scale(k)
// multiplies areas by k^2, so the prediction is
//
//     projectedArea / sphericalArea  ===  k^2 * spread,  everywhere.
//
// Test polygons are kept small and inside a single lobe so no interruption
// splits them - this measures the raw projection, not the clipping.
//
// geoPath.area measures the RENDERED polyline, whose edges approximate the
// true curved boundary, so a small discretisation residual is expected and
// is not a property violation. It converges away as the approximation
// improves: with 8x6 degree boxes at default precision the ratio varies
// 0.465%, and tightening to 2x1.5 degree boxes at precision 0.0005 takes
// that to 0.004% while the mean converges on exactly k^2 * spread = 25600.
// Hence the tight settings and the 0.1% tolerance below - still three
// orders of magnitude under the 51-187% that the non-equal-area profiles
// show, so the test discriminates comfortably.

import * as d3 from 'd3-geo';
import { geoPolarPetal } from '../js/geoPolarPetal.js';

function box(lonC, latC, halfLon, halfLat) {
  const a = lonC - halfLon, b = lonC + halfLon;
  const c = latC - halfLat, d = latC + halfLat;
  return { type: 'Polygon', coordinates: [[[a, c], [a, d], [b, d], [b, c], [a, c]]] };
}

// Latitudes spanning pole to pole, all inside lobe 0 (centred on lon 0).
const lats = [-85, -70, -50, -30, -10, 0, 10, 30, 50, 70, 85];
const SCALE = 160;
const PRECISION = 0.0005;

let failures = 0;

function check(profile, n, spread, expectEqualArea) {
  const p = geoPolarPetal().lobes(n).profile(profile).spread(spread)
    .scale(SCALE).translate([0, 0]).precision(PRECISION);
  const path = d3.geoPath(p);
  const ratios = [];
  for (const lat of lats) {
    const poly = box(0, lat, 1, 0.75);
    const sph = d3.geoArea(poly);
    const prj = Math.abs(path.area(poly));
    ratios.push(prj / sph);
  }
  const min = Math.min(...ratios), max = Math.max(...ratios);
  const spreadPct = (max - min) / ((max + min) / 2);
  const predicted = SCALE * SCALE * spread;
  const biasPct = Math.abs((min + max) / 2 - predicted) / predicted;

  const isEqualArea = spreadPct < 1e-3 && biasPct < 1e-3;
  const ok = isEqualArea === expectEqualArea;
  if (!ok) failures++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'} profile=${profile.padEnd(7)} n=${String(n).padStart(2)} spread=${spread}` +
    `  ratio varies ${(spreadPct * 100).toFixed(4)}%` +
    `  vs predicted k^2*spread=${predicted}: ${(biasPct * 100).toFixed(4)}% off` +
    `  -> ${isEqualArea ? 'equal-area' : 'NOT equal-area'}` +
    `${expectEqualArea ? '' : ' (expected)'}`
  );
}

console.log('gore profile - expected to be exactly equal-area:');
for (const n of [4, 8, 12, 24]) check('gore', n, 1, true);
check('gore', 12, 0.6, true);
check('gore', 12, 1.4, true);

console.log('\ncontrol - other profiles must NOT be equal-area (proves the test discriminates):');
check('sine', 12, 1, false);
check('vesica', 12, 1, false);
check('leaf', 12, 1, false);

console.log('\n' + (failures === 0 ? 'ALL PASS' : `${failures} CASES FAILED`));
process.exit(failures === 0 ? 0 : 1);

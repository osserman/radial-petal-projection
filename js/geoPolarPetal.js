// geoPolarPetal — an interrupted radial "petal" projection.
//
// Every lobe starts at the projection center (t=0), bows outward, and
// closes to a cusp at the antipodal point (t=1). Width along each lobe
// follows a swappable envelope w(t), raised to the .bow(b) exponent.
//
// Natively centered on the north pole (declared via .center([0,90]), see
// note below). To center elsewhere, use the standard d3 .rotate() - the
// seam clip runs after rotation in d3's pipeline, so it follows the view.
//
// API:
//   geoPolarPetal()
//     .lobes(n)             // number of petals, integer >= 2 (default 12)
//     .bow(b)                // exponent applied to the width envelope (default 1)
//     .spread(s)             // fraction of the natural sector width each lobe uses (default 1)
//     .profile(name)         // width envelope shape: "sine" (default) | "vesica" | "leaf" | "gore" | "bezier"
//     .profilePoints(pts)    // control points [[t,w],...] for profile("bezier"); first/last t forced to 0/1
//     .widthAt(t)            // the current w(t) envelope value, exposed so callers (e.g. a
//                             // reference-outline overlay) never have to duplicate this math
//     .raw()                 // an equator-centered raw (lambda,phi)->[x,y], for composing with
//                             // other raw functions - see geoPolarPetalRawCentered below
//
// Otherwise this is a completely normal d3 projection - .scale(), .translate(),
// .rotate(), .center(), .precision(), .clipExtent(), .fitSize(), .invert()
// all behave exactly as they do on any projection built with
// d3.geoProjectionMutator. In particular, d3.geoPath(projection)(geojson)
// just works for graticules, Sphere, and filled Polygon/MultiPolygon alike -
// the projection's own .stream() detects which kind of geometry is flowing
// through it and routes to the appropriate preclip (see geoPolarPetal()'s
// override below); callers never need to touch preclip themselves.
//
// Depends on d3-geo (geoProjectionMutator, geoClipAntimeridian, geoRotation).

import { geoProjectionMutator, geoClipAntimeridian, geoRotation } from "d3-geo";
import { geoPolarPetalFillPreclip } from "./geoPolarPetalFillClip.js";

var defaultBezierPoints = [[0, 0], [0.15, 1.05], [0.85, 1.05], [1, 0]];

function bezierPointAt(points, s) {
  var pts = points.map(function(p) { return [p[0], p[1]]; });
  while (pts.length > 1) {
    var next = [];
    for (var i = 0; i < pts.length - 1; i++) {
      next.push([
        pts[i][0] + (pts[i + 1][0] - pts[i][0]) * s,
        pts[i][1] + (pts[i + 1][1] - pts[i][1]) * s
      ]);
    }
    pts = next;
  }
  return pts[0];
}

// Control points are given as [t, w] pairs, an arbitrary parametric Bezier
// curve - not literally "w as a function of t" until we solve for it, since
// the curve's own parameter s does not advance at the same rate as t. Given
// the curve is monotonic in t (true for any reasonable bulge shape), a plain
// bisection on s recovers w(t) to float precision in ~30 steps.
function bezierWidthAt(t, points) {
  var lo = 0, hi = 1, s = t;
  for (var i = 0; i < 30; i++) {
    var pt = bezierPointAt(points, s);
    if (Math.abs(pt[0] - t) < 1e-9) break;
    if (pt[0] < t) lo = s; else hi = s;
    s = (lo + hi) / 2;
  }
  return bezierPointAt(points, s)[1];
}

// A true vesica piscis is the overlap of two equal-radius circles, each
// centered on the other's edge (classic D=R construction). Its sharp cusps
// are where the two circle arcs literally cross - and for circles placed
// side by side, those crossings sit at the ENDS of the shape's long axis,
// not at its widest point. Parametrizing t along that long axis (t=0 and
// t=1 at the cusps, t=0.5 at the widest point), the actual (Cartesian)
// width as a function of t is: V(t) = 2*sqrt(1 - 0.75*(2t-1)^2) - 1. This
// is smooth (zero slope, no kink) at t=0.5 - the two arcs' widths agree in
// both value and derivative there, since it's an ordinary interior point of
// the lens, not a crossing - and has a finite (steep but not infinite)
// slope at the cusps, since each cusp is where a single circle's own
// boundary reaches its extremum, not two different arcs meeting at an angle.
//
// V(t) is a Cartesian width, but these petals build width by multiplying an
// ANGULAR envelope by the radius, and the radius is linear in t (that is
// what preserves azimuthal-equidistant distance from the center). So the
// width actually drawn on screen is t * w(t), not w(t) alone. To make the
// drawn width follow the vesica profile we therefore need
//
//     t * w(t)  proportional to  V(t)      =>      w(t) = C * V(t) / t
//
// and the only constraint is that the petal stay inside its own lobe, i.e.
// w(t) * spread <= 1.
//
// An earlier version of this comment claimed that was impossible - that
// V(t)/t exceeds 1 below the midpoint, forcing either a clamped wedge or a
// needle. That reasoning was simply wrong: it compared V(t)/t against 1
// while ignoring the free normalisation constant C. What actually matters is
// max(V(t)/t), which is finite. V(t) leaves the cusp with slope dV/dt = 6,
// and V(t)/t decreases from there, so max(V(t)/t) = 6 (approached as t->0).
// Taking C = 1/6 gives w(t) = V(t)/(6t) <= 1 everywhere, with equality only
// in the limit at the cusp. Verified numerically: max w = 1.000000000, drawn
// width symmetric to 1.1e-16, peak exactly at t = 0.5.
//
// So the drawn petal is a true vesica piscis: widest at the equator, tapering
// symmetrically to both tips, with equidistance (r = rho) fully intact.
//
// One honest consequence: a real vesica has a finite (non-zero) tip angle, so
// w(0) = 1 - at spread 1 the petals meet edge-to-edge at the very center and
// only draw apart further out. That is inherent to the shape, not a defect;
// lowering .spread() opens a gap all the way in, at the cost of thinner
// petals overall. Wanting a visible gap at the center AND a symmetric profile
// means giving up the finite tip angle, which is what the sine and leaf
// profiles do.
var VESICA_TIP_SLOPE = 6; // dV/dt at t=0, and therefore max of V(t)/t

function vesicaWidth(t) {
  var u = 2 * t - 1;
  var v = 2 * Math.sqrt(Math.max(0, 1 - 0.75 * u * u)) - 1;
  if (t < 1e-9) return 1; // limit of V(t)/(6t) as t -> 0
  return Math.max(0, v / (VESICA_TIP_SLOPE * t));
}

// The gentler "leaf" profile: a semicircle as a function of t. Also goes to
// zero with infinite slope at both tips, but rises more gradually than the
// vesica formula above, giving a softer, more rounded silhouette.
function leafWidth(t) {
  var u = 2 * t - 1;
  return Math.sqrt(Math.max(0, 1 - u * u));
}

// The literal orange-peel gore: what you actually get by slicing a globe
// along n meridians and flattening the peel without stretching it.
//
// Flattening a gore preserves two things. Distance along the gore's spine -
// which this projection already has, since r = rho. And the width at each
// latitude, which on the sphere is the arc of the parallel inside the gore:
//
//     half-width(phi) = (sector/2) * cos(phi) = (sector/2) * sin(rho)
//
// The width this projection actually draws is rho * (sector/2) * w * spread,
// so matching the peel requires
//
//     rho * w = sin(rho)      =>      w(t) = sin(rho)/rho,  rho = PI*t
//
// a sinc. Its maximum is 1 (at the tip), so it never overflows its lobe.
//
// Note this is NOT the existing "sine" profile. That one sets w = sin(PI*t)
// directly, which leaves the DRAWN width as t*sin(PI*t) - peaking at
// t = 0.646 rather than at the equator, which is the outward-shifted
// asymmetry that motivated all of this. Dividing by rho is exactly the
// correction, and it lands on the true peel shape rather than merely a
// symmetric one.
//
// It is also exactly EQUAL-AREA. In polar form the projected area element is
// dA = r * |d(r,theta)/d(rho,lambda)| drho dlambda = rho * w * spread
// drho dlambda, and substituting w = sin(rho)/rho collapses that to
// spread * sin(rho) drho dlambda - which is precisely the sphere's own
// element cos(phi) dphi dlambda. So area is preserved up to the single
// global factor `spread`, for every lobe count. Verified numerically in
// test/equal-area.mjs.
function goreWidth(t) {
  var rho = Math.PI * t;
  if (rho < 1e-9) return 1; // limit of sin(rho)/rho as rho -> 0
  return Math.sin(rho) / rho;
}

function widthEnvelope(t, profile, bow, bezierPoints) {
  t = Math.min(Math.max(t, 0), 1);
  // bow (an exponent) only means "side curvature" for the sine construction
  // it was designed around. vesica and gore are specific derivations - an
  // exponent just distorts them away from being that shape, and for gore it
  // would additionally destroy the equal-area property - so both are
  // excluded. leaf and bezier aren't claims to a specific named
  // construction, so bow composing with them (even without a clean
  // mathematical meaning) is a legitimate artistic knob.
  if (profile === "gore") return goreWidth(t);
  if (profile === "vesica") return vesicaWidth(t);
  if (profile === "leaf") return Math.pow(Math.max(0, leafWidth(t)), bow);
  if (profile === "bezier") return Math.pow(Math.max(0, bezierWidthAt(t, bezierPoints || defaultBezierPoints)), bow);
  return Math.pow(Math.max(0, Math.sin(Math.PI * t)), bow);
}

function cartesian(lambda, phi) {
  var cosPhi = Math.cos(phi);
  return [cosPhi * Math.cos(lambda), cosPhi * Math.sin(lambda), Math.sin(phi)];
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function angleDelta(a, b) {
  var d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize(v) {
  var len = Math.hypot(v[0], v[1], v[2]);
  return len < 1e-12 ? null : [v[0] / len, v[1] / len, v[2] / len];
}

// atan2 of |a x b| against a.b, rather than acos(a.b): acos loses roughly
// half its significant digits as the angle approaches 0 (its slope goes
// vertical there), which for a 2.5-degree graticule step is enough error to
// break an exact arc-containment comparison. The atan2 form stays accurate
// across the whole range.
function arcAngle(a, b) {
  var c = cross(a, b);
  return Math.atan2(Math.hypot(c[0], c[1], c[2]), dot(a, b));
}

function geoPolarPetalRaw(n, bow, spread, profile, bezierPoints) {
  var sector = 2 * Math.PI / n;

  function forward(lambda, phi) {
    var rho = Math.PI / 2 - phi; // colatitude from center point: 0 at pole, PI at antipode
    var t = rho / Math.PI;
    var w = widthEnvelope(t, profile, bow, bezierPoints);
    var k = Math.round(lambda / sector);
    var lambda0 = k * sector;
    var dl = lambda - lambda0;
    var theta = lambda0 + dl * w * spread;
    return [rho * Math.cos(theta), rho * Math.sin(theta)];
  }

  forward.invert = function(x, y) {
    var r = Math.sqrt(x * x + y * y);
    var t = Math.min(Math.max(r / Math.PI, 0), 1);
    var w = widthEnvelope(t, profile, bow, bezierPoints);
    var theta = Math.atan2(y, x);
    var k = Math.round(theta / sector);
    var lambda0 = k * sector;
    var dl = w > 1e-6 ? (theta - lambda0) / (w * spread) : 0;
    return [lambda0 + dl, Math.PI / 2 - r];
  };

  return forward;
}

// A "raw" variant centered the way essentially every other d3 raw
// projection is: rawCentered(0, 0) = [0, 0], the equator/prime-meridian
// point at the origin. geoPolarPetalRaw above is pole-native instead -
// rho is measured as colatitude from phi=PI/2, so raw(anyLambda, PI/2) is
// what equals [0,0], not raw(0,0) - which is exactly right for this
// projection's own default view (north pole at the center) but is NOT the
// convention tools built around raw functions generally assume. In
// particular, d3's own projection-interpolation technique (see e.g.
// https://observablehq.com/@d3/projection-transitions) blends two raw
// functions' outputs directly - lerp(raw0(x,y), raw1(x,y), t) - with no
// per-raw recentering step of its own. Blending our pole-native raw
// against a normal equator-native one that way would visibly drift at
// intermediate t, since the two raws would disagree about where (0,0)
// even is.
//
// Rather than rework the pole-native math itself (and by extension
// geoPolarPetalPreclip, which depends on lambda directly meaning "azimuth
// from center" - only true at the pole), this composes a FIXED rotation
// that brings the equator point to the pole before handing off to the
// existing, already-verified pole-native forward function unchanged. It's
// a pure coordinate-frame change: same shape, same lobe/profile math,
// just re-anchored at (0,0) the way raw functions are expected to be.
//
// This is for composing with other raw functions (projection transitions,
// or any tool built around the *Raw convention) - NOT for normal use.
// geoPolarPetal() below - with its own .center([0,90]) and the seam-aware
// preclip - is still the one to reach for for anything that needs
// interruption clipping, fills, or the pole-centered default view.
function geoPolarPetalRawCentered(n, bow, spread, profile, bezierPoints) {
  var poleNative = geoPolarPetalRaw(n, bow, spread, profile, bezierPoints);
  var toPoleFrame = geoRotation([0, 90, 0]);
  var deg = 180 / Math.PI, rad = Math.PI / 180;

  function forward(lambda, phi) {
    var r = toPoleFrame([lambda * deg, phi * deg]);
    return poleNative(r[0] * rad, r[1] * rad);
  }

  forward.invert = function(x, y) {
    var p = poleNative.invert(x, y);
    var r = toPoleFrame.invert([p[0] * deg, p[1] * deg]);
    return [r[0] * rad, r[1] * rad];
  };

  return forward;
}

// Every lobe boundary (the meridian midway between two adjacent lobe
// centers) is a genuine topological seam: geometry crossing it must be
// broken into separate line segments, or d3 will draw a straight chord
// connecting the two lobes. This mirrors d3-geo's own clipAntimeridianLine
// (which does exactly this for the single seam at lambda=+-PI), generalized
// to n seams at (k+0.5)*sector, using cartesian great-circle/meridian
// intersection instead of the antimeridian-specific trig identity.
//
// Real antimeridian-crossing geometry (e.g. Russia, Fiji) is normalized by
// chaining d3's own geoClipAntimeridian in front of this, so no segment
// arriving here spans more than one lobe boundary.
//
// This does not depend on the width profile/bow/spread at all - it only
// needs to know which lobe a longitude belongs to - so swapping profiles
// never touches this.
//
// Crossings are found ANALYTICALLY, and no interpolated vertices are ever
// inserted into the stream. An earlier version densified each segment first
// (so that a plain endpoint-to-endpoint lobe comparison couldn't miss a
// crossing), but any densification has to invent intermediate points, and
// the ones it invents are not on the true great circle: plain (lambda,phi)
// interpolation deviated by up to 14 degrees on a rotated graticule
// meridian, which is what produced visible kinks mid-lobe and misrouted
// meridians near the poles. Subdividing along the true geodesic instead
// runs into atan2 instability wherever the arc passes near a pole.
//
// Both problems disappear by not interpolating at all. A minor great-circle
// arc meets a given meridian plane in at most one point, computed in closed
// form, so every crossing along a segment - however long, however coarsely
// the source sampled it - is found exactly by testing the arc against each
// of the n seam planes. d3's own resample stage (which runs immediately
// after preclip) then draws the true great circle between the points we
// emit, so the rendered geometry is correct by construction.
function geoPolarPetalPreclip(n) {
  var sector = 2 * Math.PI / n,
      epsilon = 1e-6;

  // Every seam meridian this arc crosses, in order along the arc.
  function seamCrossings(lambda0, phi0, lambda1, phi1) {
    var p0 = cartesian(lambda0, phi0), p1 = cartesian(lambda1, phi1);
    var planeNormal = normalize(cross(p0, p1));
    // Degenerate: the endpoints coincide, or are exactly antipodal (in
    // which case infinitely many great circles connect them and the arc
    // itself is ambiguous). Nothing meaningful to split.
    if (!planeNormal) return [];
    var total = arcAngle(p0, p1);
    if (total < 1e-12) return [];

    var crossings = [];
    for (var k = 0; k < n; k++) {
      var meridian = (k + 0.5) * sector;
      var meridianNormal = [Math.sin(meridian), -Math.cos(meridian), 0];
      var dir = normalize(cross(planeNormal, meridianNormal));
      // The arc lies in the meridian's own plane - it runs along the seam
      // rather than across it, so there is no isolated crossing point.
      if (!dir) continue;
      // The two planes meet along a full diameter; only one end of it is on
      // the seam's half-meridian, the other is on the opposite meridian.
      for (var s = -1; s <= 1; s += 2) {
        var q = [dir[0] * s, dir[1] * s, dir[2] * s];
        if (q[0] * Math.cos(meridian) + q[1] * Math.sin(meridian) <= 0) continue;
        // On the minor arc iff p0 -> q and q -> p1 both wind the same way
        // around the arc's own plane normal. This is a sign test on exact
        // products rather than a comparison of accumulated angles, so it
        // stays reliable for arbitrarily short segments.
        if (dot(cross(p0, q), planeNormal) < 0) continue;
        if (dot(cross(q, p1), planeNormal) < 0) continue;
        // Skip crossings sitting on an endpoint: the split there would be
        // zero-length, and the neighbouring segment handles that boundary.
        var a0 = arcAngle(p0, q);
        if (a0 < 1e-12 || total - a0 < 1e-12) continue;
        crossings.push({
          t: a0 / total,
          // Wrapped into [-PI, PI) to match the range incoming longitudes
          // arrive in. The raw projection is indifferent (it only ever uses
          // lambda modulo 2*PI), but emitting 345 degrees where the rest of
          // the stream would say -15 is a needless surprise for anything
          // downstream that inspects the values.
          meridian: angleDelta(meridian, 0),
          phi: Math.asin(Math.max(-1, Math.min(1, q[2])))
        });
      }
    }
    crossings.sort(function(a, b) { return a.t - b.t; });

    // Every seam meridian meets at a pole, so an arc running through one
    // crosses all n of them at the same instant. Which side of each it is
    // "on" is meaningless there, so collapse them into a single transition
    // the caller can handle as one event.
    var collapsed = [], seenPole = false;
    for (var c = 0; c < crossings.length; c++) {
      if (Math.abs(Math.abs(crossings[c].phi) - Math.PI / 2) < 1e-9) {
        if (seenPole) continue;
        seenPole = true;
        collapsed.push({ t: crossings[c].t, phi: crossings[c].phi, pole: true });
      } else {
        collapsed.push(crossings[c]);
      }
    }
    return collapsed;
  }

  // A vertex lying exactly on a seam meridian is genuinely ambiguous: it sits
  // on the shared boundary of two lobes, which the raw projection sends to
  // two different screen points (that separation IS the interruption), and
  // round(lambda / sector) picks between them on floating-point noise alone.
  // Source data hits this constantly rather than rarely - with 24 lobes the
  // seams land on 7.5-degree multiples, and every 2.5-degree graticule step
  // falls on one exactly. Resolve it by nudging the vertex a hair toward
  // whichever side the rest of its segment lies on, so the segment stays
  // wholly within one lobe. The same trick d3's own antimeridian clip uses
  // for vertices sitting exactly on +-180.
  function nudgeOffSeam(lambda, towardLambda) {
    var meridian = (Math.round(lambda / sector - 0.5) + 0.5) * sector;
    if (Math.abs(angleDelta(lambda, meridian)) > 1e-9) return lambda;
    var side = angleDelta(towardLambda, meridian);
    if (side === 0) return lambda;
    return meridian + (side > 0 ? epsilon : -epsilon);
  }

  function isPole(phi) {
    return Math.abs(Math.abs(phi) - Math.PI / 2) < 1e-9;
  }

  function lobeIndex(lambda) {
    return ((Math.round(lambda / sector) % n) + n) % n;
  }

  // Longitude carries no information at a pole - every meridian meets there,
  // so whatever value the source happened to attach to the vertex is
  // arbitrary. Adopt the neighbouring vertex's longitude instead, so the
  // segment stays within a single lobe rather than appearing to span from
  // whichever lobe the arbitrary value named.
  function resolveVertex(lambda, phi, towardLambda) {
    if (isPole(phi)) return towardLambda;
    return nudgeOffSeam(lambda, towardLambda);
  }

  function clipLine(sink) {
    var lambda0 = NaN, phi0 = NaN, pendingFirst = null;
    function pointImpl(lambda1, phi1) {
      // The first vertex of a line can't be disambiguated until we know
      // which way the line leaves it, so hold it until the second arrives.
      if (pendingFirst) {
        lambda0 = resolveVertex(pendingFirst[0], pendingFirst[1], lambda1);
        phi0 = pendingFirst[1];
        pendingFirst = null;
        sink.point(lambda0, phi0);
      } else if (isNaN(lambda0)) {
        pendingFirst = [lambda1, phi1];
        return;
      }
      lambda1 = resolveVertex(lambda1, phi1, lambda0);
      // Leaving a pole, the outgoing direction picks the longitude - and if
      // that is a different lobe than we arrived in, the line has to break:
      // at the antipode every lobe has its own separate cusp tip.
      if (!isNaN(lambda0) && isPole(phi0) && lobeIndex(lambda1) !== lobeIndex(lambda0)) {
        sink.lineEnd();
        sink.lineStart();
        sink.point(lambda1, phi0);
        lambda0 = lambda1;
      }
      if (!isNaN(lambda0)) {
        var crossings = seamCrossings(lambda0, phi0, lambda1, phi1);
        for (var i = 0; i < crossings.length; i++) {
          var c = crossings[i];
          if (c.pole) {
            // Passing through a pole flips longitude by 180 degrees. The
            // pole is a single geographic point but the projection sends it
            // to a different place in every lobe (the cusp tip at the
            // antipode, the shared origin at the centre), so the line has to
            // terminate on the way in and restart on the way out.
            var after = angleDelta(lambda0 + Math.PI, 0);
            sink.point(lambda0, c.phi);
            sink.lineEnd();
            sink.lineStart();
            sink.point(after, c.phi);
            lambda0 = after; phi0 = c.phi;
            continue;
          }
          // Which way we cross is set by which side of the seam we are
          // currently on, so this stays correct however many lobes the
          // segment passes through.
          var dir = angleDelta(lambda0, c.meridian) < 0 ? 1 : -1;
          sink.point(c.meridian - dir * epsilon, c.phi);
          sink.lineEnd();
          sink.lineStart();
          sink.point(c.meridian + dir * epsilon, c.phi);
          lambda0 = c.meridian + dir * epsilon; phi0 = c.phi;
        }
      }
      sink.point(lambda1, phi1);
      lambda0 = lambda1; phi0 = phi1;
    }
    return {
      point: pointImpl,
      lineStart: function() {
        sink.lineStart();
        lambda0 = phi0 = NaN;
        pendingFirst = null;
      },
      lineEnd: function() {
        // A degenerate one-point line: nothing ever arrived to disambiguate
        // it against, so emit it unchanged.
        if (pendingFirst) {
          sink.point(pendingFirst[0], pendingFirst[1]);
          pendingFirst = null;
        }
        sink.lineEnd();
      }
    };
  }

  return function(sink) {
    var line = clipLine(sink);
    var clip = {
      point: function(lambda, phi) { sink.point(lambda, phi); },
      lineStart: function() { clip.point = line.point; line.lineStart(); },
      lineEnd: function() { clip.point = clip.pointDefault; line.lineEnd(); },
      polygonStart: function() { sink.polygonStart(); },
      polygonEnd: function() { sink.polygonEnd(); },
      sphere: function() { sink.sphere && sink.sphere(); }
    };
    clip.pointDefault = clip.point;
    return clip;
  };
}

function geoPolarPetal() {
  var n = 12,
      bow = 1,
      spread = 1,
      profile = "sine",
      bezierPoints = defaultBezierPoints,
      m = geoProjectionMutator(function(n, bow, spread) {
        return geoPolarPetalRaw(n, bow, spread, profile, bezierPoints);
      }),
      p = m(n, bow, spread);

  function linePreclip(sink) {
    return geoClipAntimeridian(geoPolarPetalPreclip(n)(sink));
  }

  function refreshPreclip() {
    p.preclip(linePreclip);
  }

  // Kept for anyone who already depends on it, but no longer needed for
  // ordinary use now that .stream() (below) picks the right preclip on its
  // own - see the note there.
  p.linePreclip = function() {
    return linePreclip;
  };

  function rebuild() {
    return m(n, bow, spread);
  }

  // Filled polygons need real ring reconstruction, not just line splitting:
  // a ring cut at a seam has to be closed by walking along the lobe's own
  // boundary, or it auto-closes with a straight chord that slices across
  // whatever it was drawing. That reconstruction (geoPolarPetalFillPreclip)
  // is a heavier, separate preclip - correct for lines too, just needlessly
  // expensive for them - so rather than pick one preclip for everything,
  // .stream() below builds BOTH pipelines and switches between them based on
  // which kind of geometry is actually flowing through: polygonStart/End
  // brackets (Polygon, MultiPolygon) get the fill preclip; everything
  // outside them (LineString, MultiLineString, the graticule) gets the
  // cheap line preclip. This is what makes d3.geoPath(projection)(geojson)
  // just work for arbitrary GeoJSON without the caller ever touching
  // preclip - the same way d3's own interrupted projections behave, and
  // unlike earlier versions of this projection, which needed a manual
  // preclip swap around any code that rendered filled land.
  //
  // Implementation note: geoProjectionMutator's own .stream() memoizes one
  // stream per output sink (a cache keyed on reference equality), rebuilt
  // whenever .preclip() is called (preclip's setter calls reset(), which
  // clears the cache) - so building each pipeline by temporarily setting
  // preclip and invoking the ORIGINAL .stream() is safe: the two calls
  // below don't collide, each gets a freshly built stream for its own
  // preclip, and preclip is left on linePreclip afterward (its normal
  // default) rather than on whichever ran last.
  var baseStream = p.stream;

  p.stream = function(output) {
    p.preclip(linePreclip);
    var lineStream = baseStream.call(p, output);
    p.preclip(function(sink) { return geoPolarPetalFillPreclip(n)(sink); });
    var fillStream = baseStream.call(p, output);
    p.preclip(linePreclip);

    var active = lineStream;
    return {
      point: function(x, y) { active.point(x, y); },
      lineStart: function() { active.lineStart(); },
      lineEnd: function() { active.lineEnd(); },
      polygonStart: function() { active = fillStream; active.polygonStart(); },
      polygonEnd: function() { active.polygonEnd(); active = lineStream; },
      sphere: function() { active.sphere(); }
    };
  };

  p.lobes = function(_) {
    if (!arguments.length) return n;
    n = Math.max(2, Math.floor(+_));
    rebuild();
    refreshPreclip();
    return p;
  };

  p.bow = function(_) {
    return arguments.length ? (bow = +_, rebuild()) : bow;
  };

  p.spread = function(_) {
    return arguments.length ? (spread = +_, rebuild()) : spread;
  };

  p.profile = function(_) {
    return arguments.length ? (profile = _, rebuild()) : profile;
  };

  p.profilePoints = function(_) {
    if (!arguments.length) return bezierPoints;
    bezierPoints = _.map(function(pt) { return [pt[0], pt[1]]; });
    bezierPoints[0][0] = 0;
    bezierPoints[bezierPoints.length - 1][0] = 1;
    return rebuild();
  };

  p.widthAt = function(t) {
    return widthEnvelope(t, profile, bow, bezierPoints);
  };

  // The equator-centered raw (see geoPolarPetalRawCentered above), built
  // fresh from whatever lobes/bow/spread/profile/profilePoints are
  // currently set. For composing with other raw functions - e.g. d3's
  // projection-interpolation technique - not for direct use as a
  // projection: it has no seam-aware preclip, so filled/interrupted
  // geometry through it will show the straight-chord artifact the main
  // preclip exists to avoid. Fine for the sphere outline, graticule, and
  // simplified geometry a transition is typically drawn with.
  p.raw = function() {
    return geoPolarPetalRawCentered(n, bow, spread, profile, bezierPoints);
  };

  refreshPreclip();
  // This raw projection is natively centered at the north pole (raw(lambda,90)
  // is always [0,0]), not at d3's assumed default center of (lambda=0,phi=0).
  // Without declaring that via .center(), d3's recenter() subtracts
  // raw(0,0) - a nonzero point out at the equatorial radius - from every
  // output, shifting the whole map by a constant offset.
  return p.scale(160).translate([0, 0]).center([0, 90]);
}

export { geoPolarPetal, geoPolarPetalRaw, geoPolarPetalRawCentered, geoPolarPetalPreclip };

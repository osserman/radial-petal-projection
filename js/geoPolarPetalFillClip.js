// geoPolarPetalFillPreclip(n) - a preclip for FILLED polygon geometry (countries,
// land) that correctly reconstructs polygon rings crossing a lobe seam, instead
// of the straight-chord approximation the default seam-splitting preclip
// (js/geoPolarPetal.js) leaves for filled shapes. Not used for lines/graticules,
// which are already exact under the cheaper default preclip.
//
// Why this is a separate, heavier mechanism: correctly closing a filled ring
// that crosses a seam requires walking along the seam boundary between the
// ring's exit and entry points (not just breaking the line), which needs
// d3's actual polygon-clip/rejoin machinery - the same engine that powers
// geoClipAntimeridian and geoClipCircle. That engine (clip/index.js,
// clip/rejoin.js, clip/buffer.js, polygonContains.js in d3-geo's source) is
// not part of d3's public API, so it's vendored here verbatim rather than
// reinvented - see https://github.com/d3/d3-geo/tree/main/src/clip.
//
// Approach: rather than one combined N-seam clip (which would need a single
// linear ordering across all N seams meeting at 2 poles - a "theta graph",
// not the simple loop clipRejoin's ordering assumes), this clips each lobe
// independently as its own simple closed boundary loop (north pole -> down
// its left meridian -> south pole -> up its right meridian -> north pole).
// That loop is structurally identical to geoClipAntimeridian's own boundary
// (one meridian + two poles), just narrower - so it's compatible with
// clipRejoin by construction, not by a novel argument. A polygon is run
// through all N of these independent per-lobe clips (fanned out to the same
// sink), each contributing only the fragment(s) that fall in its lobe.
//
// The clip boundary for a lobe is a fixed-width lon/lat wedge, NOT the bowed
// petal shape itself - that's correct, because the bowing is applied by
// geoPolarPetalRaw's own forward() to every point inside the wedge; the clip
// only has to decide which lobe a geographic point belongs to.

var EPS = 1e-6, EPS2 = 1e-12, PI = Math.PI, HALF_PI = PI / 2, QUARTER_PI = PI / 4, TAU = PI * 2;
function sign(x) { return x > 0 ? 1 : x < 0 ? -1 : 0; }

function pointEqual(a, b) {
  return Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS;
}

function Adder() { this.s = 0; this.c = 0; }
Adder.prototype.add = function(x) {
  var t = this.s + x;
  this.c += Math.abs(this.s) >= Math.abs(x) ? (this.s - t) + x : (x - t) + this.s;
  this.s = t;
  return this;
};
Adder.prototype.valueOf = function() { return this.s + this.c; };

function merge(arrays) { return [].concat.apply([], arrays); }

function clipBuffer() {
  var lines = [], line;
  return {
    point: function(x, y, m) { line.push([x, y, m]); },
    lineStart: function() { lines.push(line = []); },
    lineEnd: function() {},
    rejoin: function() { if (lines.length > 1) lines.push(lines.pop().concat(lines.shift())); },
    result: function() { var result = lines; lines = []; line = null; return result; }
  };
}

function Intersection(point, points, other, entry) {
  this.x = point; this.z = points; this.o = other; this.e = entry; this.v = false; this.n = this.p = null;
}

function link(array) {
  var n = array.length;
  if (!n) return;
  var i = 0, a = array[0], b;
  while (++i < n) { a.n = b = array[i]; b.p = a; a = b; }
  a.n = b = array[0]; b.p = a;
}

function clipRejoin(segments, compareIntersection, startInside, interpolate, stream) {
  var subject = [], clip = [], i, n;
  segments.forEach(function(segment) {
    if ((n = segment.length - 1) <= 0) return;
    var n, p0 = segment[0], p1 = segment[n], x;
    if (pointEqual(p0, p1)) {
      if (!p0[2] && !p1[2]) {
        stream.lineStart();
        for (i = 0; i < n; ++i) stream.point((p0 = segment[i])[0], p0[1]);
        stream.lineEnd();
        return;
      }
      p1[0] += 2 * EPS;
    }
    subject.push(x = new Intersection(p0, segment, null, true));
    clip.push(x.o = new Intersection(p0, null, x, false));
    subject.push(x = new Intersection(p1, segment, null, false));
    clip.push(x.o = new Intersection(p1, null, x, true));
  });
  if (!subject.length) return;
  clip.sort(compareIntersection);
  link(subject);
  link(clip);
  for (i = 0, n = clip.length; i < n; ++i) clip[i].e = startInside = !startInside;
  var start = subject[0], points, point;
  while (1) {
    var current = start, isSubject = true;
    while (current.v) if ((current = current.n) === start) return;
    points = current.z;
    stream.lineStart();
    do {
      current.v = current.o.v = true;
      if (current.e) {
        if (isSubject) { for (i = 0, n = points.length; i < n; ++i) stream.point((point = points[i])[0], point[1]); }
        else { interpolate(current.x, current.n.x, 1, stream); }
        current = current.n;
      } else {
        if (isSubject) { points = current.p.z; for (i = points.length - 1; i >= 0; --i) stream.point((point = points[i])[0], point[1]); }
        else { interpolate(current.x, current.p.x, -1, stream); }
        current = current.p;
      }
      current = current.o;
      points = current.z;
      isSubject = !isSubject;
    } while (!current.v);
    stream.lineEnd();
  }
}

function longitude(point) {
  return Math.abs(point[0]) <= PI ? point[0] : sign(point[0]) * ((Math.abs(point[0]) + PI) % TAU - PI);
}
function cartesianPt(point) {
  var lambda = point[0], phi = point[1], cosPhi = Math.cos(phi);
  return [cosPhi * Math.cos(lambda), cosPhi * Math.sin(lambda), Math.sin(phi)];
}
function cartesianCross(a, b) {
  return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
}
function cartesianNormalizeInPlace(d) {
  var l = Math.sqrt(d[0]*d[0]+d[1]*d[1]+d[2]*d[2]);
  d[0] /= l; d[1] /= l; d[2] /= l;
}

function polygonContains(polygon, point) {
  var lambda = longitude(point), phi = point[1], sinPhi = Math.sin(phi),
      normal = [Math.sin(lambda), -Math.cos(lambda), 0], angle = 0, winding = 0;
  var sum = new Adder();
  if (sinPhi === 1) phi = HALF_PI + EPS;
  else if (sinPhi === -1) phi = -HALF_PI - EPS;
  for (var i = 0, n = polygon.length; i < n; ++i) {
    var m = (ring = polygon[i]).length;
    if (!m) continue;
    var ring, point0 = ring[m - 1], lambda0 = longitude(point0), phi0 = point0[1] / 2 + QUARTER_PI,
        sinPhi0 = Math.sin(phi0), cosPhi0 = Math.cos(phi0);
    for (var j = 0; j < m; ++j, lambda0 = lambda1, sinPhi0 = sinPhi1, cosPhi0 = cosPhi1, point0 = point1) {
      var point1 = ring[j], lambda1 = longitude(point1), phi1 = point1[1] / 2 + QUARTER_PI,
          sinPhi1 = Math.sin(phi1), cosPhi1 = Math.cos(phi1),
          delta = lambda1 - lambda0, s = delta >= 0 ? 1 : -1, absDelta = s * delta,
          antimeridian = absDelta > PI, k = sinPhi0 * sinPhi1;
      sum.add(Math.atan2(k * s * Math.sin(absDelta), cosPhi0 * cosPhi1 + k * Math.cos(absDelta)));
      angle += antimeridian ? delta + s * TAU : delta;
      if (antimeridian ^ lambda0 >= lambda ^ lambda1 >= lambda) {
        var arc = cartesianCross(cartesianPt(point0), cartesianPt(point1));
        cartesianNormalizeInPlace(arc);
        var intersection = cartesianCross(normal, arc);
        cartesianNormalizeInPlace(intersection);
        var phiArc = (antimeridian ^ delta >= 0 ? -1 : 1) * Math.asin(intersection[2]);
        if (phi > phiArc || phi === phiArc && (arc[0] || arc[1])) winding += antimeridian ^ delta >= 0 ? 1 : -1;
      }
    }
  }
  return (angle < -EPS || angle < EPS && sum < -EPS2) ^ (winding & 1);
}

function geoClip(pointVisible, clipLine, interpolate, start, compareIntersection) {
  return function(sink) {
    var line = clipLine(sink), ringBuffer = clipBuffer(), ringSink = clipLine(ringBuffer),
        polygonStarted = false, polygon, segments, ring;
    var clip = {
      point: point, lineStart: lineStart, lineEnd: lineEnd,
      polygonStart: function() {
        clip.point = pointRing; clip.lineStart = ringStart; clip.lineEnd = ringEnd;
        segments = []; polygon = [];
      },
      polygonEnd: function() {
        clip.point = point; clip.lineStart = lineStart; clip.lineEnd = lineEnd;
        segments = merge(segments);
        var startInside = polygonContains(polygon, start);
        if (segments.length) {
          if (!polygonStarted) sink.polygonStart(), polygonStarted = true;
          clipRejoin(segments, compareIntersection, startInside, interpolate, sink);
        } else if (startInside) {
          if (!polygonStarted) sink.polygonStart(), polygonStarted = true;
          sink.lineStart(); interpolate(null, null, 1, sink); sink.lineEnd();
        }
        if (polygonStarted) sink.polygonEnd(), polygonStarted = false;
        segments = polygon = null;
      },
      sphere: function() {
        sink.polygonStart(); sink.lineStart(); interpolate(null, null, 1, sink); sink.lineEnd(); sink.polygonEnd();
      }
    };
    function point(lambda, phi) { if (pointVisible(lambda, phi)) sink.point(lambda, phi); }
    function pointLine(lambda, phi) { line.point(lambda, phi); }
    function lineStart() { clip.point = pointLine; line.lineStart(); }
    function lineEnd() { clip.point = point; line.lineEnd(); }
    function pointRing(lambda, phi) { ring.push([lambda, phi]); ringSink.point(lambda, phi); }
    function ringStart() { ringSink.lineStart(); ring = []; }
    function ringEnd() {
      pointRing(ring[0][0], ring[0][1]);
      ringSink.lineEnd();
      var clean = ringSink.clean(), ringSegments = ringBuffer.result(), i, n = ringSegments.length, m, segment, point;
      ring.pop(); polygon.push(ring); ring = null;
      if (!n) return;
      if (clean & 1) {
        segment = ringSegments[0];
        if ((m = segment.length - 1) > 0) {
          if (!polygonStarted) sink.polygonStart(), polygonStarted = true;
          sink.lineStart();
          for (i = 0; i < m; ++i) sink.point((point = segment[i])[0], point[1]);
          sink.lineEnd();
        }
        return;
      }
      if (n > 1 && clean & 2) ringSegments.push(ringSegments.pop().concat(ringSegments.shift()));
      segments.push(ringSegments.filter(function(s) { return s.length > 1; }));
    }
    return clip;
  };
}

function angleDelta(a, b) {
  var d = a - b;
  while (d > PI) d -= TAU;
  while (d < -PI) d += TAU;
  return d;
}
function cartesian(lambda, phi) {
  var cosPhi = Math.cos(phi);
  return [cosPhi * Math.cos(lambda), cosPhi * Math.sin(lambda), Math.sin(phi)];
}
function cross(a, b) {
  return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
}
function dot3(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
function unit(v) {
  var L = Math.hypot(v[0], v[1], v[2]);
  return L < 1e-12 ? null : [v[0]/L, v[1]/L, v[2]/L];
}
function arcAngle(a, b) {
  var c = cross(a, b);
  return Math.atan2(Math.hypot(c[0], c[1], c[2]), dot3(a, b));
}

// Where a great-circle arc meets one half-meridian, in closed form. Same
// construction as geoPolarPetal.js's seamCrossings - no interpolated
// points, so nothing is invented off the true arc.
function meridianHits(p0, p1, planeNormal, total, meridian, out) {
  var dir = unit(cross(planeNormal, [Math.sin(meridian), -Math.cos(meridian), 0]));
  if (!dir) return; // arc runs along this meridian; no isolated crossing
  for (var s = -1; s <= 1; s += 2) {
    var q = [dir[0]*s, dir[1]*s, dir[2]*s];
    // the two planes meet along a whole diameter; keep the end that is on
    // this meridian rather than the opposite one
    if (q[0] * Math.cos(meridian) + q[1] * Math.sin(meridian) <= 0) continue;
    if (dot3(cross(p0, q), planeNormal) < 0) continue;
    if (dot3(cross(q, p1), planeNormal) < 0) continue;
    var a0 = arcAngle(p0, q);
    if (a0 < 1e-12 || total - a0 < 1e-12) continue;
    out.push({ t: a0 / total, lambda: meridian, phi: Math.asin(Math.max(-1, Math.min(1, q[2]))) });
  }
}

// One lobe's clip region is the lon/lat wedge [left, right] x [-90, 90].
// Its boundary is a single closed loop - up the left meridian, across the
// north pole, down the right meridian, across the south pole - which is
// exactly the shape d3's clipRejoin knows how to walk. That is why the
// lobes are clipped independently rather than as one n-seam region: a
// combined boundary would be n meridians meeting at two poles, which is
// not a simple loop and which clipRejoin cannot reconstruct.
//
// The loop is parametrised by s in [0, 2):
//     s in [0, 1]  left meridian,  phi from -90 (s=0) to +90 (s=1)
//     s in [1, 2]  right meridian, phi from +90 (s=1) to -90 (s=2)
// so s increases monotonically all the way round. Both the boundary walk
// (interpolate) and the intersection ordering (compareIntersection) are
// derived from that single parameter, which is what makes them consistent
// by construction. An earlier version guessed which pole to route around
// with a hand-rolled heuristic; it disagreed with the sort order and sent
// fragments the long way round the wedge, which is what made Antarctica
// clip to roughly fifty times its own area.
function wedgeClip(center, halfWidth) {
  var left = center - halfWidth, right = center + halfWidth;

  function visible(lambda, phi) {
    return Math.abs(angleDelta(lambda, center)) <= halfWidth + 1e-9;
  }

  // Every point this clip emits on its own boundary sits exactly on a seam
  // meridian - and a point exactly on a seam is ambiguous, because the raw
  // projection's round(lambda / sector) can round it into the NEIGHBOURING
  // lobe (lambda / sector lands on k + 0.5 there, so the result turns on
  // floating-point noise alone). Assigned to the wrong lobe, a boundary
  // vertex is drawn at the far side of the gap and the filled ring spills
  // out between the petals. Nudging every emitted boundary point a hair
  // toward its own lobe's centre removes the ambiguity. The inset is 1e-6
  // radians - a few millimetres on an Earth-sized globe.
  function inward(lambda) {
    var d = angleDelta(lambda, center);
    if (d > 0) return lambda - 1e-6;
    if (d < 0) return lambda + 1e-6;
    return lambda;
  }

  function boundaryParam(lambda, phi) {
    var onLeft = Math.abs(angleDelta(lambda, left)) <= Math.abs(angleDelta(lambda, right));
    return onLeft ? (phi + HALF_PI) / PI : 1 + (HALF_PI - phi) / PI;
  }

  function boundaryPoint(s) {
    s = ((s % 2) + 2) % 2;
    return s <= 1 ? [left, s * PI - HALF_PI] : [right, HALF_PI - (s - 1) * PI];
  }

  // Every point where this arc crosses either bounding meridian, ordered
  // along the arc.
  function boundaryCrossings(a, b) {
    var p0 = cartesian(a[0], a[1]), p1 = cartesian(b[0], b[1]);
    var planeNormal = unit(cross(p0, p1));
    if (!planeNormal) return [];
    var total = arcAngle(p0, p1);
    if (total < 1e-12) return [];
    var out = [];
    meridianHits(p0, p1, planeNormal, total, left, out);
    meridianHits(p0, p1, planeNormal, total, right, out);
    out.sort(function(x, y) { return x.t - y.t; });
    return out;
  }

  // Interpolate along the true great circle between two cartesian points.
  function arcPoint(p0, p1, t, total) {
    if (total < 1e-12) return [Math.atan2(p0[1], p0[0]), Math.asin(Math.max(-1, Math.min(1, p0[2])))];
    var s = Math.sin(total), a = Math.sin((1 - t) * total) / s, b = Math.sin(t * total) / s;
    var v = [p0[0]*a + p1[0]*b, p0[1]*a + p1[1]*b, p0[2]*a + p1[2]*b];
    var L = Math.hypot(v[0], v[1], v[2]) || 1;
    return [Math.atan2(v[1], v[0]), Math.asin(Math.max(-1, Math.min(1, v[2] / L)))];
  }

  function clipLine(stream) {
    var point0 = null, v0 = false, v00 = false, clean;
    return {
      lineStart: function() { v00 = v0 = false; clean = 1; point0 = null; },
      point: function(lambda, phi) {
        var v = visible(lambda, phi);
        if (point0 === null) {
          v00 = v0 = v;
          if (v) { stream.lineStart(); stream.point(lambda, phi); }
          point0 = [lambda, phi];
          return;
        }

        var crossings = boundaryCrossings(point0, [lambda, phi]);
        var p0c = cartesian(point0[0], point0[1]), p1c = cartesian(lambda, phi);
        var total = arcAngle(p0c, p1c);

        // Decide each sub-arc's inside/outside by SAMPLING its midpoint,
        // rather than by toggling a parity bit at each crossing. Parity
        // silently desynchronises whenever a crossing coincides with a
        // vertex - which is not a rare event: with 12 lobes the seams fall
        // on 15-degree multiples, so ordinary round-numbered source
        // coordinates land on them exactly. Sampling cannot desynchronise,
        // because each sub-arc's state is measured rather than inferred.
        var bounds = [0];
        for (var b = 0; b < crossings.length; b++) bounds.push(crossings[b].t);
        bounds.push(1);

        var cur = v0;
        for (var i = 0; i + 1 < bounds.length; i++) {
          var mid = arcPoint(p0c, p1c, (bounds[i] + bounds[i + 1]) / 2, total);
          var st = visible(mid[0], mid[1]);
          if (st === cur) continue;
          // A transition at sub-arc i happens at crossing i-1; at i === 0
          // it happens right at the segment's own start point.
          var bp = i === 0 ? point0 : [crossings[i - 1].lambda, crossings[i - 1].phi];
          if (cur) { stream.point(inward(bp[0]), bp[1], 2); stream.lineEnd(); }
          else { stream.lineStart(); stream.point(inward(bp[0]), bp[1]); }
          cur = st;
          clean = 0;
        }

        // The endpoint itself may sit exactly on the boundary, so the final
        // transition can land on it rather than on any interior crossing.
        if (v !== cur) {
          if (cur) { stream.point(lambda, phi, 2); stream.lineEnd(); }
          else { stream.lineStart(); }
          cur = v;
          clean = 0;
        }

        if (v) stream.point(lambda, phi);
        point0 = [lambda, phi]; v0 = v;
      },
      lineEnd: function() { if (v0) stream.lineEnd(); point0 = null; },
      clean: function() { return clean | ((v00 && v0) << 1); }
    };
  }

  // Walk the boundary loop from `from` to `to` in `direction`, emitting the
  // pole corners and meridian midpoints crossed on the way. d3's resample
  // stage smooths between them, and since consecutive samples share a
  // meridian the great circle it draws is that meridian.
  function interpolate(from, to, direction, stream) {
    if (from == null) {
      for (var i = 0; i < 4; i++) {
        var p = boundaryPoint(direction > 0 ? i * 0.5 : 2 - i * 0.5);
        stream.point(inward(p[0]), p[1]);
      }
      return;
    }
    var s0 = boundaryParam(from[0], from[1]);
    var s1 = boundaryParam(to[0], to[1]);
    var s;
    if (direction > 0) {
      if (s1 < s0) s1 += 2;
      for (s = Math.floor(s0 * 2) / 2 + 0.5; s < s1 - 1e-12; s += 0.5) {
        var pp = boundaryPoint(s);
        stream.point(inward(pp[0]), pp[1]);
      }
    } else {
      if (s1 > s0) s1 -= 2;
      for (s = Math.ceil(s0 * 2) / 2 - 0.5; s > s1 + 1e-12; s -= 0.5) {
        var pn = boundaryPoint(s);
        stream.point(inward(pn[0]), pn[1]);
      }
    }
    stream.point(inward(to[0]), to[1]);
  }

  function compareIntersection(a, b) {
    return boundaryParam(a.x[0], a.x[1]) - boundaryParam(b.x[0], b.x[1]);
  }

  return geoClip(visible, clipLine, interpolate, boundaryPoint(0), compareIntersection);
}

function geoPolarPetalFillPreclip(n) {
  var sector = 2 * Math.PI / n, halfWidth = sector / 2;
  var lobeClips = [];
  for (var k = 0; k < n; k++) lobeClips.push(wedgeClip(k * sector, halfWidth));

  function lobeIndex(lambda) {
    return ((Math.round(lambda / sector) % n) + n) % n;
  }

  // Which lobes a ring (or standalone line) can possibly touch. Every
  // vertex's own lobe is definitely touched. Between consecutive
  // vertices, if they land in the same or an adjacent lobe (the ordinary
  // case for real coastline data - vertices close enough together that
  // the arc between them can't skip a lobe), no others can be touched
  // either: a wedge is convex, and the only way to enter and leave one is
  // through an adjacent wedge, so vertices confined to a tight,
  // step-by-1 chain of lobes cannot reach - or register at, via
  // polygonContains - any lobe outside that chain. Where consecutive
  // vertices jump by more than one lobe (the graticule's own coarse
  // major lines, or possibly very simplified polygon data), that
  // guarantee doesn't hold, so this falls back to every lobe for the
  // whole ring rather than risk missing one.
  function lobesTouchedBy(pts) {
    var touched = {}, k0 = null, fallbackAll = pts.length === 0;
    for (var i = 0; i < pts.length; i++) {
      var k = lobeIndex(pts[i][0]);
      touched[k] = true;
      if (k0 !== null && k !== k0) {
        var d = k - k0;
        if (d > n / 2) d -= n; else if (d < -n / 2) d += n;
        if (Math.abs(d) > 1) fallbackAll = true;
      }
      k0 = k;
    }
    if (fallbackAll) {
      touched = {};
      for (var j = 0; j < n; j++) touched[j] = true;
    }
    return touched;
  }

  return function(sink) {
    var subs = lobeClips.map(function(c) { return c(sink); });
    var ringPts = null;

    function flushRing() {
      var touched = lobesTouchedBy(ringPts);
      for (var k = 0; k < n; k++) {
        if (!touched[k]) continue;
        var s = subs[k];
        s.lineStart();
        for (var i = 0; i < ringPts.length; i++) s.point(ringPts[i][0], ringPts[i][1]);
        s.lineEnd();
      }
      ringPts = null;
    }

    return {
      point: function(lambda, phi) { ringPts.push([lambda, phi]); },
      lineStart: function() { ringPts = []; },
      lineEnd: function() { flushRing(); },
      polygonStart: function() { subs.forEach(function(s) { s.polygonStart(); }); },
      polygonEnd: function() { subs.forEach(function(s) { s.polygonEnd(); }); },
      sphere: function() { subs.forEach(function(s) { s.sphere && s.sphere(); }); }
    };
  };
}

// Exposed for tests: lets a single lobe's clip be exercised in isolation.
geoPolarPetalFillPreclip.wedge = wedgeClip;

export { geoPolarPetalFillPreclip };

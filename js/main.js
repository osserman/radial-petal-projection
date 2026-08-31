import * as d3 from "d3";
import * as topojson from "topojson-client";
import { geoPolarPetal } from "./geoPolarPetal.js";

(function() {
  var svg = d3.select("#svg");
  var landG = svg.append("g").attr("class", "land-g");
  var gratG = svg.append("g").attr("class", "grat-g");
  var outlineG = svg.append("g").attr("class", "outline-g");
  var centerG = svg.append("g").attr("class", "center-g");

  var projection = geoPolarPetal();
  var path = d3.geoPath(projection);
  // d3.geoGraticule()'s default minor-grid extent stops at +-80 lat, leaving
  // a gap at the true geographic poles. That's invisible when the projection
  // is centered on the pole (the gap sits exactly at our own center point),
  // but once recentered elsewhere the real pole rotates to an arbitrary spot
  // out in the middle of a lobe, and the gap shows up there as a stray ring.
  // Extending to the poles removes the gap entirely.
  var graticule = d3.geoGraticule().extent([[-180, -89.999], [180, 89.999]]);

  // Diagnostic isolation: classify each graticule line as a meridian (all
  // points share longitude) or parallel (all points share latitude), and as
  // major (d3's 4 reference meridians at multiples of 90, or the equator)
  // vs minor (everything else, the regular 10deg grid). Lets us pin down
  // exactly which category of line is responsible for any artifact.
  function classifyLine(feature) {
    var coords = feature.coordinates;
    var isMeridian = coords.every(function(p) { return Math.abs(p[0] - coords[0][0]) < 1e-6; });
    var isParallel = !isMeridian && coords.every(function(p) { return Math.abs(p[1] - coords[0][1]) < 1e-6; });
    var isMajor = isMeridian
      ? Math.abs(coords[0][0] % 90) < 1e-6
      : isParallel && Math.abs(coords[0][1]) < 1e-6;
    return { isMeridian: isMeridian, isParallel: isParallel, isMajor: isMajor };
  }

  function filteredGraticule(mode) {
    if (mode === "all") return graticule();
    var lines = graticule.lines().filter(function(f) {
      var c = classifyLine(f);
      if (mode === "minor-meridians") return c.isMeridian && !c.isMajor;
      if (mode === "minor-parallels") return c.isParallel && !c.isMajor;
      if (mode === "major") return c.isMajor;
      if (mode === "minor") return !c.isMajor;
      return true;
    });
    return { type: "MultiLineString", coordinates: lines.map(function(f) { return f.coordinates; }) };
  }

  var world = null;
  d3.json("https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json").then(function(topo) {
    world = topojson.feature(topo, topo.objects.countries);
    render();
  }).catch(function(err) {
    console.warn("Could not load world atlas (offline?)", err);
  });

  var controls = {
    lobes: document.getElementById("lobes"),
    bow: document.getElementById("bow"),
    spread: document.getElementById("spread"),
    scale: document.getElementById("scale"),
    profile: document.getElementById("profile"),
    cp1t: document.getElementById("cp1t"),
    cp1w: document.getElementById("cp1w"),
    cp2t: document.getElementById("cp2t"),
    cp2w: document.getElementById("cp2w"),
    centerLon: document.getElementById("centerLon"),
    centerLat: document.getElementById("centerLat"),
    mapRot: document.getElementById("mapRot"),
    showOutline: document.getElementById("showOutline"),
    outlineColor: document.getElementById("outlineColor"),
    showGraticule: document.getElementById("showGraticule"),
    graticuleFilter: document.getElementById("graticuleFilter"),
    showLand: document.getElementById("showLand")
  };
  var bezierControlsG = document.getElementById("bezierControls");
  var vals = {
    lobes: document.getElementById("lobesVal"),
    bow: document.getElementById("bowVal"),
    spread: document.getElementById("spreadVal"),
    scale: document.getElementById("scaleVal"),
    cp1t: document.getElementById("cp1tVal"),
    cp1w: document.getElementById("cp1wVal"),
    cp2t: document.getElementById("cp2tVal"),
    cp2w: document.getElementById("cp2wVal"),
    centerLon: document.getElementById("centerLonVal"),
    centerLat: document.getElementById("centerLatVal"),
    mapRot: document.getElementById("mapRotVal")
  };

  // A slider drag fires "input" far faster than render() can keep up with
  // (see the timing comments below) - each event queues a synchronous
  // render on top of the last, so the browser never gets a chance to paint
  // between them and the whole drag feels stuck. Coalescing to one render
  // per animation frame - reading whatever the controls' values are at the
  // time the frame actually runs, not whatever they were when each event
  // fired - caps the render rate at the screen's own refresh rate. This
  // doesn't make any single render faster; it just stops piling up renders
  // faster than they can be shown.
  var renderScheduled = false;
  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(function() {
      renderScheduled = false;
      render();
    });
  }

  ["lobes", "bow", "spread", "scale", "profile", "cp1t", "cp1w", "cp2t", "cp2w",
   "centerLon", "centerLat", "mapRot", "showOutline",
   "showGraticule", "graticuleFilter", "showLand"].forEach(function(id) {
    controls[id].addEventListener("input", scheduleRender);
  });

  // outlineColor is a pure style change on an already-drawn path - it needs
  // none of render()'s work (reprojecting the graticule, and when the world
  // map is on, re-clipping every country through the fill preclip). Routing
  // it through render() anyway made the color picker laggy: <input
  // type="color"> fires "input" continuously while dragging (not just on
  // close), and each full render() with the world map on took ~60ms, so a
  // drag could queue up dozens of 60ms re-clips of geometry the color change
  // never touches. This just restyles the existing DOM node instead.
  controls.outlineColor.addEventListener("input", function() {
    outlineG.selectAll("path").style("stroke", controls.outlineColor.value);
  });

  function size() {
    var el = document.getElementById("stage");
    return [el.clientWidth, el.clientHeight];
  }

  // Independent, projection-free computation of the petal outline in screen
  // pixels, as a sanity check that the projection math matches the intended
  // geometry: r_px = scale * PI * t, theta = lobeCenter +/- (sector/2)*w(t)*spread.
  // w(t) itself is read from projection.widthAt(t) rather than reimplemented
  // here, so it can never drift from whichever profile is actually in effect.
  // Rotation/centering only changes which geographic point sits at the
  // projection's center, not the shape of the flower on screen, so this
  // overlay doesn't need to know about centerLon/centerLat/mapRot at all.
  function analyticOutlinePath(n, spread, scale, cx, cy) {
    var sector = 2 * Math.PI / n;
    var steps = 120;
    var d = "";
    for (var k = 0; k < n; k++) {
      var lambda0 = k * sector;
      var pts = [];
      for (var i = 0; i <= steps; i++) {
        // Cosine spacing concentrates samples near t=0 and t=1, where a
        // profile like vesica piscis has a genuine sharp corner (infinite
        // slope) - even sampling would visually round that corner off.
        var t = (1 - Math.cos(Math.PI * i / steps)) / 2;
        var w = projection.widthAt(t);
        var r = scale * Math.PI * t;
        var theta = lambda0 + (sector / 2) * w * spread;
        pts.push([cx + r * Math.cos(theta), cy - r * Math.sin(theta)]);
      }
      for (var i2 = steps; i2 >= 0; i2--) {
        var t2 = (1 - Math.cos(Math.PI * i2 / steps)) / 2;
        var w2 = projection.widthAt(t2);
        var r2 = scale * Math.PI * t2;
        var theta2 = lambda0 - (sector / 2) * w2 * spread;
        pts.push([cx + r2 * Math.cos(theta2), cy - r2 * Math.sin(theta2)]);
      }
      d += "M" + pts.map(function(p) { return p[0].toFixed(2) + "," + p[1].toFixed(2); }).join("L") + "Z";
    }
    return d;
  }

  function render() {
    var n = +controls.lobes.value;
    var bow = +controls.bow.value;
    var spread = +controls.spread.value;
    var scale = +controls.scale.value;
    var profile = controls.profile.value;
    var centerLon = +controls.centerLon.value;
    var centerLat = +controls.centerLat.value;
    var mapRot = +controls.mapRot.value;
    var cp1t = +controls.cp1t.value, cp1w = +controls.cp1w.value;
    var cp2t = +controls.cp2t.value, cp2w = +controls.cp2w.value;

    vals.lobes.textContent = n;
    vals.bow.textContent = bow.toFixed(2);
    vals.spread.textContent = spread.toFixed(2);
    vals.scale.textContent = scale;
    vals.cp1t.textContent = cp1t.toFixed(2);
    vals.cp1w.textContent = cp1w.toFixed(2);
    vals.cp2t.textContent = cp2t.toFixed(2);
    vals.cp2w.textContent = cp2w.toFixed(2);
    vals.centerLon.textContent = centerLon;
    vals.centerLat.textContent = centerLat;
    vals.mapRot.textContent = mapRot;

    bezierControlsG.style.display = profile === "bezier" ? "" : "none";
    // bow is excluded for the two profiles that are specific derivations
    // rather than free shapes: it would distort vesica away from being a
    // vesica, and would destroy gore's equal-area property. See the comments
    // in geoPolarPetal.js.
    var bowApplies = profile !== "vesica" && profile !== "gore";
    controls.bow.disabled = !bowApplies;
    controls.bow.closest(".row").previousElementSibling.style.opacity = bowApplies ? 1 : 0.4;

    var wh = size();
    var cx = wh[0] / 2, cy = wh[1] / 2;

    projection.lobes(n).bow(bow).spread(spread).profile(profile).scale(scale).translate([cx, cy]);
    if (profile === "bezier") {
      projection.profilePoints([[0, 0], [cp1t, cp1w], [cp2t, cp2w], [1, 0]]);
    }
    // Standard d3 rotate convention to bring an arbitrary geographic point to
    // this projection's native center: [-lon, 90-lat]. mapRot is the third
    // (gamma) component, a plain roll around the new center once it's set.
    projection.rotate([-centerLon, 90 - centerLat, mapRot]);
    path.projection(projection);

    centerG.selectAll("circle").data([0]).join("circle")
      .attr("cx", cx).attr("cy", cy).attr("r", 2.5).attr("class", "center-point");

    if (controls.showGraticule.checked) {
      gratG.selectAll("path").data([filteredGraticule(controls.graticuleFilter.value)]).join("path")
        .attr("class", "graticule").attr("d", path);
    } else {
      gratG.selectAll("path").remove();
    }

    if (controls.showLand.checked && world) {
      // Filled polygons need real ring reconstruction, not just seam
      // splitting: a ring cut at a seam has to be closed by walking along
      // the lobe's own boundary, otherwise it auto-closes with a straight
      // chord that slices across the landmass. projection.stream() picks the
      // fill-aware preclip automatically for Polygon/MultiPolygon geometry,
      // so no manual preclip swap is needed here.
      landG.selectAll("path").data(world.features).join("path")
        .attr("class", "land").attr("d", path);
    } else {
      landG.selectAll("path").remove();
    }

    if (controls.showOutline.checked) {
      outlineG.selectAll("path").data([0]).join("path")
        .attr("class", "outline")
        .style("stroke", controls.outlineColor.value)
        .attr("d", analyticOutlinePath(n, spread, scale, cx, cy));
    } else {
      outlineG.selectAll("path").remove();
    }
  }

  window.addEventListener("resize", render);
  render();
})();

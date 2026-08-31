# Polar Petal Interrupted Map Projection — Project Handoff

## Goal

Prototype a new interrupted world map projection in D3.

The projection should be visually related to the Berghaus Star projection, but with a fundamentally different interruption geometry: the globe is divided into radial petal/gores that extend all the way from one pole to the other.

The immediate goal is a working D3 geographic projection that can render:

- a Sphere outline
- graticules
- GeoJSON countries / land
- eventually arbitrary GeoJSON through `d3.geoPath(projection)`

Visual geometry comes first. Equal-area or other formal cartographic properties can be investigated later.

Development began in a classic Observable notebook, but is being migrated to a normal codebase so the implementation and tests can be managed coherently.


## Intended visual geometry

Imagine peeling an orange by making N longitudinal cuts from the North Pole to the South Pole and flattening the resulting peel segments.

Each segment becomes a pointed oval / petal / gore:

- width = 0 at the North Pole
- width increases smoothly moving away from the pole
- reaches a maximum around the middle
- decreases smoothly
- width = 0 again at the South Pole

All petals therefore meet at the projected North Pole and also terminate at their outer South-Pole cusps.

The initial inspiration was a symmetrical vesica-piscis / pointed-oval shape, although the prototype generalized this to allow more flexible petal shapes.

A useful conceptual width function is:

    w(t) = sin(pi * t)^b

where:

- `t = 0` at the North Pole
- `t = 1` at the South Pole
- `b` controls curvature/bow


## Important desired projection property

Preserve azimuthal-equidistant-style radial distance from the center if possible.

In other words, angular distance from the chosen center point on the globe should determine radial distance from the projected center.

For the default north-polar orientation:

    r ∝ (π/2 - φ)

This is an important feature of the intended projection, although it can be reconsidered if it creates an insurmountable constraint.


## Desired eventual API

Something roughly like:

```js
const projection = geoPolarPetal()
  .lobes(12)
  .bow(1)
  .spread(1)
  .scale(250)
  .translate([400, 400]);

Eventually it would also be desirable to support arbitrary projection centers / rotation using normal D3 projection semantics.

Parameters:

lobes(n) — number of petals/gores
bow(x) — controls side curvature
spread(x) — controls angular width/spread of petals

Exact semantics can evolve.

Existing mathematical approach
Raw projection

A custom raw projection called approximately:

polarPetalRaw(lobes, bow, spread)

has been developed.

Conceptually it:

Determines which longitudinal lobe contains a point.
Computes angular distance from the pole.
Uses that distance as radial distance.
Maps longitude within its lobe into an angular displacement around the lobe center.
Modulates that displacement by a latitude-dependent width function so it goes to zero at both poles.

This part appears to work.

The resulting raw transformation produces the intended petal geometry and a plausible graticule when topology/clipping is not involved.

Most important confirmed result
The projected Sphere geometry works

A custom petalSphere(n) was created to describe the intended outline of the interrupted projection.

A diagnostic explicitly bypassed clipping and streamed that custom Sphere through the raw projection.

The resulting image was a clean eight-petal flower with:

petals meeting cleanly at the center
smooth bowed sides
correct outer endpoints
no diagonal connections between petals

THIS IS THE MOST IMPORTANT KNOWN-GOOD CHECKPOINT.

Therefore:

The basic petal transformation and custom Sphere geometry are not the primary problem.

The outstanding problem is spherical stream clipping / interruption topology.

D3 architecture investigated

Relevant packages:

d3-geo
d3-geo-projection
d3-geo-polygon

In Observable classic notebooks, d3-geo-polygon loaded successfully using Observable's package loading mechanism rather than:

import {geoClipPolygon} from "d3-geo-polygon"

which failed in the classic notebook environment.

In a normal npm project, use normal package imports as appropriate.

Berghaus

The D3 Berghaus implementation was studied because it also creates a radial interrupted projection.

Useful architectural ideas:

custom projection stream
custom Sphere
reclip
geoClipPolygon

However, Berghaus is NOT topologically identical to this projection.

Berghaus retains an uninterrupted central region and adds lobes outside it.

Our projection has interruptions extending all the way to the center/pole: every lobe begins at the same central projected point.

Generic D3 interrupted projections

D3's generic interrupted projection machinery was also studied.

This was useful because its forward projection explicitly chooses which geographic lobe a point belongs to.

However, D3's conventional interrupted projections generally use northern and southern hemilobes.

Our topology is different:

each lobe is one continuous geographic gore running North Pole → South Pole.

So blindly adapting the north/south hemilobe architecture is not appropriate.

Custom Sphere streaming

A custom projection stream was used so {type: "Sphere"} renders the flower rather than the ordinary spherical boundary.

The working architecture was approximately:

const baseStream = projection.stream;

projection.stream = function(stream) {
  const rotate = projection.rotate();

  const rotateStream =
    baseStream.call(projection, stream);

  projection.rotate([0, 0, 0]);

  const sphereStream =
    baseStream.call(projection, stream);

  projection.rotate(rotate);

  rotateStream.sphere = function() {
    d3.geoStream(sphere, sphereStream);
  };

  return rotateStream;
};

This mirrors the general technique used by D3 interrupted projections: define the Sphere in the canonical/unrotated coordinate system.

A diagnostic using this machinery with clipping disabled produced the clean flower described above.

Experiments that FAILED

These are useful evidence. Do not assume they should remain in the implementation.

1. Treating all lobes as one geoClipPolygon

An early approach constructed a geographic polygon describing all petal regions and installed:

projection.preclip(
  geoClipPolygon(...)
);

This produced partially correct petals but also diagonal connections, malformed regions, and strange graticule reconstruction.

Likely cause: the spherical topology being supplied to geoClipPolygon was not a valid/simple representation of the intended set of pole-to-pole gores.

2. Berghaus-style reclip

We tested a close analogue of D3's Berghaus reclip technique:

disable clipping
stream the custom projected Sphere
shrink projected coordinates very slightly toward the origin
call projection.invert() on those points
construct a geographic polygon
give it to geoClipPolygon

Numerically, inversion worked:

~1215 points
all finite
longitude extent approximately [-180, 180]
latitude extent approximately [-90, 88.5]

But the geographic polygon was topologically malformed.

In an equirectangular diagnostic it appeared largely as repeated vertical longitude boundaries connected in inappropriate ways.

Passing it to geoClipPolygon produced severe cross-map chords / spaghetti.

Conclusion:

Berghaus's "projected Sphere → shrink → invert → one clip polygon" technique does not directly transfer to this flower topology.

The flower outline repeatedly touches the same projected central point. After inversion this corresponds to a multiply-touching spherical boundary, not the simple geographic polygon that Berghaus's reclip machinery expects.

3. Hand-written seam splitter

We also tried a custom petalSeamPreclip(n).

Its intended job was only to split geographic line streams when they crossed the N longitudinal interruption meridians.

It attempted to borrow the great-circle/meridian intersection mathematics from D3's antimeridian clipping code rather than doing naive linear interpolation.

Result: major regression.

The graticule contained huge numbers of diagonal chords crossing petals.

Conclusion:

Do not continue from this implementation.

The custom stream splitter was not correctly satisfying D3's clipping/stream semantics. In particular, polygon/line reconstruction and D3's resampling/rotation pipeline make this more subtle than simply calling lineEnd() / lineStart() at seam crossings.

Key conceptual insight

The cartographic transformation itself is substantially easier than the clipping.

For an individual geographic point, choosing a lobe and projecting it is straightforward.

The difficult case is a geographic line or polygon that crosses one of the interruption meridians.

D3 must:

identify the exact spherical intersection with a seam
terminate the geometry on one side
restart it in the neighboring lobe
correctly reconstruct polygon rings/fills
preserve D3's normal resampling and rotation behavior
handle poles and the antimeridian robustly

The problem is therefore now primarily:

How should a set of N pole-to-pole longitudinal interruption seams be represented using D3's geographic clipping/stream architecture?

Recommended next experiment

Do NOT immediately build another full clipping architecture.

First determine whether geoClipPolygon can successfully handle ONE gore in isolation.

Construct a simple geographic polygon representing a single longitude wedge:

function singlePetalClipGeometry(k, n, epsilon = 1e-5) {
  const sector = 360 / n;

  const left =
    -180 + k * sector + epsilon;

  const right =
    -180 + (k + 1) * sector - epsilon;

  const north = 90 - epsilon;
  const south = -90 + epsilon;

  return {
    type: "Polygon",
    coordinates: [[
      [left, south],
      [right, south],
      [right, north],
      [left, north],
      [left, south]
    ]]
  };
}

Then:

Use the known-good raw petal projection.
Disable the failed global clip.
Install geoClipPolygon(singlePetalClipGeometry(k,n)).
Render a graticule.

Expected successful result:

exactly one petal containing a coherent graticule and no long diagonal chords.

This is a high-value fork in the investigation.

If one gore works

Investigate rendering/streaming the same source geometry through N independent geoClipPolygon clippers, one for each gore.

This could be very promising because:

D3 remains responsible for spherical intersections.
D3 remains responsible for polygon reconstruction.
Each clipping polygon is topologically simple.
geoClipPolygon never has to understand N regions that all touch at both poles.
The raw projection already knows how each longitude region maps into its corresponding radial petal.

Ideally this can eventually be encapsulated in the projection's stream implementation so consumers can still write:

d3.geoPath(projection)(geojson)

rather than preprocessing every GeoJSON object.

If one gore fails

Stop trying variations of geoClipPolygon.

That would suggest the issue is more fundamental to the interaction between this raw projection and D3's clipping/resampling pipeline.

At that point inspect/adapt D3's internal generic clip machinery directly, particularly:

antimeridian clipping
clip/rejoin logic
polygon reconstruction

Avoid writing a new spherical clipping implementation from scratch unless necessary.

Suggested development discipline

Because many experimental Observable cells accumulated and some depended on superseded versions of helpers, establish a clean codebase before continuing.

Keep tests/diagnostics independently runnable.

Suggested checkpoints:

1. raw-projection

Render known lon/lat points through polarPetalRaw.

Verify lobe assignment and radial distance.

2. unclipped-graticule

Useful for understanding the transformation, although geometry crossing seams will be incorrect.

3. custom-sphere

Render only {type:"Sphere"} using the custom Sphere stream.

EXPECTED: clean flower.

This is already known to work and should become a regression test.

4. single-gore-geography

Show one clipping wedge in geoEquirectangular.

Verify the geographic clip region itself.

5. single-gore-graticule

Run a graticule through one geoClipPolygon and the petal projection.

This should be the next substantive experiment.

6. all-gores-graticule

Only after #5 succeeds.

7. country outlines

Use real GeoJSON but render strokes first.

8. filled country polygons

This specifically tests polygon reconstruction.

9. Sphere + graticule + land

Final integrated projection diagnostic.

Architecture preferences

Please favor reuse of D3's existing geographic machinery over custom clipping code.

In particular:

use d3.geoProjection / geoProjectionMutator
preserve D3 streaming semantics
use geoClipPolygon where appropriate
study/reuse D3's interrupted projection and antimeridian machinery
avoid SVG clipping masks as the actual solution

SVG clipping is fine for visual debugging, but the eventual result should be a genuine geographic projection compatible with:

d3.geoPath(projection)

and arbitrary GeoJSON.

Invert

An eventual .invert() is desirable.

Point inversion appears mathematically feasible because:

projected angle identifies the petal
projected radial distance identifies angular distance from the center/pole
within-petal angular displacement can recover longitude

This has not yet been fully validated around seams/cusps.

Rotation / arbitrary center

Default center is the North Pole.

Eventually the user wants the center to be configurable to an arbitrary geographic point, ideally using normal D3 rotation/projection semantics rather than rewriting the raw projection.

Do not prioritize this until clipping works in the north-polar canonical orientation.

Formal cartographic properties

Equal-area is a future investigation, NOT an immediate requirement.

The current priority order is:

correct interruption topology
desired petal geometry
normal D3/GeoJSON behavior
configurable lobe geometry
arbitrary center
invert
investigate equal-area or other formal properties
Current best interpretation

There is no evidence yet that the desired projection is mathematically problematic.

We have already demonstrated that:

the desired petal outline can be constructed
geographic points can be transformed into the petals
radial distance can preserve azimuthal-equidistant behavior
a clean custom projected Sphere can be produced

The unsolved problem is specifically integrating this unusual pole-to-pole interruption topology with D3's spherical stream/clipping machinery.

Do not simplify the petal geometry merely to solve the clipping issue unless testing demonstrates that the geometry itself causes a fundamental problem.


One thing I would add when you initialize the project: **ask Claude Code to treat the D3 source as the reference implementation, not just D3's public API docs.** In particular, I'd have it inspect the current implementations of Berghaus, `geoInterrupt`, `geoClipAntimeridian`, `geoClipPolygon`, and the underlying clip/rejoin machinery before proposing the next architecture. That's where we started making much more progress here.

And I would probably **not copy the current Observable notebook wholesale**. The notebook contains enough superseded experiments that it could mislead the agent. I'd start a clean repo with the handoff above and then copy in only `polarPetalRaw`, `petalLobes`/`petalSphere`, and whatever minimal supporting functions produced the known-good `diagnostic_unclipped_sphere`. That clean flower is the regression test to preserve. 
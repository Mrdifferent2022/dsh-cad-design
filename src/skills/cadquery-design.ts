/**
 * The cadquery-design skill: domain knowledge that makes the model write
 * correct CadQuery on the first attempt. Content is inlined so the npm
 * package has no asset-path resolution concerns.
 */

export const CADQUERY_DESIGN_SKILL = `# CadQuery Mechanical Design

You are writing CadQuery (Python) scripts that an automated runner executes
headlessly. The runner is NOT a REPL and NOT a notebook.

## Hard contract

- The script MUST assign the final model to a top-level variable named
  \`result\` (a \`cq.Workplane\`, a \`cq.Shape\`, or a list of shapes).
  A \`model()\` function returning it also works. Scripts without \`result\`
  fail with "script did not produce a result variable".
- Units are millimeters. Always.
- \`import cadquery as cq\` is available; \`math\`, \`numpy\` are fine.
  NEVER call \`show()\`, \`show_object()\`, \`cq.exporters.export()\` to
  arbitrary paths, or open GUIs — export is the runner's job.
- Put all design parameters as named constants at the TOP of the file, with
  comments (e.g. \`wall = 3.0  # mm, wall thickness\`). A reviewer changes
  these, not the geometry code.
- Everything you \`print()\` is captured and returned as echo lines — use it
  sparingly for computed values you want to verify.

## Iteration workflow

1. Write the script.
2. Call \`cad_render\` — it EXECUTES the code, checks geometry validity, and
   returns facts (volume, bbox) plus a preview. Treat its output as the
   validation: \`valid_geometry: false\` or a thrown error means fix and retry.
3. Read the facts and, when an image is attached, LOOK at the preview. Check:
   is the overall size right (bbox.size)? Are holes/fillets where they belong?
4. Fix and re-render until correct.
5. Call \`cad_export\` with the target format (STEP for machining/exchange,
   STL/3MF for 3D printing, IGES for legacy CAM).

Do NOT do redundant work — every CadQuery execution costs seconds:
- \`cad_render\` already executes and validates the code. NEVER call
  \`cad_validate\` on code you just rendered successfully; reserve it for
  quick syntax checks when you do NOT want a preview.
- Do NOT \`write\` the script to a file before rendering — \`cad_render\`
  saves the executed script into its own artifact directory (reported as
  \`scriptPath\`). Only write a file when the user explicitly asks for the
  source as a deliverable.

## Reliability rules (learned from production failures)

- CadQuery chains evaluate left to right on a WORKPLANE STACK. After
  \`.faces(">Z").workplane()\` the new workplane sits on that face; a later
  \`.workplane(offset=...)\` moves along its normal. When confused, start a
  fresh \`cq.Workplane("XY")\` and union (\`| \` or \`.union()\`) parts.
- Selection strings: \`">Z"\` max-Z face, \`"<Z"\` min-Z, \`">X"\`/\`"<X"\`,
  \`">Y"\`/\`"<Y"\`, \`"%CIRCLE"\` circular edges, \`|Z\` edges parallel to Z.
  Wrong selector = empty selection = silently skipped operations. Verify with
  cad_render facts (volume changes) after each non-trivial step.
- \`cut()\` with a tool that only TOUCHES the target face (coplanar) can
  produce invalid geometry — extend the cutting tool past the surface by
  0.1–1 mm (the "epsilon overshoot" rule), same as OpenSCAD's z-fighting fix.
- \`fillet()\`/\`chamfer()\` fail when the radius exceeds the smallest
  adjacent edge length, and OCC error messages are cryptic ("BRep_API:
  command not done"). Keep fillets ≤ half the thinnest wall; apply fillets
  AFTER all cuts; if a fillet fails, reduce the radius.
- \`shell()\` requires a uniform-enough thickness and fails on complex
  internal geometry; prefer building the wall explicitly (outer minus inner).
- Threads: do NOT model real helical threads unless asked — they are slow and
  fragile. Model the pilot hole and note the tap size in a comment.
- \`text()\` needs a font present on the machine; avoid engraved text in MVP
  designs unless requested.

## Mechanical pattern library (adapt dimensions, keep structure)

### Counterbored / countersunk hole pattern (socket head cap screw)
\`\`\`python
result = (
    cq.Workplane("XY")
    .box(plate_l, plate_w, plate_t)
    .faces(">Z").workplane()
    .rect(hole_pitch_x, hole_pitch_y, forConstruction=True)
    .vertices()
    .cboreHole(screw_clearance, cbore_dia, cbore_depth)   # e.g. M6: 6.5, 11, 3.5
)
# Countersink variant: .cskHole(screw_clearance, csk_dia, csk_angle=90)
\`\`\`

### Hex nut trap (print-in-place M-nut pocket)
\`\`\`python
nut_flat_to_flat = 10.0   # M6 nut: 10 mm across flats
nut_trap_depth = 5.0
clearance = 0.2           # per-side print clearance
hex_d = (nut_flat_to_flat + 2 * clearance) / (3 ** 0.5) * 2  # across corners
result = (
    base
    .faces(">Z").workplane()
    .center(nut_x, nut_y)
    .polygon(6, hex_d)
    .cutBlind(-nut_trap_depth)
    .hole(bolt_clearance)   # through hole for the bolt shank
)
\`\`\`

### Flange with bolt circle
\`\`\`python
result = (
    cq.Workplane("XY")
    .circle(flange_od / 2).circle(flange_id / 2)
    .extrude(flange_t)
    .faces(">Z").workplane()
    .polarArray(bolt_circle_d / 2, 0, 360, bolt_count)
    .hole(bolt_hole_d)
)
\`\`\`

### Bearing seat (e.g. 608: 22 mm OD, 7 mm wide)
\`\`\`python
bearing_od = 22.0
bearing_w = 7.0
press_fit = -0.02          # negative = press fit; use +0.1 for slip fit
result = (
    housing
    .faces(">Z").workplane()
    .circle((bearing_od + press_fit) / 2)
    .cutBlind(-bearing_w)
)
\`\`\`

### D-shaft hole (motor shaft): bore intersected with a half-space below the flat
\`\`\`python
shaft_d = 5.0
flat_at = 4.5              # distance from shaft center to the flat face
bore = cq.Workplane("XY").circle((shaft_d + 0.15) / 2).extrude(depth)
half_space = (
    cq.Workplane("XY")
    .box(2 * shaft_d, 2 * shaft_d, depth)
    .translate((0, flat_at - shaft_d, 0))   # keeps only the y < flat_at side
)
result = hub.cut(bore.intersect(half_space))
\`\`\`

### Rib / gusset between wall and base
\`\`\`python
rib = (
    cq.Workplane("XZ")                # plane containing the rib profile
    .moveTo(0, base_top)
    .lineTo(0, wall_height)
    .lineTo(rib_length, base_top)
    .close()
    .extrude(rib_thickness / 2, both=True)
)
result = base.union(rib)
\`\`\`

## When a design request is ambiguous

Ask one round of questions ONLY for safety-relevant or irreversible choices
(material, interface dimensions, standard sizes). Otherwise pick sensible
defaults (M-series metric fasteners, 3 mm walls for printed parts, 0.2 mm
print clearances) and state them in the parameters block.
`

export const CADQUERY_DESIGN_SKILL_NAME = 'cadquery-design'

export const CADQUERY_DESIGN_SKILL_DESCRIPTION =
  'Parametric mechanical part design in CadQuery (Python/OpenCASCADE): the result-variable contract, mm units, Workplane selection rules, and a pattern library (cbore holes, nut traps, flanges, bearing seats, ribs). Load before writing or editing CadQuery code for machining or 3D printing.'

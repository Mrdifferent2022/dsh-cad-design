/**
 * The ezdxf-drafting skill: domain knowledge that makes the model write
 * correct ezdxf 2D drawings on the first attempt. Content is inlined so the
 * npm package has no asset-path resolution concerns.
 */

export const EZDXF_DRAFTING_SKILL_NAME = 'ezdxf-drafting'

export const EZDXF_DRAFTING_SKILL_DESCRIPTION =
  'Write ezdxf Python scripts for 2D engineering drawings (DXF): the result-variable contract, layer/linetype conventions, CJK-safe text, dimension patterns, and the reliability pitfalls the runner auto-repairs. Load before any DXF drafting task.'

export const EZDXF_DRAFTING_SKILL = `# ezdxf 2D Engineering Drafting

You are writing ezdxf (Python) scripts that an automated runner executes
headlessly to produce DXF drawings. The runner is NOT a REPL and NOT a CAD GUI.

## Hard contract

- The script MUST assign the drawing to a top-level variable named
  \`result\` — either an \`ezdxf.document.Drawing\` (\`result = ezdxf.new()\`)
  or a layout (\`result = doc.modelspace()\`). Scripts without \`result\`
  fail with "script did not produce a result variable".
- Units are millimeters. Always.
- \`import ezdxf\` is available; \`math\`, \`numpy\` are fine.
  NEVER call \`doc.saveas()\`, \`ezdxf.recover\`, or the drawing add-on
  yourself — saving and preview rendering are the runner's job.
- A drawing with 0 entities in the layout is REFUSED (it is always a bug).
- Everything you \`print()\` is captured and returned as echo lines.

## Iteration workflow

1. Write the script.
2. Call \`cad_render\` — it EXECUTES the code, renders a preview, and returns
   facts (\`entities\`, \`layers\`, \`texts_fixed\`). Treat its output as the
   validation; do NOT follow it with \`cad_validate\` on the same code.
3. LOOK at the preview when an image is attached: are views complete, text
   legible, dimensions placed sensibly?
4. Fix and re-render until correct.
5. Call \`cad_export\` with format \`dxf\`.

Do NOT write the script to a file before rendering — pass the code directly.

## Layers and linetypes

Set up named layers instead of drawing everything on layer 0:

\`\`\`python
import ezdxf

result = doc = ezdxf.new("R2010", setup=True)  # setup=True loads standard linetypes
msp = doc.modelspace()

doc.layers.add("OUTLINE", color=7)             # continuous, default (white/black)
doc.layers.add("CENTER", color=1, linetype="CENTER")   # red centerlines
doc.layers.add("DIM", color=3)                 # green dimensions
doc.layers.add("TEXT", color=7)

msp.add_circle((0, 0), 40, dxfattribs={"layer": "OUTLINE"})
msp.add_line((-50, 0), (50, 0), dxfattribs={"layer": "CENTER"})
\`\`\`

## Text — including Chinese (CJK) annotations

- Add a STYLE with a real TTF font for any non-ASCII text; SHX fonts have no
  CJK glyphs and CAD software substitutes unpredictably:

\`\`\`python
doc.styles.add("CN", font="simsun.ttc")   # or "simhei.ttf", "msyh.ttc"
msp.add_text("技术要求", height=5, dxfattribs={"style": "CN", "layer": "TEXT"})
\`\`\`

- ALWAYS place aligned text with \`set_placement()\`, never by setting
  \`dxf.halign\`/\`dxf.valign\` alone — the DXF spec then requires an
  align_point, and the runner auto-repairs it (\`texts_fixed\` in facts tells
  you it happened; fix your code when you see it):

\`\`\`python
from ezdxf.enums import TextEntityAlignment
t = msp.add_text("Ø40 H7", height=3.5, dxfattribs={"style": "CN", "layer": "DIM"})
t.set_placement((20, 55), align=TextEntityAlignment.MIDDLE_CENTER)
\`\`\`

- The preview renderer remaps CJK-less fonts to an installed Chinese system
  font automatically, so previews stay readable — but write correct styles
  anyway; the saved DXF keeps YOUR styles.

## Dimensions

Use the dimension entities, not hand-drawn arrows:

\`\`\`python
dim = msp.add_linear_dim(
    base=(0, -55), p1=(-40, 0), p2=(40, 0),
    dimstyle="EZDXF", dxfattribs={"layer": "DIM"},
)
dim.render()   # REQUIRED — builds the anonymous block with arrows/text
\`\`\`

- \`dim.render()\` is mandatory, otherwise the dimension is an invisible
  placeholder.
- For diameter/radius callouts: \`msp.add_diameter_dim()\` /
  \`msp.add_radius_dim()\`, then \`.render()\`.

## Pitfalls (learned from production failures)

- Empty modelspace → refused. Draw into \`msp\` (or return a layout with
  content as \`result\`).
- Aligned TEXT without \`set_placement()\` → auto-repaired; see above.
- CJK text on SHX styles → tofu in CAD; use a TTF STYLE as above.
- ACI 7 / ByLayer-white geometry is fine: previews render it black on white
  automatically. Never hardcode white expecting a dark background.
- Keep everything on named layers — downstream CAM/laser software filters by
  layer.
`

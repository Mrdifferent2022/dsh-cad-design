# -*- coding: utf-8 -*-
"""
ezdxf job runner for the dsh-cad-design plugin.

The Node side spawns this script as:

    python ezdxf_runner.py --job <job.json>

where the job file is a JSON object:

    {
      "mode": "validate" | "render" | "export",
      "script_path": "...",          # ezdxf Python script; must assign a
                                     # top-level `result` (ezdxf Drawing or a
                                     # modelspace/paperspace layout)
      "output_path": "...",          # export mode: .dxf target path
      "svg_out": "...",              # render mode: vector preview path
      "png_out": "..."               # render mode: raster preview path
    }

Contract with the caller (same protocol as cadquery_runner.py):
  - Print NOTHING to real stdout except the single final JSON line. Anything
    the user script prints is captured and returned in the `echo` field.
  - Domain failures (bad script, no `result`, empty drawing) are reported as
    {"success": false, ...} — in validate mode they also carry valid:false.
  - Exit code 3 means ezdxf itself is not importable.

Battle-tested DXF repairs ported from production use:
  1. TEXT entities with non-LEFT alignment but no align_point (group 11/21)
     get align_point = insert — the DXF spec requires it, the render pipeline
     crashes without it, and CAD software misplaces the text.
  2. For preview only, styles lacking CJK glyphs are remapped to an installed
     CJK system font, so Chinese annotations render instead of tofu boxes.
     The saved DXF is never modified by this remap.
  3. Previews use BackgroundPolicy.WHITE so default-colored entities (ACI 7 /
     ByLayer white) resolve to black on the white preview card.
"""
import sys
import os
import io
import json
import contextlib
import traceback
import warnings as py_warnings


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def resolve_doc_and_layout(result):
    """Normalize `result` into (doc, layout). Raises on anything else."""
    import ezdxf  # noqa: F401
    from ezdxf.document import Drawing
    from ezdxf.layouts import BaseLayout

    if isinstance(result, Drawing):
        return result, result.modelspace()
    if isinstance(result, BaseLayout):
        return result.doc, result
    raise RuntimeError(
        "script did not produce a `result` variable holding an ezdxf Drawing "
        "or layout. Define `result = ezdxf.new()` (a Drawing) or "
        "`result = doc.modelspace()` at the top level."
    )


def fix_aligned_text_missing_align_point(doc):
    """LLM scripts often set dxf.halign/valign directly instead of calling
    set_placement() — per the DXF spec, non-LEFT aligned TEXT must carry an
    align_point (group codes 11/21); without it the render pipeline crashes
    on len(None) and CAD software misplaces the text. Patch align_point from
    insert, return the repair count."""
    from ezdxf.entities import Text
    from ezdxf.enums import TextEntityAlignment

    fixed = 0
    for space in list(doc.layouts) + list(doc.blocks):
        for e in space:
            if (
                isinstance(e, Text)
                and e.dxf.hasattr("insert")
                and e.get_align_enum() != TextEntityAlignment.LEFT
                and e.dxf.align_point is None
            ):
                e.dxf.align_point = e.dxf.insert
                fixed += 1
    return fixed


def count_entities(layout):
    try:
        return len(layout)
    except Exception:
        return sum(1 for _ in layout)


def layer_names(doc):
    try:
        return sorted(layer.dxf.name for layer in doc.layers)
    except Exception:
        return []


def _doc_has_cjk_text(doc):
    """Whether TEXT/MTEXT/ATTRIB/ATTDEF (incl. INSERT attributes) contain CJK."""
    targets = ("TEXT", "MTEXT", "ATTRIB", "ATTDEF")
    for space in list(doc.layouts) + list(doc.blocks):
        for e in space:
            t = e.dxftype()
            texts = []
            if t in targets:
                texts.append(getattr(e.dxf, "text", "") or "")
            elif t == "INSERT":
                texts.extend((a.dxf.text or "") for a in e.attribs)
            if any(ord(ch) >= 0x2E80 for s in texts for ch in s):
                return True
    return False


def _has_cjk_glyphs(font_file_name):
    """A font counts as CJK-capable only if the file really exists in a system
    font directory and its cmap contains '中'. find_font_file_name resolves
    names without checking the disk; TTC collections need fontNumber=0."""
    import platform
    from ezdxf.fonts import font_manager as fm

    dirs = [os.path.expanduser(d) for d in fm.FONT_DIRECTORIES.get(platform.system(), [])]
    for d in dirs:
        p = os.path.join(d, font_file_name)
        if os.path.isfile(p):
            try:
                t = fm.TTFont(p, fontNumber=0)
                ok = ord("中") in (t.getBestCmap() or {})
                t.close()
                return ok
            except Exception:
                return False
    return False


def _remap_styles_for_cjk(doc):
    """Preview-only font remap: styles without CJK glyphs are redirected to an
    installed CJK system font, otherwise Chinese text renders as tofu boxes.
    Only the in-memory doc is changed (the DXF on disk is never rewritten).
    Pure-Latin drawings keep their styles — remapping changes the look, so it
    is skipped unless CJK text is actually present."""
    from ezdxf.fonts import fonts as _fonts

    if not _doc_has_cjk_text(doc):
        return
    chosen = None
    for name in ("msyh.ttc", "simhei.ttf", "simsun.ttc", "NotoSansCJK-Regular.ttc"):
        if _has_cjk_glyphs(name):
            chosen = name
            break
    if not chosen:
        return
    for style in doc.styles:
        f = (style.dxf.font or "").strip()
        if not f:
            style.dxf.font = chosen
            continue
        resolved = None
        try:
            resolved = str(_fonts.find_font_file_name(_fonts.get_font_face(f)))
        except Exception:
            pass
        rbase = os.path.basename(resolved).lower() if resolved else None
        if rbase and rbase == f.lower() and _has_cjk_glyphs(rbase):
            continue
        style.dxf.font = chosen


def render_previews(doc, layout, svg_out, png_out):
    """Vector + raster preview via ezdxf's matplotlib drawing add-on.

    matplotlib ships self-contained wheels on every platform, so this path
    has no native-DLL problems. One figure serves both outputs.
    """
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from ezdxf.addons.drawing import RenderContext, Frontend
    from ezdxf.addons.drawing.matplotlib import MatplotlibBackend
    from ezdxf.addons.drawing.config import BackgroundPolicy, Configuration

    fig = plt.figure()
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_axis_off()
    _remap_styles_for_cjk(doc)
    ctx = RenderContext(doc)
    backend = MatplotlibBackend(ax)
    # The preview card is white, while DXF's default color (ACI 7 / ByLayer
    # white) resolves as white under "dark CAD background" semantics and would
    # vanish. BackgroundPolicy.WHITE resolves ACI 7 to black; colored entities
    # (red annotations, green centerlines) stay untouched. COLOR_SWAP_BW would
    # swap the just-resolved black back to white — do not use it.
    config = Configuration(background_policy=BackgroundPolicy.WHITE)
    Frontend(ctx, backend, config=config).draw_layout(layout, finalize=True)

    produced = []
    if svg_out:
        fig.savefig(svg_out, format="svg", facecolor="white")
        if os.path.isfile(svg_out) and os.path.getsize(svg_out) > 0:
            produced.append("svg")
    if png_out:
        fig.savefig(png_out, dpi=200, facecolor="white")
        if os.path.isfile(png_out) and os.path.getsize(png_out) > 0:
            produced.append("png")
    plt.close(fig)
    if not produced:
        raise RuntimeError("preview render produced no output")
    return produced


def export_dxf(doc, output_path):
    ext = os.path.splitext(output_path)[1].lower()
    if ext != ".dxf":
        raise RuntimeError(f"ezdxf export only writes .dxf, got: {ext or '(none)'}")
    doc.saveas(output_path)
    if not os.path.isfile(output_path) or os.path.getsize(output_path) == 0:
        raise RuntimeError("export produced no output")


def run_job(job):
    mode = job.get("mode")
    script_path = job.get("script_path")
    if mode not in ("validate", "render", "export"):
        return {"success": False, "error": f"unknown mode: {mode}"}
    if not script_path or not os.path.isfile(script_path):
        return {"success": False, "error": f"script not found: {script_path}"}

    try:
        import ezdxf  # noqa: F401
    except Exception as e:
        return {"success": False, "error": f"ezdxf not installed: {e}", "exit": 3}

    with open(script_path, "r", encoding="utf-8") as fh:
        code = fh.read()

    # Execute the user script in an isolated namespace; capture anything it
    # prints so real stdout stays reserved for the single result line.
    echo_buffer = io.StringIO()
    warn_buffer = []
    ns = {"__name__": "__main__", "__file__": script_path}
    try:
        with contextlib.redirect_stdout(echo_buffer), contextlib.redirect_stderr(echo_buffer):
            with py_warnings.catch_warnings(record=True) as caught:
                py_warnings.simplefilter("always")
                exec(compile(code, script_path, "exec"), ns)
                for w in caught:
                    warn_buffer.append(f"{w.category.__name__}: {w.message}")
    except Exception:  # noqa: BLE001
        out = {
            "success": False,
            "error": "script execution failed",
            "traceback": traceback.format_exc(),
        }
        if mode == "validate":
            out["valid"] = False
        return out

    result = ns.get("result", None)
    if result is None:
        out = {
            "success": False,
            "error": "script did not produce a `result` variable holding an ezdxf "
                     "Drawing or layout. Define `result = ezdxf.new()` at the top level.",
        }
        if mode == "validate":
            out["valid"] = False
        return out

    try:
        doc, layout = resolve_doc_and_layout(result)
    except Exception as e:  # noqa: BLE001
        out = {"success": False, "error": str(e)}
        if mode == "validate":
            out["valid"] = False
        return out

    # Repair before anything downstream: the missing align_point crashes the
    # render pipeline and produces non-conformant DXF on save alike.
    texts_fixed = fix_aligned_text_missing_align_point(doc)

    entity_count = count_entities(layout)
    facts = {"entities": entity_count, "layers": layer_names(doc)}
    if texts_fixed:
        facts["texts_fixed"] = texts_fixed

    echo = [line for line in echo_buffer.getvalue().splitlines() if line.strip()]
    base = {"success": True, "facts": facts, "echo": echo, "warnings": warn_buffer}

    # An empty drawing is almost certainly a bug in the generated code.
    if entity_count == 0:
        if mode == "validate":
            base["valid"] = False
            base["warnings"] = warn_buffer + [
                "drawing has 0 entities — add geometry (lines, circles, polylines, ...) to the layout"
            ]
            return base
        return {"success": False, "error": "drawing has 0 entities — refusing to emit an empty DXF"}

    if mode == "validate":
        base["valid"] = True
        return base

    # Ensure output directories exist.
    for key in ("output_path", "svg_out", "png_out"):
        path = job.get(key)
        if path:
            out_dir = os.path.dirname(os.path.abspath(path))
            if out_dir and not os.path.isdir(out_dir):
                os.makedirs(out_dir, exist_ok=True)

    if mode == "export":
        output_path = job.get("output_path")
        if not output_path:
            return {"success": False, "error": "missing output_path for export mode"}
        try:
            export_dxf(doc, output_path)
        except Exception as e:  # noqa: BLE001
            return {"success": False, "error": f"export failed: {e}"}
        base["output_path"] = output_path
        base["bytes"] = os.path.getsize(output_path)
        return base

    # render mode
    svg_out = job.get("svg_out")
    png_out = job.get("png_out")
    try:
        produced = render_previews(doc, layout, svg_out, png_out)
    except Exception as e:  # noqa: BLE001
        return {"success": False, "error": f"preview render failed: {e}"}
    if svg_out and "svg" in produced:
        base["svg"] = svg_out
    if png_out and "png" in produced:
        base["png"] = png_out
    return base


def main():
    args = sys.argv[1:]
    if "--job" not in args:
        emit({"success": False, "error": "missing --job <job.json>"})
        return 2
    i = args.index("--job")
    if i + 1 >= len(args):
        emit({"success": False, "error": "missing --job <job.json>"})
        return 2
    job_path = args[i + 1]
    try:
        with open(job_path, "r", encoding="utf-8") as fh:
            job = json.load(fh)
    except Exception as e:
        emit({"success": False, "error": f"cannot read job file: {e}"})
        return 2

    out = run_job(job)
    exit_code = out.pop("exit", None)
    emit(out)
    if exit_code is not None:
        return exit_code
    return 0 if out.get("success") else 1


if __name__ == "__main__":
    sys.exit(main())

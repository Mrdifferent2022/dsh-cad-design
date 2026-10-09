# -*- coding: utf-8 -*-
"""
CadQuery job runner for the dsh-cad plugin.

The Node side spawns this script as:

    python cadquery_runner.py --job <job.json>

where the job file is a JSON object:

    {
      "mode": "validate" | "render" | "export",
      "script_path": "...",          # CadQuery Python script; must assign
                                     # a top-level `result` (Workplane / Shape /
                                     # list of shapes) or define `model()`
      "output_path": "...",          # export mode: .step/.stp/.stl/.3mf/.iges/.igs
      "svg_out": "...",              # render mode: vector preview path
      "png_out": "..."               # render mode: raster preview path (best effort,
                                     # requires the optional cairosvg package)
    }

Contract with the caller:
  - Print NOTHING to real stdout except the single final JSON line. Anything
    the user script prints is captured and returned in the `echo` field.
  - Domain failures (bad script, no `result`, export failure) are reported as
    {"success": false, "error": ...} with exit code 1 — the caller does not
    treat a non-zero exit as an infrastructure failure by itself.
  - Exit code 3 means CadQuery itself is not importable.
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


def collect_shapes(result):
    """Normalize the user's `result` into a flat list of cadquery Shape objects."""
    shapes = []
    if result is None:
        return shapes

    # Unwrap common containers.
    if isinstance(result, (list, tuple)):
        for item in result:
            shapes.extend(collect_shapes(item))
        return shapes

    # A Workplane: iterate its values.
    if hasattr(result, "val"):
        try:
            val = result.val()
            if isinstance(val, (list, tuple)):
                shapes.extend(collect_shapes(val))
            elif val is not None:
                shapes.append(val)
                return shapes
        except Exception:
            pass
        # Fallback: iterate solids().
        try:
            for s in result.solids().vals():
                shapes.append(s)
            if shapes:
                return shapes
        except Exception:
            pass
        return shapes

    # A bare Shape.
    if hasattr(result, "exportStep") or hasattr(result, "exportBrep"):
        shapes.append(result)

    return shapes


def compute_facts(shapes):
    """Geometry facts for text-only self-checks (units: mm, mm^2, mm^3)."""
    facts = {"solids": len(shapes)}
    if not shapes:
        return facts
    try:
        total_volume = 0.0
        total_area = 0.0
        xmin = ymin = zmin = float("inf")
        xmax = ymax = zmax = float("-inf")
        all_valid = True
        for shape in shapes:
            try:
                total_volume += float(shape.Volume())
                total_area += float(shape.Area())
            except Exception:
                pass
            try:
                bb = shape.BoundingBox()
                xmin = min(xmin, bb.xmin)
                ymin = min(ymin, bb.ymin)
                zmin = min(zmin, bb.zmin)
                xmax = max(xmax, bb.xmax)
                ymax = max(ymax, bb.ymax)
                zmax = max(zmax, bb.zmax)
            except Exception:
                pass
            try:
                if hasattr(shape, "isValid") and not shape.isValid():
                    all_valid = False
            except Exception:
                pass
        facts["volume_mm3"] = round(total_volume, 3)
        facts["area_mm2"] = round(total_area, 3)
        if xmin != float("inf"):
            facts["bbox_mm"] = {
                "x": [round(xmin, 3), round(xmax, 3)],
                "y": [round(ymin, 3), round(ymax, 3)],
                "z": [round(zmin, 3), round(zmax, 3)],
                "size": [round(xmax - xmin, 3), round(ymax - ymin, 3), round(zmax - zmin, 3)],
            }
        facts["valid_geometry"] = all_valid
    except Exception:
        pass
    return facts


def export_shapes(shapes, output_path):
    """Export shapes to STEP/IGES/STL/3MF based on the file extension."""
    import cadquery as cq

    ext = os.path.splitext(output_path)[1].lower()
    if len(shapes) == 1:
        target = shapes[0]
    else:
        target = cq.Compound.makeCompound(shapes)

    if ext in (".step", ".stp"):
        target.exportStep(output_path)
    elif ext in (".iges", ".igs"):
        cq.exporters.export(cq.Workplane(obj=target), output_path)
    elif ext == ".stl":
        cq.exporters.export(cq.Workplane(obj=target), output_path)
    elif ext == ".3mf":
        cq.exporters.export(cq.Workplane(obj=target), output_path)
    else:
        raise RuntimeError(f"unsupported export format: {ext or '(none)'}")
    if not os.path.isfile(output_path) or os.path.getsize(output_path) == 0:
        raise RuntimeError("export produced no output")


def render_svg(result, svg_out):
    """Vector SVG preview via CadQuery's native exporter.

    We deliberately do NOT preview through STL tessellation: meshing can drop
    slender faces (e.g. bolt shanks) depending on mesh parameters, while the
    SVG projection stays faithful to the B-rep geometry.
    """
    import cadquery as cq

    cq.exporters.export(result, svg_out)
    if not os.path.isfile(svg_out) or os.path.getsize(svg_out) == 0:
        raise RuntimeError("SVG export produced no output")


def render_png_from_svg(svg_path, png_out):
    """Best-effort rasterization of the SVG preview; requires cairosvg."""
    import cairosvg  # optional dependency

    cairosvg.svg2png(url=svg_path, write_to=png_out, output_width=800, background_color="white")
    if not os.path.isfile(png_out) or os.path.getsize(png_out) == 0:
        raise RuntimeError("PNG rasterization produced no output")


def run_job(job):
    mode = job.get("mode")
    script_path = job.get("script_path")
    if mode not in ("validate", "render", "export"):
        return {"success": False, "error": f"unknown mode: {mode}"}
    if not script_path or not os.path.isfile(script_path):
        return {"success": False, "error": f"script not found: {script_path}"}

    try:
        import cadquery as cq  # noqa: F401
    except Exception as e:
        return {"success": False, "error": f"cadquery not installed: {e}", "exit": 3}

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
        result = {
            "success": False,
            "error": "script execution failed",
            "traceback": traceback.format_exc(),
        }
        if mode == "validate":
            result["valid"] = False
        return result

    result = ns.get("result", None)
    if result is None and "model" in ns and callable(ns["model"]):
        try:
            result = ns["model"]()
        except Exception:  # noqa: BLE001
            out = {
                "success": False,
                "error": "model() call failed",
                "traceback": traceback.format_exc(),
            }
            if mode == "validate":
                out["valid"] = False
            return out

    shapes = collect_shapes(result)
    if not shapes:
        out = {
            "success": False,
            "error": "script did not produce a `result` variable holding a cadquery "
                     "Workplane/Shape. Define `result = cq.Workplane(...)` at the top level.",
        }
        if mode == "validate":
            out["valid"] = False
        return out

    echo = [line for line in echo_buffer.getvalue().splitlines() if line.strip()]
    facts = compute_facts(shapes)
    base = {"success": True, "facts": facts, "echo": echo, "warnings": warn_buffer}

    if mode == "validate":
        base["valid"] = bool(facts.get("valid_geometry", True))
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
            export_shapes(shapes, output_path)
        except Exception as e:  # noqa: BLE001
            return {"success": False, "error": f"export failed: {e}"}
        base["output_path"] = output_path
        base["bytes"] = os.path.getsize(output_path)
        return base

    # render mode
    svg_out = job.get("svg_out")
    png_out = job.get("png_out")
    svg_ok = False
    if svg_out:
        try:
            render_svg(result, svg_out)
            svg_ok = True
            base["svg"] = svg_out
        except Exception as e:  # noqa: BLE001
            warn_buffer.append(f"SVG preview skipped: {e}")
    if png_out and svg_ok:
        try:
            render_png_from_svg(svg_out, png_out)
            base["png"] = png_out
        except Exception as e:  # noqa: BLE001
            # A missing optional cairosvg is an expected degradation, not a failure.
            warn_buffer.append(f"PNG preview skipped: {e}")
    if not svg_ok:
        return {"success": False, "error": "preview render failed", "warnings": warn_buffer}
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

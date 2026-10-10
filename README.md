# dsh-cad-design

Parametric CAD tools for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) — let your agent do mechanical design: write CadQuery code for 3D parts or ezdxf code for 2D engineering drawings, validate the geometry, render a preview, and export manufacturing files (STEP / IGES / STL / 3MF / DXF).

**English** | [中文](#中文说明)

## What it does

```
You:  "Design an M8 hex-nut retainer, 3 mm wall, and export STEP"
Agent: loads the cadquery-design skill
     → cad_validate  (code + geometry check)
     → cad_render    (preview image + volume/bbox facts)
     → iterate until the design is right
     → cad_export    → retainer.step, ready for your CAM pipeline
```

Backends are pluggable **adapters** behind a capability-routing registry: the **CadQuery** adapter (OpenCASCADE kernel, native STEP) for 3D solids and the **ezdxf** adapter for 2D DXF drawings (with battle-tested repairs for common LLM drafting defects: missing TEXT align points, CJK font fallback, white-on-white preview colors). Tools auto-detect the backend from your script's imports, or you can pin it with the `backend` parameter / `backendPriority` config. OpenSCAD and FreeCAD adapters are on the roadmap; commercial CAD bridges (SolidWorks/NX/CATIA via COM, AutoCAD/ZWCAD/GstarCAD via console/LISP) are designed-for as separate future packages — the pragmatic meaning of "compatible with CATIA/SolidWorks/NX" is exchanging **STEP/IGES/DXF** files with them, which the adapter layer already targets.

## Prerequisites

- [dsh](https://github.com/deepseek-ai/deepseek-harness) `0.x`
- Python 3.10+ with CadQuery and/or ezdxf (install whichever backend you need):

  ```sh
  pip install cadquery    # 3D solids → STEP/IGES/STL/3MF
  pip install ezdxf matplotlib   # 2D drawings → DXF + previews
  # optional, for raster PNG previews of 3D models (self-contained wheels, no native DLLs):
  pip install matplotlib
  ```

  Run `cad_doctor` after installing the plugin — it probes the machine and prints a capability matrix with install hints.

## Install

```sh
dsh plugin --profile web add dsh-cad-design
dsh web
```

`dsh plugin` requires an explicit `--profile`; target a profile that carries a surface bundle. The shipped `web` profile (base + web-app) is the usual choice — a fresh custom profile created by `dsh plugin --profile <custom> add` contains only `@deepseek-ai/dsh-base` (headless, no UI). Boot any profile as `dsh --profile <name>` with **no** surface argument; the surface comes from the profile's bundle list.

Or from a tarball: `dsh plugin --profile web add ./dsh-cad-design-0.1.0.tgz`

> **Name note:** npm also hosts [`dsh-cad`](https://www.npmjs.com/package/dsh-cad), a CAD *viewer* plugin by LAU-MARS (STL/OBJ/STEP/DXF preview cards in the Web UI). The two are complementary, not competing — `dsh-cad-design` creates and exports the models, `dsh-cad` can display them. This package was renamed to `dsh-cad-design` to keep both installable side by side.

## Tools

| Tool | Purpose |
|---|---|
| `cad_doctor` | Probe all backends; report capability matrix + install hints. |
| `cad_validate` | Execute CadQuery (3D) or ezdxf (2D) code and check validity (`valid: false` is a domain result, not a crash). Backend auto-detected from imports or pinned with `backend`. |
| `cad_render` | Produce a preview (PNG when possible, SVG always) + facts (volume/bbox for 3D; entities/layers/repairs for 2D). Attaches the image when the current model supports image input; otherwise degrades to text + facts. |
| `cad_export` | Export STEP / IGES / STL / 3MF (CadQuery) or DXF (ezdxf). Never silently overwrites (`overwrite: true` to force). |
| `cad_convert` | File→file conversion: STEP/BREP → STEP/IGES/STL/3MF (CadQuery), DXF → DXF repair-and-normalize (ezdxf tolerant read + audit + TEXT repair + rewrite). |

Plus two auto-registered skills: **`cadquery-design`** (the `result` contract, mm units, Workplane selection rules, mechanical pattern library: cbore holes, nut traps, bolt-circle flanges, bearing seats, ribs, D-shaft bores) and **`ezdxf-drafting`** (2D contract, layer/linetype conventions, CJK-safe text styles, dimension patterns, and the pitfalls the runner auto-repairs).

## Configuration

Config lives in your profile's `cordis.patch.yml` (whole-line replace semantics — provide the full `config` block):

```yaml
- insert:
    - id: cad-tools
      name: dsh-cad-design
      config:
        workDir: ''               # default: <session cwd>/.dsh/cad
        timeoutSeconds: 120
        enableSkill: true
        backendPriority:          # routing order when several backends qualify
          - cadquery
          - ezdxf
        cadquery:
          enabled: true           # master switch for this backend
          pythonPath: ''          # absolute python.exe; empty = auto-detect
        ezdxf:
          enabled: true           # 2D DXF drafting backend
          pythonPath: ''
```

Environment variable `DSH_CAD_PYTHON` also overrides the interpreter.

## Security note

`cad_*` tools execute Python code on your machine (that is how parametric CAD works). The plugin implements no policy itself — use dsh's `tools/pre-execute` hooks for allow/deny/ask rules in shared or untrusted deployments.

## Development

```sh
pnpm install
pnpm test                              # unit tests (no CadQuery needed)
DSH_CAD_PYTHON=/path/to/python pnpm run test:e2e   # real-backend tests (auto-skip otherwise)
pnpm build && pnpm pack
```

Live development against a dsh checkout:

```sh
cd /path/to/deepseek-harness
pnpm dsh web --patch /absolute/path/to/dsh-cad/cordis.dev.yml
```

## Roadmap

- **v0.2** — ✅ ezdxf adapter (2D DXF drafting with CJK font handling and TEXT repair); ✅ `cad_convert` (file→file); still to come: OpenSCAD adapter
- **v0.3** — FreeCAD adapter (GB-standard engineering drawings), DWG via ODA File Converter
- **v1.0** — richer facts (mass, inertia), larger pattern libraries, drawing templates
- **later (separate packages)** — `dsh-cad-autocad` (accoreconsole/LISP), `dsh-cad-zwcad` / `dsh-cad-gstarcad` (COM-compatible), `dsh-cad-solidworks`, `dsh-cad-nx`

## License

MIT

---

## 中文说明

让 dsh 智能体做机械设计：编写 CadQuery 参数化建模代码（3D 零件）或 ezdxf 代码（2D 工程图）→ 校验几何 → 渲染预览 → 导出制造格式（STEP/IGES/STL/3MF/DXF）。

- **安装前置**：Python 3.10+；三维装 `pip install cadquery`，二维制图装 `pip install ezdxf matplotlib`（按需二选一或都装），PNG 预览用 `pip install matplotlib`
- **安装插件**：`dsh plugin --profile web add dsh-cad-design`，然后 `dsh web` 启动。注意必须显式指定 `--profile`，且目标 profile 要带有界面 bundle——新自定义 profile 默认只含 dsh-base（无界面、静默运行）；启动用 `dsh --profile <名字>`，不要带 `web` 参数。装完先用 `cad_doctor` 做环境自检。（注意区分：npm 上另有 LAU-MARS 的 [`dsh-cad`](https://www.npmjs.com/package/dsh-cad)——CAD 查看器插件，与本包互补：本包负责建模出图，它负责在 Web 界面里看图）
- **后端架构**：adapter 注册表 + 能力路由。自带 CadQuery（OpenCASCADE 内核，原生 STEP）和 ezdxf（2D DXF，内置生产验证的修复器：TEXT 对齐点补齐、CJK 字体预览重映射、白底 ACI7 处理）；OpenSCAD、FreeCAD 在路线图上；商业 CAD（SolidWorks/NX/CATIA/AutoCAD/中望/浩辰）通过中性格式（STEP/IGES/DXF）互操作，进程内桥接预留为独立插件包
- **路由与开关**：工具按代码 import 自动识别后端（`import ezdxf` → 二维），也可用 `backend` 参数强制；`backendPriority` 控制多后端优先级；`cadquery.enabled` / `ezdxf.enabled` 可分别关闭；`pythonPath` / `DSH_CAD_PYTHON` 指定解释器
- **注意**：工具会在本机执行 Python 代码（参数化 CAD 的工作方式），共享部署请配合 dsh 的 `tools/pre-execute` 权限门禁

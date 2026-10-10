/**
 * CAD adapter abstraction.
 *
 * An adapter bridges one CAD backend (CadQuery today; OpenSCAD, ezdxf,
 * FreeCAD, or commercial CAD bridges later) into the plugin. Adapters declare
 * a capability set and tools route by capability rather than by adapter name,
 * so adding a backend never changes the tool contracts.
 *
 * The `run`/`renderPreview` methods deliberately do NOT assume "spawn a CLI
 * subprocess" — a future commercial-CAD adapter will implement the same shape
 * over COM / journal scripting / console automation.
 */

/** Neutral CAD exchange and native formats the plugin vocabulary covers. */
export type CadFormat =
  | 'step' | 'iges' | 'stl' | '3mf' | 'obj' | 'off' | 'amf'
  | 'dxf' | 'dwg' | 'brep' | 'scad' | 'fcstd'

/** File extension (without dot) → format. */
export const FORMAT_BY_EXTENSION: Readonly<Record<string, CadFormat>> = {
  step: 'step',
  stp: 'step',
  iges: 'iges',
  igs: 'iges',
  stl: 'stl',
  '3mf': '3mf',
  obj: 'obj',
  off: 'off',
  amf: 'amf',
  dxf: 'dxf',
  dwg: 'dwg',
  brep: 'brep',
  scad: 'scad',
  fcstd: 'fcstd',
}

/** What one adapter can do; tools query capabilities, never adapter identity. */
export interface CadCapabilities {
  /** Text-driven parametric modeling (agent writes code → geometry). */
  readonly parametricModeling?: {
    readonly language: 'python' | 'openscad'
    readonly headless: boolean
    /** 3D solid modeling vs 2D engineering drafting. */
    readonly dimensions?: '2d' | '3d'
  }
  /** Headless preview rendering. */
  readonly renderPreview?: {
    /** Raster preview requires optional dependencies and may degrade to vector. */
    readonly raster: boolean
  }
  /** Formats this adapter can write from a model. */
  readonly exportFormats: readonly CadFormat[]
  /** Formats this adapter can read. */
  readonly importFormats: readonly CadFormat[]
  /** Geometry facts (volume/bbox/validity) for text-only self-checks. */
  readonly analysis?: boolean
}

/** Backend probe result — the per-row output of `cad_doctor`. */
export interface AdapterStatus {
  readonly available: boolean
  /** Resolved interpreter/executable path when available. */
  readonly executablePath?: string
  readonly version?: string
  /** Human install guidance shown when unavailable. */
  readonly installHint?: string
  readonly missingReason?: string
}

/** One modeling/render/export job, normalized across adapters. */
export interface CadJob {
  readonly mode: 'validate' | 'render' | 'export'
  /** Modeling source code in the adapter's language. */
  readonly code: string
  /** export mode: absolute output path; extension selects the format. */
  readonly outputPath?: string
  /** render mode: preview paths the runner should try to produce. */
  readonly svgPath?: string
  readonly pngPath?: string
  /** Working directory for scratch files. */
  readonly workDir: string
}

/** Geometry facts for text-only model self-checks (mm units). */
export interface CadFacts {
  readonly solids?: number
  readonly volume_mm3?: number
  readonly area_mm2?: number
  readonly bbox_mm?: {
    readonly x: readonly [number, number]
    readonly y: readonly [number, number]
    readonly z: readonly [number, number]
    readonly size: readonly [number, number, number]
  }
  readonly valid_geometry?: boolean
  /** 2D drawings (DXF): entity count in the target layout. */
  readonly entities?: number
  /** 2D drawings: layer names present in the drawing. */
  readonly layers?: readonly string[]
  /** 2D drawings: aligned TEXT entities repaired before save/render. */
  readonly texts_fixed?: number
}

/** Normalized job outcome. Domain failures throw; this shape is success. */
export interface CadJobResult {
  readonly facts?: CadFacts
  /** validate mode: whether the geometry is valid. */
  readonly valid?: boolean
  /** render mode: produced preview paths (svg always attempted; png best effort). */
  readonly svgPath?: string
  readonly pngPath?: string
  /** export mode: produced file path and size. */
  readonly outputPath?: string
  readonly bytes?: number
  /** Lines the user script printed (captured, never mixed into protocol). */
  readonly echo: readonly string[]
  readonly warnings: readonly string[]
}

/** A CAD backend bridge. Implementations must never throw from `detect`. */
export interface CadAdapter {
  readonly id: string
  readonly displayName: string
  readonly capabilities: CadCapabilities
  /** Probe this machine for the backend; unavailable returns installHint. */
  detect(signal: AbortSignal): Promise<AdapterStatus>
  /** Run one modeling/validate/render/export job; honors `signal`. */
  run(job: CadJob, signal: AbortSignal): Promise<CadJobResult>
}

/** Capability query used by tools to pick an adapter. */
export type CapabilityRequest =
  | { readonly kind: 'model'; readonly backend?: string }
  | { readonly kind: 'preview'; readonly backend?: string }
  | { readonly kind: 'export'; readonly format: CadFormat; readonly backend?: string }

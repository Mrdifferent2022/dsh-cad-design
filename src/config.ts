import z from '@deepseek-ai/schemastery'

/** Plugin configuration. Every key is optional so config stays forward-compatible. */
export interface Config {
  /** Artifact base directory; empty = <session cwd>/.dsh/cad. */
  workDir?: string
  /** Subprocess timeout for validate/render/export jobs. */
  timeoutSeconds?: number
  /**
   * Backend routing order: adapter ids, earlier = preferred. Adapters not
   * listed keep their built-in order after the listed ones.
   */
  backendPriority?: string[]
  /** Register the cadquery-design skill. */
  enableSkill?: boolean
  /** CadQuery backend switch and interpreter override. */
  cadquery?: {
    /** Set false to disable this backend entirely (routing skips it). */
    enabled?: boolean
    /** Absolute python.exe path; empty = auto-detect. */
    pythonPath?: string
  }
  /** ezdxf (2D DXF drafting) backend switch and interpreter override. */
  ezdxf?: {
    /** Set false to disable this backend entirely (routing skips it). */
    enabled?: boolean
    /** Absolute python.exe path; empty = auto-detect. */
    pythonPath?: string
  }
}

/** Validate and default the plugin configuration. */
export const Config: z<Config> = z.object({
  workDir: z.string().default(''),
  timeoutSeconds: z.number().default(120),
  backendPriority: z.array(z.string()).default([]),
  enableSkill: z.boolean().default(true),
  cadquery: z.object({
    enabled: z.boolean().default(true),
    pythonPath: z.string().default(''),
  }).default({}),
  ezdxf: z.object({
    enabled: z.boolean().default(true),
    pythonPath: z.string().default(''),
  }).default({}),
})

export const DEFAULT_TIMEOUT_SECONDS = 120

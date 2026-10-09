import { readFile } from 'node:fs/promises'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  imageValueFromRef,
  isImageCapableRoute,
  prepareWorkDir,
  requireAdapter,
  type CadToolDeps,
  type ImageValue,
} from './shared.ts'
import { factsToJson } from './validate.ts'

/** Re-brand the value's plain image record for the image content block. */
function imageRefFromValue(image: ImageValue): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(image.attachmentId),
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...image.name === undefined ? {} : { name: image.name },
  }
}

/**
 * `cad_render`: execute modeling code and produce a preview plus geometry
 * facts. The preview image rides an attachment when the calling route
 * supports image input; otherwise the result degrades to text (paths +
 * facts), which still lets a text-only model self-check its design.
 */
export function applyCadRender(deps: CadToolDeps): void {
  deps.ctx.tools.register(defineTool({
    name: 'cad_render',
    description: 'Render CadQuery Python modeling code to a design preview (PNG when possible, SVG always) and geometry facts (volume, bounding box, validity). This single call both EXECUTES and VALIDATES the code — do not follow it with cad_validate on the same code. Returns the preview as an image when the current model supports image input; otherwise returns file paths and facts so you can still self-check numbers. Use this to visually check a design before calling cad_export. The script must assign the model to a top-level `result` variable.',
    parameters: {
      code: { type: 'string', required: true, description: 'CadQuery Python source. Must assign the final model to a top-level `result` variable (Workplane/Shape/list), or define `model()`.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scriptPath: { type: 'string', required: true },
          svgPath: { type: 'string' },
          pngPath: { type: 'string' },
          previewAttached: { type: 'boolean', required: true },
          facts: { type: 'object', additionalProperties: true },
          warnings: { type: 'array', items: { type: 'string' }, required: true },
          echo: { type: 'array', items: { type: 'string' }, required: true },
          image: {
            type: 'object',
            additionalProperties: false,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', const: 'image/png', required: true },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
              name: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value): ContentBlock[] => {
        const lines: string[] = []
        for (const warning of value.warnings) lines.push(`warning: ${warning}`)
        if (value.facts !== undefined) lines.push(`facts: ${JSON.stringify(value.facts)}`)
        if (value.svgPath !== undefined) lines.push(`svg preview: ${value.svgPath}`)
        if (value.image !== undefined) {
          lines.push('The rendered preview is attached as an image below — inspect it for design mistakes and iterate on the code if anything looks wrong.')
          return [
            { type: 'text', text: lines.join('\n') },
            { type: 'image', attachment: imageRefFromValue(value.image) },
          ]
        }
        if (value.pngPath !== undefined) lines.push(`png preview: ${value.pngPath}`)
        lines.push(
          value.pngPath !== undefined
            ? 'The current model does not accept image input. Self-check the geometry facts above, or view the preview files with an image-capable model via read_image.'
            : 'No raster preview was produced (install cairosvg for PNG previews). Self-check the geometry facts above; the SVG preview can be viewed in any browser.',
        )
        for (const line of value.echo) lines.push(`echo: ${line}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
      presentationMeta: (_args, value) => ({
        scriptPath: value.scriptPath,
        ...(value.svgPath !== undefined ? { svgPath: value.svgPath } : {}),
        ...(value.pngPath !== undefined ? { pngPath: value.pngPath } : {}),
      }),
    },
    // Every call renders into its own timestamped directory.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (args.code.trim() === '') throw new Error('code must be a non-empty CadQuery script')
      const adapter = await requireAdapter(deps, { kind: 'preview' }, exec.signal)
      const work = await prepareWorkDir(deps, exec, args.code)
      const result = await adapter.run({
        mode: 'render',
        code: args.code,
        workDir: work.dir,
        svgPath: work.svgPath,
        pngPath: work.pngPath,
      }, exec.signal)

      // Attach the PNG preview only when (a) the runner produced one and
      // (b) the current route can consume images. Everything else degrades
      // to text — the tool never hard-refuses on image capability.
      let image: ImageValue | undefined
      if (result.pngPath !== undefined) {
        const attachments = deps.ctx.get('attachments')
        if (attachments !== undefined && await isImageCapableRoute(deps, exec)) {
          try {
            const data = await readFile(result.pngPath)
            const ref = await attachments.saveImage({
              data: new Uint8Array(data),
              mediaType: 'image/png',
              name: 'cad-preview.png',
            })
            image = imageValueFromRef(ref)
          } catch {
            // Attachment write failures degrade to the text path, not isError.
            image = undefined
          }
        }
      }

      return {
        scriptPath: work.scriptPath,
        ...result.svgPath !== undefined ? { svgPath: result.svgPath } : {},
        ...result.pngPath !== undefined ? { pngPath: result.pngPath } : {},
        previewAttached: image !== undefined,
        ...result.facts !== undefined ? { facts: factsToJson(result.facts) } : {},
        warnings: [...result.warnings],
        echo: [...result.echo],
        ...image !== undefined ? { image } : {},
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Render CAD preview', kind: 'read' }),
  }))
}

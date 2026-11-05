import { readFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { transform } from 'lightningcss'
import type { TsdownPlugin } from 'tsdown'

/**
 * Virtual module id prefix. Stylesheets are resolved away from their real path
 * so the bundler's own CSS guard never sees a `.css` module: this plugin
 * replaces it wholesale with a side-effecting module that injects a style tag.
 */
const VIRTUAL_PREFIX = '\0dsh-css:'

/** Options for {@link dshCssModules}. */
export interface CssModulesOptions {
  /**
   * Package name stamped on the emitted `<style>` tag. Must equal the client
   * bundle id so two packages with the same-named CSS file cannot collide.
   */
  packageName: string
  /** Directory the tag id is relative to — the browser half's source root. */
  rootDir: string
}

/**
 * Compile `*.module.css` into the shape the browser loader expects, matching
 * the official client bundles: each file becomes a virtual module that injects
 * one `<style data-plugin data-plugin-css>` tag once, and default-exports the
 * scoped class map.
 *
 * The scoping algorithm is lightningcss's CSS Modules transform, so the output
 * is a plain scoped stylesheet — no runtime class-name computation.
 *
 * @param options - package name and tag-id root.
 * @returns a plugin for the client bundle config.
 */
export function dshCssModules(options: CssModulesOptions): TsdownPlugin {
  const { packageName, rootDir } = options
  return {
    name: 'dsh-css-modules',
    resolveId(source, importer) {
      if (!source.endsWith('.module.css') || importer === undefined) return null
      const file = resolve(dirname(importer), source)
      return VIRTUAL_PREFIX + Buffer.from(file, 'utf8').toString('base64url')
    },
    async load(id) {
      if (!id.startsWith(VIRTUAL_PREFIX)) return null
      const file = Buffer.from(id.slice(VIRTUAL_PREFIX.length), 'base64url').toString('utf8')
      const source = await readFile(file, 'utf8')
      const { code, exports } = transform({
        filename: file,
        code: Buffer.from(source),
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const tagId = packageName + '/' + relative(rootDir, file).split(sep).join('/')
      const classes = Object.fromEntries(
        Object.entries(exports ?? {}).map(([local, entry]) => [local, entry.name]),
      )
      return {
        code: styleModule(tagId, code.toString(), packageName, classes),
        moduleSideEffects: true,
      }
    },
  }
}

/**
 * Render the virtual module body for one compiled stylesheet.
 * @param tagId - unique id for the `<style>` tag.
 * @param css - minified, scoped stylesheet.
 * @param packageName - owner recorded on the tag.
 * @param classes - local class name to scoped class name.
 * @returns module source.
 */
function styleModule(
  tagId: string,
  css: string,
  packageName: string,
  classes: Record<string, string>,
): string {
  const key = JSON.stringify(tagId)
  return [
    'const css = ' + JSON.stringify(css) + ';',
    'const tagId = ' + key + ';',
    'if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {',
    '  const tag = document.createElement("style");',
    '  tag.dataset.plugin = ' + JSON.stringify(packageName) + ';',
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
    'export default ' + JSON.stringify(classes, null, 1).replace(/\n/g, '\n  ') + ';',
    '',
  ].join('\n')
}

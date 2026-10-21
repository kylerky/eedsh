/**
 * The `@eedsh/runtime` profile bundle plugin: mount the generated-layer
 * watcher when the profile provides a profile context and an active HMR
 * service. Everything here is plain Cordis; no Effect.
 * @module @eedsh/runtime
 */
import type { Context } from '@deepseek-ai/cordis'
import { type HmrLike, registerGeneratedLayerWatcher, type WatcherLogger } from './watcher'

/** Plugin name shown in Loader diagnostics. */
export const name = 'eedsh-runtime'

/**
 * Mount the generated-layer watcher inside the HMR service scope, only for a
 * profile boot. The effect disposes the configuration watch when the plugin
 * unloads.
 * @param ctx - the plugin's context.
 */
export function apply(ctx: Context): void {
  ctx.inject(['hmr'], (scope) => {
    const profileContext = scope.get('profileContext') as { dir: string } | undefined
    const hmr = scope.get('hmr') as HmrLike | undefined
    if (profileContext === undefined || hmr === undefined) return
    const logger: WatcherLogger = {
      info: (message) => console.info(`[eedsh] ${message}`),
      warn: (message) => console.warn(`[eedsh] ${message}`),
      error: (message) => console.error(`[eedsh] ${message}`),
    }
    scope.effect(async () => {
      const dispose = await registerGeneratedLayerWatcher({ profileContext, hmr, logger })
      return dispose ?? (() => Promise.resolve())
    }, 'eedsh.generated-layer-watcher')
  })
}

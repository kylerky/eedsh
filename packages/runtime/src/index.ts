/**
 * The `@eedsh/runtime` profile bundle plugin: record the running installation
 * anchor on every profile boot and mount the generated-layer watcher when the
 * profile provides a profile context and an active HMR service. Everything
 * here is plain Cordis; no Effect.
 * @module @eedsh/runtime
 */
import type { Context } from '@deepseek-ai/cordis'
import { activateRuntime, type RuntimeContextLike } from './startup'

/** Plugin name shown in Loader diagnostics. */
export const name = 'eedsh-runtime'

/**
 * Record the installation anchor and mount the generated-layer watcher for a
 * profile boot. The anchor write is independent of HMR and best effort; the
 * watcher still registers only inside the HMR service scope.
 * @param ctx - the plugin's context.
 */
export function apply(ctx: Context): void {
  void activateRuntime(ctx as unknown as RuntimeContextLike)
}

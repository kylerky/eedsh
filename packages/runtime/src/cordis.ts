import { defineBundlePatch } from '@eedsh/bundle'

/** The static @eedsh/runtime bundle's Loader layer, generated at build time. */
export default defineBundlePatch((patch) => {
  patch.insert({ id: '@eedsh/runtime', name: '@eedsh/runtime' })
})

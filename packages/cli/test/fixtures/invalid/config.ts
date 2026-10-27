import { bundle, defineConfig, defineProfile } from '@eedsh/config'

export default defineConfig({
  dsh: '0.2.1-rc.2',
  profiles: {
    invalid: defineProfile({
      bundles: [bundle('@eedsh/runtime')],
    }),
  },
})

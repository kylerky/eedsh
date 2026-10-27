import { bundle, defineConfig, defineProfile, generated, layer, override } from '@eedsh/config'

export default defineConfig({
  dsh: '0.2.1-rc.2',
  profiles: {
    'cli-unmatched': defineProfile({
      bundles: [bundle('@deepseek-ai/dsh-base'), generated()],
      layers: [layer('cli', [override('missing-row', { interval: 1 })])],
    }),
  },
})

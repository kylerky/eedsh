import { bundle, defineConfig, defineProfile, generated, insert, layer } from '@eedsh/config'

export default defineConfig({
  dsh: '0.2.1-rc.2',
  profiles: {
    'cli-mts': defineProfile({
      bundles: [bundle('@deepseek-ai/dsh-base'), generated()],
      layers: [layer('cli', [insert({ id: 'cli-mts-row', name: '@scope/cli-mts-row' })])],
    }),
  },
})

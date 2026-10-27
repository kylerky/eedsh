import { bundle, defineConfig, defineProfile, generated, insert, layer } from '@eedsh/config'

export default defineConfig({
  dsh: '0.2.1-rc.2',
  profiles: {
    'discovery-mts': defineProfile({
      bundles: [bundle('@deepseek-ai/dsh-base'), generated()],
      layers: [layer('cli', [insert({ id: 'discovery-mts-row', name: '@scope/discovery-mts-row' })])],
    }),
  },
})

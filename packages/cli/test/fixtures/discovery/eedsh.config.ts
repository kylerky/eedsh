import { bundle, defineConfig, defineProfile, generated, insert, layer } from '@eedsh/config'

export default defineConfig({
  dsh: '0.2.1-rc.2',
  profiles: {
    'discovery-ts': defineProfile({
      bundles: [bundle('@deepseek-ai/dsh-base'), generated()],
      layers: [layer('cli', [insert({ id: 'discovery-ts-row', name: '@scope/discovery-ts-row' })])],
    }),
  },
})

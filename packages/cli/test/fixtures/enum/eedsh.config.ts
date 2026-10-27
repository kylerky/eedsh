import { bundle, defineConfig, defineProfile, generated, insert, layer } from '@eedsh/config'

enum Mode {
  Basic = 'basic',
  Full = 'full',
}

const mode: Mode = Mode.Basic

export default defineConfig({
  dsh: '0.2.1-rc.2',
  profiles: {
    [`enum-${mode}`]: defineProfile({
      bundles: [bundle('@deepseek-ai/dsh-base'), generated()],
      layers: [layer('cli', [insert({ id: 'enum-row', name: '@scope/enum-row' })])],
    }),
  },
})

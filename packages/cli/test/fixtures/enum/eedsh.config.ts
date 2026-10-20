import { bundle, defineProfile, generated, insert, layer } from '@eedsh/config'

enum Mode {
  Basic = 'basic',
  Full = 'full',
}

const mode: Mode = Mode.Basic

export default defineProfile({
  name: `enum-${mode}`,
  dsh: '0.2.1-rc.2',
  bundles: [bundle('@deepseek-ai/dsh-base'), generated()],
  layers: [layer('cli', [insert({ id: 'enum-row', name: '@scope/enum-row' })])],
})

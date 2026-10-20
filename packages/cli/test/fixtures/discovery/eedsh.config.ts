import { bundle, defineProfile, generated, insert, layer } from '@eedsh/config'

export default defineProfile({
  name: 'discovery-ts',
  dsh: '0.2.1-rc.2',
  bundles: [bundle('@deepseek-ai/dsh-base'), generated()],
  layers: [layer('cli', [insert({ id: 'discovery-ts-row', name: '@scope/discovery-ts-row' })])],
})

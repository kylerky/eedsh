import { bundle, defineProfile, generated, insert, layer } from '@eedsh/config'

export default defineProfile({
  name: 'discovery-mts',
  dsh: '0.2.1-rc.2',
  bundles: [bundle('@deepseek-ai/dsh-base'), generated()],
  layers: [layer('cli', [insert({ id: 'discovery-mts-row', name: '@scope/discovery-mts-row' })])],
})

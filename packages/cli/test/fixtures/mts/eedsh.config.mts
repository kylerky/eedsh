import { bundle, defineProfile, generated, insert, layer } from '@eedsh/config'

export default defineProfile({
  name: 'cli-mts',
  dsh: '0.2.1-rc.2',
  bundles: [bundle('@deepseek-ai/dsh-base'), generated()],
  layers: [layer('cli', [insert({ id: 'cli-mts-row', name: '@scope/cli-mts-row' })])],
})

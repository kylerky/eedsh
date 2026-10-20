import { bundle, defineProfile, generated, layer, override } from '@eedsh/config'

export default defineProfile({
  name: 'cli-unmatched',
  dsh: '0.2.1-rc.2',
  bundles: [bundle('@deepseek-ai/dsh-base'), generated()],
  layers: [layer('cli', [override('missing-row', { interval: 1 })])],
})

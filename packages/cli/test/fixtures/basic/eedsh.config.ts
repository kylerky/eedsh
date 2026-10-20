import { bundle, defineProfile, generated, insert, layer } from '@eedsh/config'

const profileName: string = 'cli-fixture'

export default defineProfile({
  name: profileName,
  dsh: '0.2.1-rc.2',
  bundles: [bundle('@deepseek-ai/dsh-base'), generated()],
  layers: [layer('cli', [insert({ id: 'cli-row', name: '@scope/cli-row' })])],
})

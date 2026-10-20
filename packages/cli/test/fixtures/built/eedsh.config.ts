import { bundle, defineProfile, generated, insert, layer, override } from '@eedsh/config'

export default defineProfile({
  name: 'built-cli',
  dsh: '0.2.1-rc.2',
  bundles: [bundle('@deepseek-ai/dsh-base'), generated()],
  layers: [
    layer('built', [
      insert({ id: 'built-row', name: '@scope/built-row' }),
      override('agent-default-model', { marker: 'built' }),
    ]),
  ],
})

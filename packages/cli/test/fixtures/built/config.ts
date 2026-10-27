import {
  bundle,
  defineConfig,
  defineProfile,
  generated,
  insert,
  layer,
  override,
} from '@eedsh/config'

export default defineConfig({
  dsh: '0.2.1-rc.2',
  profiles: {
    'built-cli': defineProfile({
      bundles: [bundle('@deepseek-ai/dsh-base'), generated()],
      layers: [
        layer('built', [
          insert({ id: 'built-row', name: '@scope/built-row' }),
          override('agent-default-model', { marker: 'built' }),
        ]),
      ],
    }),
  },
})

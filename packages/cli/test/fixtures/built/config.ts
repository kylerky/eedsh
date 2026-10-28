import { defineConfig } from '@eedsh/config'

export default defineConfig()
  .dsh('0.2.1-rc.2')
  .profile('built-cli', (profile) => {
    profile
      .bundle('@deepseek-ai/dsh-base')
      .generated()
      .layer('built', (layer) => {
        layer
          .insert({ id: 'built-row', name: '@scope/built-row' })
          .override('agent-default-model', { marker: 'built' })
      })
  })
  .build()

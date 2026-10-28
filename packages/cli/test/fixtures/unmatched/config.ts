import { defineConfig } from '@eedsh/config'

export default defineConfig()
  .dsh('0.2.1-rc.2')
  .profile('cli-unmatched', (profile) => {
    profile
      .bundle('@deepseek-ai/dsh-base')
      .generated()
      .layer('cli', (layer) => {
        layer.override('missing-row', { interval: 1 })
      })
  })
  .build()

import { defineConfig } from '@eedsh/config'

enum Mode {
  Basic = 'basic',
  Full = 'full',
}

const mode: Mode = Mode.Basic

export default defineConfig()
  .dsh('0.2.1-rc.2')
  .profile(`enum-${mode}`, (profile) => {
    profile
      .bundle('@deepseek-ai/dsh-base')
      .generated()
      .layer('cli', (layer) => {
        layer.insert({ id: 'enum-row', name: '@scope/enum-row' })
      })
  })
  .build()

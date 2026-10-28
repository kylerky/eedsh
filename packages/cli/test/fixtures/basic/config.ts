import { defineConfig } from '@eedsh/config'

const profileName: string = 'cli-fixture'

export default defineConfig()
  .dsh('0.2.1-rc.2')
  .profile(profileName, (profile) => {
    profile
      .bundle('@deepseek-ai/dsh-base')
      .generated()
      .layer('cli', (layer) => {
        layer.insert({ id: 'cli-row', name: '@scope/cli-row' })
      })
  })
  .build()

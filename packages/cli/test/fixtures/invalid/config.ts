import { defineConfig } from '@eedsh/config'

export default defineConfig()
  .dsh('0.2.1-rc.2')
  .profile('invalid', (profile) => {
    profile.bundle('@eedsh/runtime')
  })
  .build()

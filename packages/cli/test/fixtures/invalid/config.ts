import { defineConfig } from '@eedsh/config'

export default defineConfig()
  .profile('invalid', (profile) => {
    profile.bundle('@eedsh/runtime')
  })
  .build()

const { defineConfig } = require('@eedsh/config') as typeof import('@eedsh/config')

module.exports = defineConfig()
  .dsh('0.2.1-rc.2')
  .profile('cli-cjs', (profile) => {
    profile.bundle('@deepseek-ai/dsh-base').generated().layer('cli')
  })
  .build()

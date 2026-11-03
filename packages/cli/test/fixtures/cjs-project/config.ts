const { defineConfig } = require('@eedsh/config') as typeof import('@eedsh/config')

module.exports = defineConfig()
  .profile('cli-cjs', (profile) => {
    profile.bundle('@deepseek-ai/dsh-base').generated().layer('cli')
  })
  .build()

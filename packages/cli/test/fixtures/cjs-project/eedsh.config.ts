const { bundle, defineConfig, defineProfile, generated, layer } =
  require('@eedsh/config') as typeof import('@eedsh/config')

module.exports = defineConfig({
  dsh: '0.2.1-rc.2',
  profiles: {
    'cli-cjs': defineProfile({
      bundles: [bundle('@deepseek-ai/dsh-base'), generated()],
      layers: [layer('cli', [])],
    }),
  },
})

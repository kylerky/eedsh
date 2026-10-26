const { bundle, defineProfile, generated, layer } =
  require('@eedsh/config') as typeof import('@eedsh/config')

const plan = defineProfile({
  name: 'cli-cjs',
  dsh: '0.2.1-rc.2',
  bundles: [bundle('@deepseek-ai/dsh-base'), generated()],
  layers: [layer('cli', [])],
})

module.exports = plan

import {
  bundle,
  defineProfile,
  disable,
  generated,
  insert,
  js,
  layer,
  override,
} from '@eedsh/config'

export default defineProfile({
  name: 'work',
  dsh: '0.2.1-rc.2',
  packages: { '@scope/my-plugin': 'link:../packages/my-plugin' },
  bundles: [
    bundle('@deepseek-ai/dsh-base'),
    bundle('@deepseek-ai/dsh-web-app'),
    generated(), // the generated layers sit here: after web-app, before nothing else
  ],
  layers: [
    layer('plugins', [
      insert({ id: 'my-plugin', name: '@scope/my-plugin', config: { enabled: true } }),
      disable('repeat-tool-reminder'),
    ]),
    layer('overrides', [
      // Whole-config replacement, exactly like a DSH Loader patch.
      override('agent-default-model', {
        provider: 'deepseek',
        model: 'deepseek-chat',
      }),
      insert({
        id: 'plugin-manager',
        name: '@deepseek-ai/dsh-plugin-manager',
        disabled: js("!ctx.get('profileContext')"),
      }),
    ]),
  ],
})

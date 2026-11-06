import { defineBundlePatch, group, js } from '@eedsh/bundle'

/**
 * A representative plugin bundle: ordinary rows, a group with isolate,
 * a disabled row and an expression, and an agent-preset row.
 */
export default defineBundlePatch((patch) => {
  patch
    .insert({ id: 'fixture-plugin', name: '@fixture/plugin-bundle' })
    .insert({
      id: 'fixture-tool',
      name: '@fixture/plugin-bundle/tool',
      disabled: js("process.platform === 'win32'"),
    })
    .insert(
      group('fixture-group', { name: 'cordis:group', isolate: { fixture: true } }, [
        { id: 'fixture-child', name: '@fixture/plugin-bundle/child' },
      ]),
    )
    .insert({
      id: 'fixture-preset',
      name: '@deepseek-ai/dsh-agent-preset',
      config: {
        id: 'fixture-preset',
        name: 'Fixture preset',
        plugins: [{ id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo' }],
      },
    })
    .override('fixture-plugin', { enabled: true, marker: 'fixture' })
})

import type { LayerBuilder } from '@eedsh/config'

/** A helper module that delegates a patch call outside the config file. */
export function addHelperRow(layer: LayerBuilder): void {
  layer.insert({ id: 'helper-row', name: '@scope/helper' }) // provenance-helper-insert
}

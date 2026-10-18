import { describe, expect, it } from 'vitest'

import { dropItems } from '../src/lib/media/orphans'

describe('dropItems', () => {
  it('promotes the parts of a dropped owner', () => {
    const items = [
      { id: 'icon.sbitemico', partOf: undefined },
      { id: 'icon.sbitemico/textures.bntx', partOf: 'icon.sbitemico' },
      { id: 'model.sbfres', partOf: undefined },
      { id: 'model.sbfres/textures.bntx', partOf: 'model.sbfres' },
    ]
    expect(dropItems(items, (id) => id === 'icon.sbitemico')).toEqual([
      { id: 'icon.sbitemico/textures.bntx', partOf: undefined },
      { id: 'model.sbfres', partOf: undefined },
      { id: 'model.sbfres/textures.bntx', partOf: 'model.sbfres' },
    ])
  })
})

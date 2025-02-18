import type { PeerId } from '@libp2p/interface-peer-id'
import { Buffer } from 'buffer'
import { assert } from 'aegir/chai'
import { equals as uint8ArrayEquals } from 'uint8arrays/equals'
import { KeyCache } from '../src/keycache.js'
import { createPeerIds, createPeerIdsFromFixtures } from './fixtures/peer.js'

describe('KeyCache', () => {
  let peerA: PeerId

  before(async () => {
    [peerA] = await createPeerIdsFromFixtures(2)
  })

  it('should store and load same key successfully', async () => {
    try {
      const key = Buffer.from('this is id 007')
      await KeyCache.store(peerA, key)
      const result = await KeyCache.load(peerA)
      assert(result !== null && uint8ArrayEquals(result, key), 'Stored and loaded key are not the same')
    } catch (e) {
      const err = e as Error
      assert(false, `Test failed - ${err.message}`)
    }
  })

  it('should return undefined if key not found', async () => {
    try {
      const [newPeer] = await createPeerIds(1)
      const result = await KeyCache.load(newPeer)
      assert(result === null)
    } catch (e) {
      const err = e as Error
      assert(false, `Test failed - ${err.message}`)
    }
  })
})

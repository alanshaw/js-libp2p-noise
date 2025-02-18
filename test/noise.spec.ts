import { randomBytes } from 'iso-random-stream'
import type { PeerId } from '@libp2p/interface-peer-id'
import { Buffer } from 'buffer'
import { assert, expect } from 'aegir/chai'
import { duplexPair } from 'it-pair/duplex'
import { pbStream } from 'it-pb-stream'
import { equals as uint8ArrayEquals } from 'uint8arrays/equals'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string'
import sinon from 'sinon'
import { NOISE_MSG_MAX_LENGTH_BYTES } from '../src/constants.js'
import { stablelib } from '../src/crypto/stablelib.js'
import { decode0, decode2, encode1, uint16BEDecode, uint16BEEncode } from '../src/encoder.js'
import { KeyCache } from '../src/keycache.js'
import { XX } from '../src/handshakes/xx.js'
import { XXHandshake } from '../src/handshake-xx.js'
import { Noise } from '../src/index.js'
import { createHandshakePayload, getHandshakePayload, getPayload, signPayload } from '../src/utils.js'
import { createPeerIdsFromFixtures } from './fixtures/peer.js'
import { getKeyPairFromPeerId } from './utils.js'

describe('Noise', () => {
  let remotePeer: PeerId, localPeer: PeerId
  const sandbox = sinon.createSandbox()

  before(async () => {
    [localPeer, remotePeer] = await createPeerIdsFromFixtures(2)
  })

  afterEach(function () {
    sandbox.restore()
  })

  it('should communicate through encrypted streams without noise pipes', async () => {
    try {
      const noiseInit = new Noise(undefined, undefined)
      const noiseResp = new Noise(undefined, undefined)

      const [inboundConnection, outboundConnection] = duplexPair<Uint8Array>()
      const [outbound, inbound] = await Promise.all([
        noiseInit.secureOutbound(localPeer, outboundConnection, remotePeer),
        noiseResp.secureInbound(remotePeer, inboundConnection, localPeer)
      ])
      const wrappedInbound = pbStream(inbound.conn)
      const wrappedOutbound = pbStream(outbound.conn)

      wrappedOutbound.writeLP(Buffer.from('test'))
      const response = await wrappedInbound.readLP()
      expect(uint8ArrayToString(response.slice())).equal('test')
    } catch (e) {
      const err = e as Error
      assert(false, err.message)
    }
  })

  it('should test that secureOutbound is spec compliant', async () => {
    const noiseInit = new Noise(undefined, undefined)
    const [inboundConnection, outboundConnection] = duplexPair<Uint8Array>()

    const [outbound, { wrapped, handshake }] = await Promise.all([
      noiseInit.secureOutbound(localPeer, outboundConnection, remotePeer),
      (async () => {
        const wrapped = pbStream(
          inboundConnection,
          {
            lengthEncoder: uint16BEEncode,
            lengthDecoder: uint16BEDecode,
            maxDataLength: NOISE_MSG_MAX_LENGTH_BYTES
          }
        )
        const prologue = Buffer.alloc(0)
        const staticKeys = stablelib.generateX25519KeyPair()
        const xx = new XX(stablelib)

        const payload = await getPayload(remotePeer, staticKeys.publicKey)
        const handshake = new XXHandshake(false, payload, prologue, stablelib, staticKeys, wrapped, localPeer, xx)

        let receivedMessageBuffer = decode0((await wrapped.readLP()).slice())
        // The first handshake message contains the initiator's ephemeral public key
        expect(receivedMessageBuffer.ne.length).equal(32)
        xx.recvMessage(handshake.session, receivedMessageBuffer)

        // Stage 1
        const { publicKey: libp2pPubKey } = getKeyPairFromPeerId(remotePeer)
        const signedPayload = await signPayload(remotePeer, getHandshakePayload(staticKeys.publicKey))
        const handshakePayload = await createHandshakePayload(libp2pPubKey, signedPayload)

        const messageBuffer = xx.sendMessage(handshake.session, handshakePayload)
        wrapped.writeLP(encode1(messageBuffer))

        // Stage 2 - finish handshake
        receivedMessageBuffer = decode2((await wrapped.readLP()).slice())
        xx.recvMessage(handshake.session, receivedMessageBuffer)
        return { wrapped, handshake }
      })()
    ])

    const wrappedOutbound = pbStream(outbound.conn)
    wrappedOutbound.write(uint8ArrayFromString('test'))

    // Check that noise message is prefixed with 16-bit big-endian unsigned integer
    const data = await (await wrapped.readLP()).slice()
    const { plaintext: decrypted, valid } = handshake.decrypt(data, handshake.session)
    // Decrypted data should match
    expect(uint8ArrayEquals(decrypted, uint8ArrayFromString('test'))).to.be.true()
    expect(valid).to.be.true()
  })

  it('should test large payloads', async function () {
    this.timeout(10000)
    try {
      const noiseInit = new Noise(undefined, undefined)
      const noiseResp = new Noise(undefined, undefined)

      const [inboundConnection, outboundConnection] = duplexPair<Uint8Array>()
      const [outbound, inbound] = await Promise.all([
        noiseInit.secureOutbound(localPeer, outboundConnection, remotePeer),
        noiseResp.secureInbound(remotePeer, inboundConnection, localPeer)
      ])
      const wrappedInbound = pbStream(inbound.conn)
      const wrappedOutbound = pbStream(outbound.conn)

      const largePlaintext = randomBytes(100000)
      wrappedOutbound.writeLP(Buffer.from(largePlaintext))
      const response = await wrappedInbound.read(100000)

      expect(response.length).equals(largePlaintext.length)
    } catch (e) {
      const err = e as Error
      assert(false, err.message)
    }
  })

  it.skip('should communicate through encrypted streams with noise pipes', async () => {
    try {
      const staticKeysInitiator = stablelib.generateX25519KeyPair()
      const noiseInit = new Noise(staticKeysInitiator.privateKey)
      const staticKeysResponder = stablelib.generateX25519KeyPair()
      const noiseResp = new Noise(staticKeysResponder.privateKey)

      // Prepare key cache for noise pipes
      KeyCache.store(localPeer, staticKeysInitiator.publicKey)
      KeyCache.store(remotePeer, staticKeysResponder.publicKey)

      // @ts-expect-error
      const xxSpy = sandbox.spy(noiseInit, 'performXXHandshake')
      // @ts-expect-error
      const xxFallbackSpy = sandbox.spy(noiseInit, 'performXXFallbackHandshake')

      const [inboundConnection, outboundConnection] = duplexPair<Uint8Array>()
      const [outbound, inbound] = await Promise.all([
        noiseInit.secureOutbound(localPeer, outboundConnection, remotePeer),
        noiseResp.secureInbound(remotePeer, inboundConnection, localPeer)
      ])
      const wrappedInbound = pbStream(inbound.conn)
      const wrappedOutbound = pbStream(outbound.conn)

      wrappedOutbound.writeLP(Buffer.from('test v2'))
      const response = await wrappedInbound.readLP()
      expect(uint8ArrayToString(response.slice())).equal('test v2')

      assert(xxSpy.notCalled)
      assert(xxFallbackSpy.notCalled)
    } catch (e) {
      const err = e as Error
      assert(false, err.message)
    }
  })

  it.skip('IK -> XX fallback: initiator has invalid remote static key', async () => {
    try {
      const staticKeysInitiator = stablelib.generateX25519KeyPair()
      const noiseInit = new Noise(staticKeysInitiator.privateKey)
      const noiseResp = new Noise()
      // @ts-expect-error
      const xxSpy = sandbox.spy(noiseInit, 'performXXFallbackHandshake')

      // Prepare key cache for noise pipes
      KeyCache.resetStorage()
      KeyCache.store(localPeer, staticKeysInitiator.publicKey)
      KeyCache.store(remotePeer, stablelib.generateX25519KeyPair().publicKey)

      const [inboundConnection, outboundConnection] = duplexPair<Uint8Array>()
      const [outbound, inbound] = await Promise.all([
        noiseInit.secureOutbound(localPeer, outboundConnection, remotePeer),
        noiseResp.secureInbound(remotePeer, inboundConnection, localPeer)
      ])

      const wrappedInbound = pbStream(inbound.conn)
      const wrappedOutbound = pbStream(outbound.conn)

      wrappedOutbound.writeLP(Buffer.from('test fallback'))
      const response = await wrappedInbound.readLP()
      expect(uint8ArrayToString(response.slice())).equal('test fallback')

      assert(xxSpy.calledOnce, 'XX Fallback method was never called.')
    } catch (e) {
      const err = e as Error
      assert(false, err.message)
    }
  })

  // this didn't work before but we didn't verify decryption
  it.skip('IK -> XX fallback: responder has disabled noise pipes', async () => {
    try {
      const staticKeysInitiator = stablelib.generateX25519KeyPair()
      const noiseInit = new Noise(staticKeysInitiator.privateKey)

      const staticKeysResponder = stablelib.generateX25519KeyPair()
      const noiseResp = new Noise(staticKeysResponder.privateKey, undefined)
      // @ts-expect-error
      const xxSpy = sandbox.spy(noiseInit, 'performXXFallbackHandshake')

      // Prepare key cache for noise pipes
      KeyCache.store(localPeer, staticKeysInitiator.publicKey)
      KeyCache.store(remotePeer, staticKeysResponder.publicKey)

      const [inboundConnection, outboundConnection] = duplexPair<Uint8Array>()
      const [outbound, inbound] = await Promise.all([
        noiseInit.secureOutbound(localPeer, outboundConnection, remotePeer),
        noiseResp.secureInbound(remotePeer, inboundConnection, localPeer)
      ])

      const wrappedInbound = pbStream(inbound.conn)
      const wrappedOutbound = pbStream(outbound.conn)

      wrappedOutbound.writeLP(Buffer.from('test fallback'))
      const response = await wrappedInbound.readLP()
      expect(uint8ArrayToString(response.slice())).equal('test fallback')

      assert(xxSpy.calledOnce, 'XX Fallback method was never called.')
    } catch (e) {
      const err = e as Error
      assert(false, err.message)
    }
  })

  it.skip('Initiator starts with XX (pipes disabled), responder has enabled noise pipes', async () => {
    try {
      const staticKeysInitiator = stablelib.generateX25519KeyPair()
      const noiseInit = new Noise(staticKeysInitiator.privateKey, undefined)
      const staticKeysResponder = stablelib.generateX25519KeyPair()

      const noiseResp = new Noise(staticKeysResponder.privateKey)
      // @ts-expect-error
      const xxInitSpy = sandbox.spy(noiseInit, 'performXXHandshake')
      // @ts-expect-error
      const xxRespSpy = sandbox.spy(noiseResp, 'performXXFallbackHandshake')

      // Prepare key cache for noise pipes
      KeyCache.store(localPeer, staticKeysInitiator.publicKey)

      const [inboundConnection, outboundConnection] = duplexPair<Uint8Array>()

      const [outbound, inbound] = await Promise.all([
        noiseInit.secureOutbound(localPeer, outboundConnection, remotePeer),
        noiseResp.secureInbound(remotePeer, inboundConnection, localPeer)
      ])

      const wrappedInbound = pbStream(inbound.conn)
      const wrappedOutbound = pbStream(outbound.conn)

      wrappedOutbound.writeLP(Buffer.from('test fallback'))
      const response = await wrappedInbound.readLP()
      expect(uint8ArrayToString(response.slice())).equal('test fallback')

      assert(xxInitSpy.calledOnce, 'XX method was never called.')
      assert(xxRespSpy.calledOnce, 'XX Fallback method was never called.')
    } catch (e) {
      const err = e as Error
      assert(false, err.message)
    }
  })

  it.skip('IK: responder has no remote static key', async () => {
    try {
      const staticKeysInitiator = stablelib.generateX25519KeyPair()
      const noiseInit = new Noise(staticKeysInitiator.privateKey)
      const staticKeysResponder = stablelib.generateX25519KeyPair()

      const noiseResp = new Noise(staticKeysResponder.privateKey)
      // @ts-expect-error
      const ikInitSpy = sandbox.spy(noiseInit, 'performIKHandshake')
      // @ts-expect-error
      const xxFallbackInitSpy = sandbox.spy(noiseInit, 'performXXFallbackHandshake')
      // @ts-expect-error
      const ikRespSpy = sandbox.spy(noiseResp, 'performIKHandshake')

      // Prepare key cache for noise pipes
      KeyCache.resetStorage()
      KeyCache.store(remotePeer, staticKeysResponder.publicKey)

      const [inboundConnection, outboundConnection] = duplexPair<Uint8Array>()

      const [outbound, inbound] = await Promise.all([
        noiseInit.secureOutbound(localPeer, outboundConnection, remotePeer),
        noiseResp.secureInbound(remotePeer, inboundConnection, localPeer)
      ])

      const wrappedInbound = pbStream(inbound.conn)
      const wrappedOutbound = pbStream(outbound.conn)

      wrappedOutbound.writeLP(Buffer.from('test fallback'))
      const response = await wrappedInbound.readLP()
      expect(uint8ArrayToString(response.slice())).equal('test fallback')

      assert(ikInitSpy.calledOnce, 'IK handshake was not called.')
      assert(ikRespSpy.calledOnce, 'IK handshake was not called.')
      assert(xxFallbackInitSpy.notCalled, 'XX Fallback method was called.')
    } catch (e) {
      const err = e as Error
      assert(false, err.message)
    }
  })

  it('should working without remote peer provided in incoming connection', async () => {
    try {
      const staticKeysInitiator = stablelib.generateX25519KeyPair()
      const noiseInit = new Noise(staticKeysInitiator.privateKey)
      const staticKeysResponder = stablelib.generateX25519KeyPair()
      const noiseResp = new Noise(staticKeysResponder.privateKey)

      // Prepare key cache for noise pipes
      KeyCache.store(localPeer, staticKeysInitiator.publicKey)
      KeyCache.store(remotePeer, staticKeysResponder.publicKey)

      const [inboundConnection, outboundConnection] = duplexPair<Uint8Array>()
      const [outbound, inbound] = await Promise.all([
        noiseInit.secureOutbound(localPeer, outboundConnection, remotePeer),
        noiseResp.secureInbound(remotePeer, inboundConnection)
      ])
      const wrappedInbound = pbStream(inbound.conn)
      const wrappedOutbound = pbStream(outbound.conn)

      wrappedOutbound.writeLP(Buffer.from('test v2'))
      const response = await wrappedInbound.readLP()
      expect(uint8ArrayToString(response.slice())).equal('test v2')

      if (inbound.remotePeer.publicKey == null || localPeer.publicKey == null ||
        outbound.remotePeer.publicKey == null || remotePeer.publicKey == null) {
        throw new Error('Public key missing from PeerId')
      }

      assert(uint8ArrayEquals(inbound.remotePeer.publicKey, localPeer.publicKey))
      assert(uint8ArrayEquals(outbound.remotePeer.publicKey, remotePeer.publicKey))
    } catch (e) {
      const err = e as Error
      assert(false, err.message)
    }
  })

  it('should accept and return early data from remote peer', async () => {
    try {
      const localPeerEarlyData = Buffer.from('early data')
      const staticKeysInitiator = stablelib.generateX25519KeyPair()
      const noiseInit = new Noise(staticKeysInitiator.privateKey, localPeerEarlyData)
      const staticKeysResponder = stablelib.generateX25519KeyPair()
      const noiseResp = new Noise(staticKeysResponder.privateKey)

      // Prepare key cache for noise pipes
      KeyCache.store(localPeer, staticKeysInitiator.publicKey)
      KeyCache.store(remotePeer, staticKeysResponder.publicKey)

      const [inboundConnection, outboundConnection] = duplexPair<Uint8Array>()
      const [outbound, inbound] = await Promise.all([
        noiseInit.secureOutbound(localPeer, outboundConnection, remotePeer),
        noiseResp.secureInbound(remotePeer, inboundConnection)
      ])

      assert(uint8ArrayEquals(inbound.remoteEarlyData, localPeerEarlyData))
      assert(uint8ArrayEquals(outbound.remoteEarlyData, Buffer.alloc(0)))
    } catch (e) {
      const err = e as Error
      assert(false, err.message)
    }
  })
})

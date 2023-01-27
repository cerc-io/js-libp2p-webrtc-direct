
import { peerIdFromString } from '@libp2p/peer-id'
import listenTests from './listen.js'
import complianceTests from './compliance.js'
import dialTests from './dial.js'
// @ts-expect-error no types
import wrtc from 'wrtc'
import { webRTCDirect } from '../src/index.js'

// TODO: Temporary fix per wrtc issue
// https://github.com/node-webrtc/node-webrtc/issues/636#issuecomment-774171409
process.on('beforeExit', (code) => process.exit(code))

describe('transport: with wrtc', () => {
  const peerId = peerIdFromString('QmcgpsyWgH8Y8ajJz1Cu72KnS5uo2Aa2LpzU7kinSooo2a')
  const create = async () => {
    const ws = webRTCDirect({
      wrtc,
      enableSignalling: false
    })({
      peerId
    })

    return ws
  }

  dialTests(create)
  listenTests(create)
  complianceTests(create)
})

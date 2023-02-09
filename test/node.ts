import listenTests from './listen.js'
import complianceTests from './compliance.js'
import dialTests from './dial.js'
// @ts-expect-error no types
import wrtc from 'wrtc'
import { webRTCDirect } from '../src/index.js'
import { PEER_ID, SIG_PEER_ID } from './constants.js'

// TODO: Temporary fix per wrtc issue
// https://github.com/node-webrtc/node-webrtc/issues/636#issuecomment-774171409
process.on('beforeExit', (code) => process.exit(code))

describe('transport: with wrtc', () => {
  const create = async (peerIdArg = PEER_ID) => {
    const ws = webRTCDirect({
      wrtc,
      enableSignalling: true,
      relayPeerId: SIG_PEER_ID.toString()
    })({
      peerId: peerIdArg
    })

    return ws
  }

  dialTests(create)
  listenTests(create)
  complianceTests(create)
})

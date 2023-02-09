
import listenTests from './listen.js'
import dialTests from './dial.js'
import { webRTCDirect } from '../src/index.js'
import { PEER_ID, SIG_PEER_ID } from './constants.js'

describe('browser RTC', () => {
  const create = async (peerIdArg = PEER_ID) => {
    const ws = webRTCDirect({
      enableSignalling: true,
      relayPeerId: SIG_PEER_ID.toString()
    })({
      peerId: peerIdArg
    })

    return ws
  }

  dialTests(create)
  listenTests(create)
})


import { peerIdFromString } from '@libp2p/peer-id'
import listenTests from './listen.js'
import dialTests from './dial.js'
import { webRTCDirect } from '../src/index.js'

describe('browser RTC', () => {
  const peerId = peerIdFromString('QmWeo5ZWjC7mVDNsbBub6WfcuT3MktVuKF7MMBXKrTMCsE')
  const signallingPeerId = peerIdFromString('QmcgpsyWgH8Y8ajJz1Cu72KnS5uo2Aa2LpzU7kinSooo2a')

  const create = async (peerIdArg = peerId) => {
    const ws = webRTCDirect({
      enableSignalling: true,
      relayPeerId: signallingPeerId.toString()
    })({
      peerId: peerIdArg
    })

    return ws
  }

  dialTests(create)
  listenTests(create)
})


import { peerIdFromString } from '@libp2p/peer-id'
import listenTests from './listen.js'
import dialTests from './dial.js'
import { webRTCDirect } from '../src/index.js'

describe('browser RTC', () => {
  const peerId = peerIdFromString('QmcgpsyWgH8Y8ajJz1Cu72KnS5uo2Aa2LpzU7kinSooo2a')
  const create = async () => {
    const ws = webRTCDirect()({
      peerId
    })

    return ws
  }

  dialTests(create)
  listenTests(create)
})

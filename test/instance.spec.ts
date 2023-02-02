/* eslint-env mocha */

import { expect } from 'aegir/chai'
import { peerIdFromString } from '@libp2p/peer-id'
import { webRTCDirect } from '../src/index.js'

describe('instances', () => {
  it('create', (done) => {
    const peerId = peerIdFromString('QmcgpsyWgH8Y8ajJz1Cu72KnS5uo2Aa2LpzU7kinSooo2a')
    const wdirect = webRTCDirect()({
      peerId
    })
    expect(wdirect).to.exist()
    done()
  })
})

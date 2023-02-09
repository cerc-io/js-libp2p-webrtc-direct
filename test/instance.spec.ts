/* eslint-env mocha */

import { expect } from 'aegir/chai'
import { webRTCDirect } from '../src/index.js'
import { PEER_ID } from './constants.js'

describe('instances', () => {
  it('create', (done) => {
    const wdirect = webRTCDirect()({
      peerId: PEER_ID
    })
    expect(wdirect).to.exist()
    done()
  })
})

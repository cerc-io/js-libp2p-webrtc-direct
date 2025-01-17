'use strict'

const wrtc = require('wrtc')

// TODO: Temporary fix per wrtc issue
// https://github.com/node-webrtc/node-webrtc/issues/636#issuecomment-774171409
process.on('beforeExit', (code) => process.exit(code))

const ECHO_PROTOCOL = '/echo/1.0.0'

async function before () {
  const { webRTCDirect, WebRTCDirectNodeType } = await import('./dist/src/index.js')
  const { pipe } = await import('it-pipe')
  const { mockUpgrader, mockRegistrar } = await import('@libp2p/interface-mocks')
  const { peerIdFromString } = await import('@libp2p/peer-id')
  const { REMOTE_MULTIADDR_IP4, REMOTE_MULTIADDR_IP6 } = await import('./dist/test/constants.js')

  const registrar = mockRegistrar()
  void registrar.handle(ECHO_PROTOCOL, ({ stream }) => {
    void pipe(
      stream,
      stream
    ).catch()
  })
  const upgrader = mockUpgrader({
    registrar
  })

  const peerId = peerIdFromString('QmcgpsyWgH8Y8ajJz1Cu72KnS5uo2Aa2LpzU7kinSooo2a')
  const wd = webRTCDirect({
    wrtc,
    enableSignalling: true,
    nodeType: WebRTCDirectNodeType.Relay
  })({
    peerId: peerId
  })

  const listeners = await Promise.all(
    [REMOTE_MULTIADDR_IP4, REMOTE_MULTIADDR_IP6].map(async ma => {
      const listener = wd.createListener({
        upgrader
      })
      await listener.listen(ma)

      return listener
    })
  )

  return {
    listeners
  }
}

async function after (testOptions, beforeReturn) {
  await Promise.all(
    beforeReturn.listeners.map(listener => listener.close())
  )
}

/** @type {import('aegir').PartialOptions} */
module.exports = {
  test: {
    before,
    after
  }
}

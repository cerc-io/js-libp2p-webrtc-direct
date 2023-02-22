import { logger } from '@libp2p/logger'

import { CHANNEL_CLOSED_TIMEOUT } from './constants.js'

const debugLog = logger('laconic:webrtc-direct:debug')

export function setChannelClosingInterval (channel: RTCDataChannel, channelClosedHandler: () => void): NodeJS.Timer {
  const closingInterval = setInterval(() => {
    if (channel.readyState === 'closed') {
      clearInterval(closingInterval)
      debugLog('Cleaning up closed signalling channel')
      channelClosedHandler()
    }
  }, CHANNEL_CLOSED_TIMEOUT)

  return closingInterval
}

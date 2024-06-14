import { CHAIN } from '@tonconnect/ui'
import { TonClient } from '@ton/ton'

export const useTonClient = () => {
  async function init(network: CHAIN) {
    const { getHttpEndpoint } = await import('@orbs-network/ton-access')

    const type = network === CHAIN.MAINNET ? 'mainnet' : 'testnet'

    const endpoint = await getHttpEndpoint({
      network: type,
    });

    return new TonClient({
      endpoint,
    });
  }

  return { init }
}

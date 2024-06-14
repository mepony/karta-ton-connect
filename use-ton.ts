import { TonConnectUI, type ConnectedWallet } from "@tonconnect/ui"
import { Address, type SenderArguments, toNano, beginCell } from '@ton/core'
import { JettonWallet } from './jetton-wallet'
import { JettonMaster } from '@ton/ton'
import { useTonClient } from './use-ton-client'

import { BlockchainAssets } from "~/services/api/modules/billing/types"

export interface TransactionOptions {
  amount: number;
  asset: BlockchainAssets;
  message: string;
}

const TIMEOUT = 10000;

export const USDT_MASTER_ADDRESS = Address.parse('EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs')
export const INVOICE_WALLET_ADDRESS = Address.parse('WALLET_ADDRESS_TO_COLLECT_PAYMENTS')
export const JETTON_TRANSFER_GAS_FEES = toNano('0.038') // fee overpayment is refunded by the TON blockchain protocol automatically

const calculateUsdtAmount = (usdCents: number) => BigInt(usdCents * 10000)
const GET_LIFETIME = () => Date.now() + 5 * 60 * 1000 // 5 min

let tonConnectUI: TonConnectUI | null = null

export function useTon() {
  const notifications = useNotification()

  const tonWallet = ref<null | ConnectedWallet>(null)
  const loader = useLoader()

  const unsubscribeStatusChange = ref<() => void>()
  const unsubscribeModalChange = ref<() => void>()

  const restoreConnectionTimeout = ref<any | null>(null)
  const restoreConnectionTimeout2 = ref<any | null>(null)

  function initTonConnect() {
    if (!tonConnectUI) {
      tonConnectUI = new TonConnectUI({
        manifestUrl: 'https://karta.com/tma/static-assets/tonconnect-manifest.json',
        restoreConnection: true,
        actionsConfiguration: {
          // @ts-ignore
          twaReturnUrl: 'https://t.me/kartacom_bot/app/',
        }
      })
    }

    unsubscribeStatusChange.value = tonConnectUI.onStatusChange(wallet => {
      if (!wallet) return

      tonWallet.value = wallet
    }, (error) => {
      notifications.error({ title: error.name, body: error.message })
    })

    unsubscribeModalChange.value = tonConnectUI.onModalStateChange(modalState => {
      if (modalState.status === 'closed' || modalState.status === 'opened') {
        loader.endLoading()
      }
    })
  }

  async function restoreConnection () {
    const abort = new AbortController()
    return new Promise((resolve, reject) => {
      
      restoreConnectionTimeout.value = setTimeout(() => {
        abort.abort()
        reject('restore connection timeout')
      }, TIMEOUT)
  
      return tonConnectUI?.connector.restoreConnection({ signal: abort.signal })
        .then(resolve)
        .catch(reject)
        .finally(() => {
          console.log('resolved')
          clearTimeout(restoreConnectionTimeout.value)
        })
    })
  }

  function isConnectionRestored () {
    return new Promise(async (resolve, reject) => {

      restoreConnectionTimeout2.value = setTimeout(() => {
        reject('timeout')
      }, TIMEOUT)

      const inited = await tonConnectUI?.connectionRestored;

      resolve(inited)
      clearTimeout(restoreConnectionTimeout2.value)
    })
  }

  async function connectToWallet() {
    if (!tonConnectUI) {
      console.warn('TonConnectUI is not inited')
      initTonConnect()
      return
    }

    try {
      loader.startLoading()

      console.log('restoring connection...')
      await restoreConnection()
      console.log('restored')
      const inited = await isConnectionRestored()
      console.log('connection inited')

      if (inited && tonConnectUI.connected) {
        tonWallet.value = tonConnectUI.wallet as ConnectedWallet

        loader.endLoading()
        return tonWallet.value
      }

      console.log('open modal', tonWallet.value)

      await tonConnectUI.openModal()

      loader.endLoading()
    } catch (error) {
      notifications.error({ title: 'Connect wallet error', body: error as string })
      loader.endLoading(true)
    }
  }

  async function disconnectWallet() {
    if (!tonConnectUI) return

    return tonConnectUI.disconnect()
      .then(() => {
        tonWallet.value = null
      })
  }

  async function doTransaction (params: TransactionOptions) {
    if (!tonConnectUI?.account?.address || !tonConnectUI?.connected) {
      await connectToWallet()
    }

    if (params.asset === BlockchainAssets.Usdt) {
      return sendUsdtTransaction(params)
    }

    return sendTransaction(params)
  }

  async function sendTransaction(params: TransactionOptions) {
    if (!tonConnectUI || !tonWallet.value) return

    const body = beginCell()
      .storeUint(0, 32)
      .storeStringTail(params.message)
      .endCell();

    const transaction = {
      validUntil: GET_LIFETIME(),
      messages: [
        {
          address: INVOICE_WALLET_ADDRESS.toString(),
          amount: toNano(params.amount).toString(),
          payload: body.toBoc().toString('base64'),
        },
      ],
    }

    return tonConnectUI.sendTransaction(transaction)
  }

  async function sendUsdtTransaction(params: TransactionOptions) {
    if (!tonConnectUI || !tonWallet.value) return

    const { chain, address: walletAddress } = tonWallet.value.account

    const tonClient = await useTonClient().init(chain)

    const userWalletAddress = Address.parse(walletAddress)

    const jettonMaster = tonClient.open(JettonMaster.create(USDT_MASTER_ADDRESS))
    const userUsdtAddress = await jettonMaster.getWalletAddress(userWalletAddress)

    const jettonWallet = tonClient.open(JettonWallet.createFromAddress(userUsdtAddress))

    const sender = {
      send: async (args: SenderArguments) => {
        console.log('args', args, args.to.toString())
        await tonConnectUI?.sendTransaction({
          messages: [
            {
              address: args.to.toString(),
              amount: args.value.toString(),
              payload: args.body?.toBoc()?.toString('base64'),
            },
          ],
          validUntil: GET_LIFETIME(), // 5 minutes for user to approve
        })
      },
      address: userWalletAddress,
    }

    console.log(`See transaction at https://tonviewer.com/${userUsdtAddress.toString()}`)

    return await jettonWallet.sendTransfer(sender, {
      fwdAmount: 1n,
      comment: params.message,
      jettonAmount: calculateUsdtAmount(params.amount * 100),
      toAddress: INVOICE_WALLET_ADDRESS,
      value: JETTON_TRANSFER_GAS_FEES,
    })
  }

  onUnmounted(() => {
    if (unsubscribeStatusChange.value) unsubscribeStatusChange.value()
    if (unsubscribeModalChange.value) unsubscribeModalChange.value()

    if (restoreConnectionTimeout2.value) {
      clearTimeout(restoreConnectionTimeout2.value)
    }
    if (restoreConnectionTimeout.value) {
      clearTimeout(restoreConnectionTimeout.value)
    }
  })

  return {
    tonWallet,
    loader,
    initTonConnect,
    connectToWallet,
    disconnectWallet,
    sendTransaction: doTransaction,
  }
}

import { useMutation } from '@tanstack/react-query'
import { Button, Icon } from '@unlock-protocol/ui'
import { AiOutlineAlert as AlertIcon } from 'react-icons/ai'
import { ToastHelper } from '~/components/helpers/toast.helper'
import { useWalletService } from '~/utils/withWalletService'

interface UpdateVersionFormProps {
  lockAddress: string
  network: number
  isManager: boolean
  disabled: boolean
  version: number
  isLastVersion: boolean
}

const UpgradeHooksAlert = () => {
  return (
    <div className="flex items-center gap-2 p-4 bg-yellow-100 rounded-lg">
      <div className="w-8">
        <Icon size={20} icon={AlertIcon} />
      </div>
      <span className="text-sm text-brand-dark">
        If you are using any hooks on the contract, please reach out in discord
        community before upgrading to ensure the compatibility.
      </span>
    </div>
  )
}

export const UpdateVersionForm = ({
  lockAddress,
  disabled,
  isManager,
  version,
  isLastVersion,
}: UpdateVersionFormProps) => {
  const walletService = useWalletService()
  const nextVersion = version + 1

  const upgradeLockVersion = async () => {
    return await walletService.upgradeLock({
      lockAddress,
      lockVersion: nextVersion,
    })
  }

  const upgradeLockVersionMutation = useMutation(upgradeLockVersion)

  const onUpgradeLockVersion = async () => {
    const upgradeLockVersionPromise = upgradeLockVersionMutation.mutateAsync()
    await ToastHelper.promise(upgradeLockVersionPromise, {
      success: `Lock upgraded to ${nextVersion} version.`,
      error: 'Impossible to upgrade version',
      loading: 'Upgrading lock version.',
    })
  }

  const disabledInput = disabled || upgradeLockVersionMutation.isLoading

  if (isLastVersion) return null

  return (
    <div className="flex flex-col gap-8">
      <span className="text-xl font-bold">{`Version ${nextVersion}`}</span>
      {isManager && (
        <>
          <Button
            className="w-full md:w-1/3"
            disabled={disabledInput}
            loading={upgradeLockVersionMutation.isLoading}
            onClick={() => {
              onUpgradeLockVersion()
            }}
          >
            Upgrade
          </Button>
          <UpgradeHooksAlert />
        </>
      )}
    </div>
  )
}

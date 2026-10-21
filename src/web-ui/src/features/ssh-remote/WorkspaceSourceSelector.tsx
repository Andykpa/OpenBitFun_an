import { useEffect, useId, useState, type ReactNode } from 'react';
import { OverflowText, SegmentedControl } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { usePeerDeviceModeOptional } from '@/infrastructure/peer-device/peerDeviceContextState';
import { DeviceSystemGlyph } from '@/app/components/NavPanel/components/DeviceSystemGlyph';
import { remoteConnectAPI } from '@/infrastructure/api/service-api/RemoteConnectAPI';
import { useDeviceDirectory, resolveDeviceNameFrom } from '@/infrastructure/account/deviceDirectory';
import {
  workspaceSourceCoordinates, workspaceSourceFor,
  type WorkspaceEnvironment, type WorkspaceLocation, type WorkspaceSource,
} from './workspaceSource';
import './WorkspaceSourceSelector.scss';

interface WorkspaceSourceSelectorProps {
  value: WorkspaceSource;
  onValueChange?: (source: WorkspaceSource) => void;
  disabled?: boolean;
  /** Connection-only surfaces cannot open the host's ordinary directory picker. */
  allowHostDirectory?: boolean;
  locationOptions?: ReactNode;
  environmentOptions?: ReactNode;
  locationActions?: ReactNode;
  environmentActions?: ReactNode;
  showEnvironment?: boolean;
}

export function WorkspaceSourceSelector({
  value, onValueChange, disabled, allowHostDirectory = true, locationOptions, environmentOptions, locationActions, environmentActions, showEnvironment = true,
}: WorkspaceSourceSelectorProps) {
  const { t } = useI18n('common');
  const peer = usePeerDeviceModeOptional();
  const directory = useDeviceDirectory();
  const [localDevice, setLocalDevice] = useState<{ id: string; name: string; os?: string; kind?: string }>();
  const [deviceNameFailed, setDeviceNameFailed] = useState(false);
  const locationId = useId();
  const environmentId = useId();
  const { location, environment } = workspaceSourceCoordinates(value);
  const peerActive = peer?.peerMode.active === true;
  useEffect(() => {
    if (peerActive || location !== 'current') return;
    let cancelled = false;
    setDeviceNameFailed(false);
    void remoteConnectAPI.getDeviceInfo().then(info => {
      if (!cancelled) setLocalDevice({ id: info.device_id, name: info.device_name, os: info.device_os ?? undefined, kind: info.device_kind ?? undefined });
    }).catch(() => { if (!cancelled) setDeviceNameFailed(true); });
    return () => { cancelled = true; };
  }, [peerActive, location]);
  const deviceId = peer?.peerMode.active ? peer.peerMode.deviceId : directory.localId || localDevice?.id;
  const metadata = directory.devices.find(device => device.device_id === deviceId);
  const fallbackName = peer?.peerMode.active ? peer.peerMode.deviceName : localDevice?.name || '';
  const deviceName = deviceId ? resolveDeviceNameFrom(directory.devices, deviceId, fallbackName) : fallbackName;
  const deviceKind = metadata?.device_kind ?? (peerActive ? undefined : localDevice?.kind);
  const deviceOs = metadata?.device_os ?? (peerActive ? undefined : localDevice?.os);
  return <div className="workspace-source-selector" data-openbitfun-component="ssh-remote" data-openbitfun-part="sourceSelector">
    <div className="workspace-source-selector__field" data-openbitfun-component="ssh-remote" data-openbitfun-part="sourceField">
      <div className="workspace-source-selector__heading">
      <span id={locationId} className="workspace-source-selector__label" data-openbitfun-component="ssh-remote" data-openbitfun-part="sourceLabel">{t('workspaceSource.location')}</span>
      <SegmentedControl className="workspace-source-selector__control" size="sm" distribution="content" aria-labelledby={locationId}
        value={location} disabled={disabled}
        options={[
          { value: 'current', label: t('workspaceSource.currentHost') },
          { value: 'other', label: t('workspaceSource.otherHost') },
        ]}
        onValueChange={value => {
          const next = value as WorkspaceLocation;
          const nextEnvironment = next === 'other' && environment === 'wsl' ? 'system'
            : next === 'current' && environment === 'system' && !allowHostDirectory ? 'container' : environment;
          onValueChange?.(workspaceSourceFor(next, nextEnvironment));
        }} />
      {locationActions && <div className="workspace-source-selector__actions">{locationActions}</div>}
      </div>
      {location === 'current' && <div className="workspace-source-selector__device" role="status"
        data-openbitfun-component="ssh-remote" data-openbitfun-part="sourceHint">
        {deviceName && <DeviceSystemGlyph size="sm" device={{ kind: deviceKind === 'cli' ? 'execution-host' : 'desktop', name: deviceName, os: deviceOs ?? undefined, hostKind: deviceKind === 'cli' ? 'cli' : 'desktop' }} />}
        <OverflowText>{deviceName || (deviceNameFailed ? t('workspaceSource.deviceNameUnavailable') : '')}</OverflowText>
      </div>}
      {locationOptions}
    </div>
    {showEnvironment && <div className="workspace-source-selector__field" data-openbitfun-component="ssh-remote" data-openbitfun-part="sourceField">
      <div className="workspace-source-selector__heading">
      <span id={environmentId} className="workspace-source-selector__label" data-openbitfun-component="ssh-remote" data-openbitfun-part="sourceLabel">{t('workspaceSource.environment')}</span>
      <SegmentedControl className="workspace-source-selector__control" size="sm" distribution="content" aria-labelledby={environmentId}
        value={environment} disabled={disabled}
        options={[
          { value: 'system', label: t('workspaceSource.system'), disabled: location === 'current' && !allowHostDirectory },
          { value: 'container', label: t('workspaceSource.container') },
          { value: 'wsl', label: t('workspaceSource.wsl'), disabled: location === 'other' },
        ]}
        onValueChange={value => onValueChange?.(workspaceSourceFor(location, value as WorkspaceEnvironment))} />
      {environmentActions && <div className="workspace-source-selector__actions">{environmentActions}</div>}
      </div>
      {environmentOptions}
    </div>}
  </div>;
}

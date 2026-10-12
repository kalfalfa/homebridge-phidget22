import {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { ConnectionManager, ConnectionTarget, ConnectionConfig } from './connections';
import { PhidgetChannelAccessory } from './accessories/channel';
import { PhidgetDictionaryAccessory, DictionarySubscription } from './accessories/dictionary';
import { SupportedChannelClass, SupportedService } from './mapping';
import { routePhidgetLogs, PhidgetLogLevelName } from './phidgetLog';

export interface ChannelAccessoryConfig {
  type: 'channel';
  name: string;
  connection?: string;
  channelClass: SupportedChannelClass;
  service: SupportedService;
  serialNumber?: number;
  hubPort?: number;
  channel?: number;
  isHubPortDevice?: boolean;
  deviceLabel?: string;
  sensorType?: string;
  dataInterval?: number;
  invert?: boolean;
}

export interface DictionaryAccessoryConfig {
  type: 'dictionary';
  name: string;
  connection?: string;
  dictionaryLabel?: string;
  key: string;
  service: SupportedService;
  parse?: 'number' | 'bool';
  scale?: number;
  offset?: number;
  writable?: boolean;
  writeFormat?: 'number' | 'bool';
}

export type AccessoryConfig = ChannelAccessoryConfig | DictionaryAccessoryConfig;

interface Phidget22PluginConfig extends PlatformConfig {
  connections?: ConnectionConfig[];
  accessories?: AccessoryConfig[];
  log?: {
    level?: PhidgetLogLevelName;
  };
}

export class Phidget22Platform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly connections: ConnectionManager;
  private readonly restored = new Map<string, PlatformAccessory>();
  private readonly dictionaries = new Map<string, DictionarySubscription>();

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.connections = new ConnectionManager(log);

    const cfg = this.config as Phidget22PluginConfig;
    routePhidgetLogs(log, cfg.log?.level ?? 'warning');

    this.api.on('didFinishLaunching', () => {
      void this.start();
    });
    this.api.on('shutdown', () => {
      this.connections.closeAll();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.restored.set(accessory.UUID, accessory);
  }

  private async start(): Promise<void> {
    const cfg = this.config as Phidget22PluginConfig;

    const connections = cfg.connections ?? [{ name: 'Local', type: 'local' as const }];
    for (const c of connections) {
      this.connections.add(c);
    }
    this.connections.connectAll();

    const accessories = cfg.accessories ?? [];
    const seenUUIDs = new Set<string>();

    for (const ac of accessories) {
      try {
        const uuid = this.api.hap.uuid.generate(accessoryKey(ac));
        seenUUIDs.add(uuid);
        let accessory = this.restored.get(uuid);
        if (!accessory) {
          accessory = new this.api.platformAccessory(ac.name, uuid);
          accessory.context.config = ac;
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          this.log.info(`Added accessory: ${ac.name}`);
        } else {
          accessory.context.config = ac;
          accessory.displayName = ac.name;
          this.api.updatePlatformAccessories([accessory]);
          this.log.debug(`Restored accessory: ${ac.name}`);
        }

        if (ac.type === 'channel') {
          new PhidgetChannelAccessory(this, accessory, ac);
        } else if (ac.type === 'dictionary') {
          new PhidgetDictionaryAccessory(this, accessory, ac);
        } else {
          this.log.warn(`Unknown accessory type for "${(ac as { name: string }).name}"`);
        }
      } catch (err) {
        this.log.error(`Failed to set up accessory "${ac.name}": ${(err as Error).message}`);
      }
    }

    const stale: PlatformAccessory[] = [];
    for (const [uuid, acc] of this.restored.entries()) {
      if (!seenUUIDs.has(uuid)) stale.push(acc);
    }
    if (stale.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      this.log.info(`Removed ${stale.length} stale accessory/accessories.`);
    }
  }

  getDictionary(label: string, isRemote: boolean, isLocal: boolean): DictionarySubscription {
    const cacheKey = `${label}|${isRemote ? 'R' : ''}${isLocal ? 'L' : ''}`;
    const existing = this.dictionaries.get(cacheKey);
    if (existing) return existing;
    const sub = new DictionarySubscription(label, this.log, isRemote, isLocal);
    sub.open();
    this.dictionaries.set(cacheKey, sub);
    return sub;
  }
}

function accessoryKey(ac: AccessoryConfig): string {
  if (ac.type === 'dictionary') {
    return `${PLATFORM_NAME}:dict:${ac.connection ?? 'Local'}:${ac.dictionaryLabel ?? 'sensors'}:${ac.key}`;
  }
  return [
    PLATFORM_NAME,
    'channel',
    ac.connection ?? 'Local',
    ac.channelClass,
    ac.serialNumber ?? '*',
    ac.deviceLabel ?? '*',
    ac.hubPort ?? '*',
    ac.channel ?? '*',
    ac.isHubPortDevice ? 'HP' : '',
  ].join(':');
}

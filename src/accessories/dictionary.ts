import type { PlatformAccessory, Service, Logger } from 'homebridge';
import * as phidget22 from 'phidget22';
import type { Phidget22Platform, DictionaryAccessoryConfig } from '../platform';
import { serviceTransform, SupportedService } from '../mapping';

/**
 * A Phidget Dictionary subscription shared across all dictionary accessories
 * bound to the same (connection, deviceLabel) pair. One Dictionary channel is
 * opened per label; its onAdd/onUpdate/onRemove events fan out to listeners.
 */
export class DictionarySubscription {
  private dict: phidget22.Dictionary;
  private listeners = new Map<string, Array<(value: string | null) => void>>();
  private cache = new Map<string, string>();

  constructor(
    private readonly label: string,
    private readonly log: Logger,
    private readonly isRemote: boolean,
    private readonly isLocal: boolean,
  ) {
    this.dict = new phidget22.Dictionary();
    this.dict.setDeviceLabel(label);
    if (isRemote) this.dict.setIsRemote(true);
    if (isLocal) this.dict.setIsLocal(true);

    this.dict.onAdd = (key, value) => this.deliver(key, value);
    this.dict.onUpdate = (key, value) => this.deliver(key, value);
    this.dict.onRemove = (key) => this.deliver(key, null);
  }

  async open(timeout = 5000): Promise<void> {
    await this.dict.open(timeout);
    this.log.info(`[dictionary:${this.label}] attached`);
    try {
      let cursor = '';
      for (;;) {
        const batch = await this.dict.scan(cursor || undefined);
        if (!batch || batch.length === 0) break;
        for (const key of batch) {
          const v = await this.dict.get(key);
          if (v !== null) this.deliver(key, v);
        }
        cursor = batch[batch.length - 1];
      }
    } catch (err) {
      this.log.warn(`[dictionary:${this.label}] initial scan failed: ${(err as Error).message}`);
    }
  }

  subscribe(key: string, cb: (value: string | null) => void): () => void {
    const arr = this.listeners.get(key) ?? [];
    arr.push(cb);
    this.listeners.set(key, arr);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      cb(cached);
    } else {
      this.dict.get(key).then((v) => {
        if (v !== null) {
          this.cache.set(key, v);
          cb(v);
        }
      }).catch(() => {});
    }
    return () => {
      const list = this.listeners.get(key);
      if (!list) return;
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    };
  }

  async set(key: string, value: string): Promise<void> {
    await this.dict.set(key, value);
    this.deliver(key, value);
  }

  private deliver(key: string, value: string | null): void {
    if (value === null) {
      this.cache.delete(key);
    } else {
      this.cache.set(key, value);
    }
    const list = this.listeners.get(key);
    if (!list) return;
    for (const cb of list) {
      try { cb(value); } catch { /* ignore */ }
    }
  }

  close(): void {
    try { void this.dict.close(); } catch { /* ignore */ }
  }
}

export class PhidgetDictionaryAccessory {
  private service!: Service;
  private readonly log: Logger;
  private currentValue: number = 0;
  private subscription?: DictionarySubscription;

  constructor(
    private readonly platform: Phidget22Platform,
    private readonly accessory: PlatformAccessory,
    private readonly cfg: DictionaryAccessoryConfig,
  ) {
    this.log = platform.log;

    const info = this.accessory.getService(this.platform.Service.AccessoryInformation)!;
    info
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Phidgets')
      .setCharacteristic(this.platform.Characteristic.Model, `Dictionary:${cfg.dictionaryLabel ?? 'sensors'}`)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, cfg.key);

    this.installService();
    void this.subscribe();
  }

  private installService(): void {
    const svcName = this.cfg.service as SupportedService;
    const ServiceClass = (this.platform.Service as unknown as Record<string, (typeof Service) & { UUID: string }>)[svcName];
    if (!ServiceClass) {
      this.log.error(`[${this.cfg.name}] unknown HomeKit service "${svcName}"`);
      return;
    }
    this.service =
      this.accessory.getService(ServiceClass) ??
      this.accessory.addService(ServiceClass, this.cfg.name, this.cfg.name);
    this.service.setCharacteristic(this.platform.Characteristic.Name, this.cfg.name);

    const t = serviceTransform(svcName);
    const CharClass =
      (this.platform.Characteristic as unknown as Record<string, { UUID: string }>)[t.characteristic];
    if (!CharClass) {
      this.log.error(`[${this.cfg.name}] unknown HomeKit characteristic "${t.characteristic}"`);
      return;
    }

    const char = this.service.getCharacteristic(CharClass as never);
    char.onGet(() => t.toHK(this.currentValue));

    if (t.fromHK && this.cfg.writable) {
      char.onSet(async (value) => {
        const native = t.fromHK!(value as number | boolean);
        this.currentValue = native;
        try {
          await this.subscription?.set(this.cfg.key, this.cfg.writeFormat === 'bool' ? (native ? '1' : '0') : String(native));
        } catch (err) {
          this.log.warn(`[${this.cfg.name}] dictionary write failed: ${(err as Error).message}`);
        }
      });
    }
  }

  private async subscribe(): Promise<void> {
    const label = this.cfg.dictionaryLabel ?? 'sensors';
    const connection = this.platform.connections.get(this.cfg.connection ?? 'Local');
    const isRemote = (connection?.kind ?? 'local') === 'network';
    const isLocal = (connection?.kind ?? 'local') === 'local';
    this.subscription = await this.platform.getDictionary(label, isRemote, isLocal);

    const svcName = this.cfg.service as SupportedService;
    const t = serviceTransform(svcName);
    const CharClass =
      (this.platform.Characteristic as unknown as Record<string, { UUID: string }>)[t.characteristic];

    this.subscription.subscribe(this.cfg.key, (raw) => {
      const parsed = parseValue(raw, this.cfg);
      if (parsed === null) return;
      this.currentValue = parsed;
      if (CharClass && this.service) {
        this.service.updateCharacteristic(CharClass as never, t.toHK(parsed));
      }
    });
  }
}

function parseValue(raw: string | null, cfg: DictionaryAccessoryConfig): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  if (cfg.parse === 'bool') {
    if (/^(1|true|on|yes)$/i.test(trimmed)) return 1;
    if (/^(0|false|off|no)$/i.test(trimmed)) return 0;
  }
  const n = Number(trimmed);
  if (Number.isNaN(n)) return null;
  const scaled = cfg.scale !== undefined ? n * cfg.scale : n;
  const offset = cfg.offset !== undefined ? scaled + cfg.offset : scaled;
  return offset;
}

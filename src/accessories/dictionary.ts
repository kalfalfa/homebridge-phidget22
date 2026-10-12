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
  private attached = false;
  private attachListeners: Array<(attached: boolean) => void> = [];

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
    this.dict.onAttach = () => {
      this.attached = true;
      this.log.info(`[dictionary:${this.label}] attached`);
      void this.rescan();
      // Resolve any pending gets for already-subscribed keys that were
      // registered before the dictionary attached.
      for (const key of this.listeners.keys()) {
        if (this.cache.has(key)) continue;
        this.dict.get(key).then((v) => {
          if (v !== null) this.deliver(key, v);
        }).catch(() => {});
      }
      this.fireAttach(true);
    };
    this.dict.onDetach = () => {
      this.attached = false;
      this.log.info(`[dictionary:${this.label}] detached — will reattach when the server reappears`);
      this.fireAttach(false);
    };
  }

  isAttached(): boolean {
    return this.attached;
  }

  onAttachChange(cb: (attached: boolean) => void): () => void {
    this.attachListeners.push(cb);
    return () => {
      const i = this.attachListeners.indexOf(cb);
      if (i >= 0) this.attachListeners.splice(i, 1);
    };
  }

  private fireAttach(attached: boolean): void {
    for (const cb of this.attachListeners) {
      try { cb(attached); } catch { /* ignore */ }
    }
  }

  open(): void {
    // Fire-and-forget — the Phidget library maintains the match forever and
    // onAttach fires each time the dictionary becomes available.
    this.dict.open().catch((err) => {
      this.log.warn(`[dictionary:${this.label}] open failed: ${(err as Error).message}`);
    });
  }

  private async rescan(): Promise<void> {
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
      this.log.warn(`[dictionary:${this.label}] scan failed: ${(err as Error).message}`);
    }
  }

  subscribe(key: string, cb: (value: string | null) => void): () => void {
    const arr = this.listeners.get(key) ?? [];
    arr.push(cb);
    this.listeners.set(key, arr);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      cb(cached);
    } else if (this.attached) {
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
    this.subscribe();
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
    const isWritable = !!(t.fromHK && this.cfg.writable);
    char.onGet(() => {
      // Sensor-style dictionary accessory with no attached server → unresponsive.
      // Writable accessories keep their last-known state.
      if (!this.subscription?.isAttached() && !isWritable) {
        throw new this.platform.api.hap.HapStatusError(
          this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
        );
      }
      return t.toHK(this.currentValue);
    });

    if (isWritable) {
      char.onSet(async (value) => {
        if (!this.subscription?.isAttached()) {
          throw new this.platform.api.hap.HapStatusError(
            this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
          );
        }
        const native = t.fromHK!(value as number | boolean);
        this.currentValue = native;
        try {
          await this.subscription.set(this.cfg.key, this.cfg.writeFormat === 'bool' ? (native ? '1' : '0') : String(native));
        } catch (err) {
          this.log.warn(`[${this.cfg.name}] dictionary write failed: ${(err as Error).message}`);
          throw new this.platform.api.hap.HapStatusError(
            this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
          );
        }
      });
    }
  }

  private subscribe(): void {
    const label = this.cfg.dictionaryLabel ?? 'sensors';
    const connection = this.platform.connections.get(this.cfg.connection ?? 'Local');
    const isRemote = (connection?.kind ?? 'local') === 'network';
    const isLocal = (connection?.kind ?? 'local') === 'local';
    this.subscription = this.platform.getDictionary(label, isRemote, isLocal);

    const svcName = this.cfg.service as SupportedService;
    const t = serviceTransform(svcName);
    const CharClass =
      (this.platform.Characteristic as unknown as Record<string, { UUID: string }>)[t.characteristic];
    const isWritable = !!(t.fromHK && this.cfg.writable);

    this.subscription.subscribe(this.cfg.key, (raw) => {
      const parsed = parseValue(raw, this.cfg);
      if (parsed === null) return;
      this.currentValue = parsed;
      if (CharClass && this.service) {
        this.service.updateCharacteristic(CharClass as never, t.toHK(parsed));
      }
    });

    this.subscription.onAttachChange((attached) => {
      if (!CharClass || !this.service) return;
      if (!attached && !isWritable) {
        this.service.getCharacteristic(CharClass as never).updateValue(
          new this.platform.api.hap.HapStatusError(
            this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
          ),
        );
      } else if (attached) {
        this.service.updateCharacteristic(CharClass as never, t.toHK(this.currentValue));
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

import type {
  PlatformAccessory,
  Service,
  Logger,
  CharacteristicValue,
} from 'homebridge';

import type { Phidget22Platform } from '../platform';
import type { ChannelAccessoryConfig } from '../platform';
import {
  buildChannel,
  applyPostAttach,
  serviceTransform,
  ChannelHandle,
  SupportedService,
} from '../mapping';

export class PhidgetChannelAccessory {
  private service!: Service;
  private handle?: ChannelHandle;
  private readonly log: Logger;
  private currentValue: number = 0;

  constructor(
    private readonly platform: Phidget22Platform,
    private readonly accessory: PlatformAccessory,
    private readonly cfg: ChannelAccessoryConfig,
  ) {
    this.log = platform.log;

    const info = this.accessory.getService(this.platform.Service.AccessoryInformation)!;
    info
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Phidgets')
      .setCharacteristic(this.platform.Characteristic.Model, cfg.channelClass)
      .setCharacteristic(
        this.platform.Characteristic.SerialNumber,
        cfg.serialNumber !== undefined ? String(cfg.serialNumber) : (cfg.name ?? 'unknown'),
      );

    this.installService();
    void this.openChannel();
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

    if (t.fromHK) {
      char.onSet(async (value: CharacteristicValue) => {
        const native = t.fromHK!(value as number | boolean);
        this.currentValue = native;
        try {
          await this.handle?.write?.(native);
        } catch (err) {
          this.log.warn(`[${this.cfg.name}] write failed: ${(err as Error).message}`);
        }
      });
    }
  }

  private async openChannel(): Promise<void> {
    try {
      const connection = this.platform.connections.get(this.cfg.connection ?? 'Local');
      const isRemote = (connection?.kind ?? 'local') === 'network';
      const isLocal = (connection?.kind ?? 'local') === 'local';

      this.handle = buildChannel(this.cfg.channelClass, {
        address: {
          serialNumber: this.cfg.serialNumber,
          hubPort: this.cfg.hubPort,
          channel: this.cfg.channel,
          isHubPortDevice: this.cfg.isHubPortDevice,
          deviceLabel: this.cfg.deviceLabel,
          isRemote,
          isLocal,
        },
        sensorType: this.cfg.sensorType,
        dataInterval: this.cfg.dataInterval,
        invert: this.cfg.invert,
      });

      const svcName = this.cfg.service as SupportedService;
      const t = serviceTransform(svcName);
      const CharClass =
        (this.platform.Characteristic as unknown as Record<string, { UUID: string }>)[t.characteristic];

      this.handle.onValue((v) => {
        this.currentValue = v;
        if (CharClass && this.service) {
          this.service.updateCharacteristic(CharClass as never, t.toHK(v));
        }
      });

      await this.handle.channel.open(this.cfg.openTimeout ?? 5000);
      await applyPostAttach(this.cfg.channelClass, this.handle, {
        address: {},
        sensorType: this.cfg.sensorType,
        dataInterval: this.cfg.dataInterval,
      });

      try {
        this.currentValue = this.handle.read();
        if (CharClass && this.service) {
          this.service.updateCharacteristic(CharClass as never, t.toHK(this.currentValue));
        }
      } catch {
        // first read may not be available until the first change event
      }

      this.log.info(
        `[${this.cfg.name}] attached (${this.cfg.channelClass}` +
          (this.cfg.serialNumber ? `, sn ${this.cfg.serialNumber}` : '') +
          `)`,
      );
    } catch (err) {
      this.log.warn(
        `[${this.cfg.name}] open failed: ${(err as Error).message}. Will stay unresponsive until the device appears.`,
      );
    }
  }
}

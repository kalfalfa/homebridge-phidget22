import type {
  PlatformAccessory,
  Service,
  Logger,
  CharacteristicValue,
} from 'homebridge';
import type * as phidget22 from 'phidget22';

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
  private attached = false;

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
    this.openChannel();
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
    const isWritable = !!t.fromHK;
    char.onGet(() => {
      // For sensor services, surface "No Response" in HomeKit while detached
      // rather than returning a stale value. For writable services (switches,
      // lights, outlets, fans) keep the last-known state — a greyed tile is
      // less useful than the last commanded state.
      if (!this.attached && !isWritable) {
        throw new this.platform.api.hap.HapStatusError(
          this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
        );
      }
      return t.toHK(this.currentValue);
    });

    if (isWritable) {
      char.onSet(async (value: CharacteristicValue) => {
        if (!this.attached) {
          throw new this.platform.api.hap.HapStatusError(
            this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
          );
        }
        const native = t.fromHK!(value as number | boolean);
        this.currentValue = native;
        try {
          await this.handle?.write?.(native);
        } catch (err) {
          this.log.warn(`[${this.cfg.name}] write failed: ${(err as Error).message}`);
          throw new this.platform.api.hap.HapStatusError(
            this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
          );
        }
      });
    }
  }

  private openChannel(): void {
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

    const ch = this.handle.channel as phidget22.Phidget;
    ch.onAttach = async () => {
      this.attached = true;
      this.log.info(
        `[${this.cfg.name}] attached (${this.cfg.channelClass}` +
          (this.cfg.serialNumber ? `, sn ${this.cfg.serialNumber}` : '') +
          `)`,
      );
      try {
        await applyPostAttach(this.cfg.channelClass, this.handle!, {
          address: {},
          sensorType: this.cfg.sensorType,
          dataInterval: this.cfg.dataInterval,
        });
      } catch (err) {
        this.log.warn(`[${this.cfg.name}] post-attach setup failed: ${(err as Error).message}`);
      }
      try {
        this.currentValue = this.handle!.read();
        if (CharClass && this.service) {
          this.service.updateCharacteristic(CharClass as never, t.toHK(this.currentValue));
        }
      } catch {
        // first read may not be available until the first change event
      }
    };
    ch.onDetach = () => {
      this.attached = false;
      this.log.info(`[${this.cfg.name}] detached — will reattach when the device reappears`);
      // Push unresponsive state to HomeKit for sensor services, so the tile
      // shows "No Response" without waiting for the next poll.
      if (CharClass && this.service && !t.fromHK) {
        this.service.getCharacteristic(CharClass as never).updateValue(
          new this.platform.api.hap.HapStatusError(
            this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
          ),
        );
      }
    };

    // Fire-and-forget open; passing no timeout tells the Phidget library to
    // match forever. onAttach / onDetach handle lifecycle transitions.
    this.handle.channel.open().catch((err) => {
      this.log.warn(`[${this.cfg.name}] open failed: ${(err as Error).message}`);
    });
  }
}

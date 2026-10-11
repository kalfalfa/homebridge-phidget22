/**
 * Mapping between Phidget channel classes and HomeKit services.
 *
 * Each channel class we support contributes:
 *   - a factory that creates the channel instance
 *   - a subscriber that wires the channel's change event to a callback
 *   - a "native unit reader" that reports the current numeric value or state
 *
 * HomeKit service choice is driven by config (user picks which service makes
 * sense). The per-service transform converts the native Phidget value into the
 * characteristic value — e.g. a 0..1 duty cycle on a DigitalOutput becomes a
 * boolean On characteristic, or a VoltageRatioInput sensorValue in °C flows
 * through unchanged into CurrentTemperature.
 */

import * as phidget22 from 'phidget22';

export type SupportedChannelClass =
  | 'VoltageInput'
  | 'VoltageRatioInput'
  | 'TemperatureSensor'
  | 'HumiditySensor'
  | 'LightSensor'
  | 'PressureSensor'
  | 'DistanceSensor'
  | 'CurrentInput'
  | 'FrequencyCounter'
  | 'DigitalInput'
  | 'DigitalOutput'
  | 'CapacitiveTouch';

export type SupportedService =
  | 'TemperatureSensor'
  | 'HumiditySensor'
  | 'LightSensor'
  | 'ContactSensor'
  | 'MotionSensor'
  | 'LeakSensor'
  | 'SmokeSensor'
  | 'OccupancySensor'
  | 'CarbonMonoxideSensor'
  | 'CarbonDioxideSensor'
  | 'AirQualitySensor'
  | 'Switch'
  | 'Lightbulb'
  | 'Outlet'
  | 'Fan';

export interface ChannelAddress {
  serialNumber?: number;
  hubPort?: number;
  channel?: number;
  isHubPortDevice?: boolean;
  deviceLabel?: string;
  isRemote?: boolean;
  isLocal?: boolean;
  serverName?: string;
}

export interface ChannelHandle {
  channel: phidget22.Phidget;
  /** Attach a listener for incoming value changes. Returns an unsubscribe fn. */
  onValue(listener: (value: number) => void): () => void;
  /** Read the current cached value (post-attach). May throw if not yet available. */
  read(): number;
  /** Optional writer for output channels. */
  write?(value: number): Promise<void>;
}

export function resolveVoltageSensorType(name: string | undefined): number | undefined {
  if (!name) return undefined;
  const v = (phidget22.VoltageSensorType as unknown as Record<string, number>)[name];
  return typeof v === 'number' ? v : undefined;
}

export function resolveVoltageRatioSensorType(name: string | undefined): number | undefined {
  if (!name) return undefined;
  const v = (phidget22.VoltageRatioSensorType as unknown as Record<string, number>)[name];
  return typeof v === 'number' ? v : undefined;
}

export interface ChannelFactoryOptions {
  address: ChannelAddress;
  sensorType?: string;
  dataInterval?: number;
  invert?: boolean;
}

/**
 * Build a channel instance, apply addressing, and return the normalized handle
 * (value listener + reader + optional writer). The channel is NOT opened here —
 * the caller performs openWaitForAttachment.
 */
export function buildChannel(
  channelClass: SupportedChannelClass,
  opts: ChannelFactoryOptions,
): ChannelHandle {
  const ch = createChannel(channelClass, opts);
  applyAddress(ch, opts.address);
  return wireHandle(channelClass, ch, opts);
}

function createChannel(cls: SupportedChannelClass, opts: ChannelFactoryOptions): phidget22.Phidget {
  switch (cls) {
    case 'VoltageInput': {
      const c = new phidget22.VoltageInput();
      // sensor type is set after open — defer; the enum value is stored for later.
      (c as unknown as { _pendingSensorType?: number })._pendingSensorType =
        resolveVoltageSensorType(opts.sensorType);
      return c;
    }
    case 'VoltageRatioInput': {
      const c = new phidget22.VoltageRatioInput();
      (c as unknown as { _pendingSensorType?: number })._pendingSensorType =
        resolveVoltageRatioSensorType(opts.sensorType);
      return c;
    }
    case 'TemperatureSensor': return new phidget22.TemperatureSensor();
    case 'HumiditySensor': return new phidget22.HumiditySensor();
    case 'LightSensor': return new phidget22.LightSensor();
    case 'PressureSensor': return new phidget22.PressureSensor();
    case 'DistanceSensor': return new phidget22.DistanceSensor();
    case 'CurrentInput': return new phidget22.CurrentInput();
    case 'FrequencyCounter': return new phidget22.FrequencyCounter();
    case 'DigitalInput': return new phidget22.DigitalInput();
    case 'DigitalOutput': return new phidget22.DigitalOutput();
    case 'CapacitiveTouch': return new phidget22.CapacitiveTouch();
  }
}

function applyAddress(ch: phidget22.Phidget, addr: ChannelAddress): void {
  if (addr.serialNumber !== undefined) ch.setDeviceSerialNumber(addr.serialNumber);
  if (addr.hubPort !== undefined) ch.setHubPort(addr.hubPort);
  if (addr.channel !== undefined) ch.setChannel(addr.channel);
  if (addr.isHubPortDevice) ch.setIsHubPortDevice(true);
  if (addr.deviceLabel) ch.setDeviceLabel(addr.deviceLabel);
  if (addr.isLocal) ch.setIsLocal(true);
  if (addr.isRemote) ch.setIsRemote(true);
}

function wireHandle(
  cls: SupportedChannelClass,
  ch: phidget22.Phidget,
  opts: ChannelFactoryOptions,
): ChannelHandle {
  switch (cls) {
    case 'VoltageInput': {
      const c = ch as phidget22.VoltageInput;
      return {
        channel: c,
        onValue(listener) {
          c.onSensorChange = (value) => listener(value as number);
          c.onVoltageChange = (voltage) => {
            // only fires when sensor type is VOLTAGE
            listener(voltage);
          };
          return () => { c.onSensorChange = null; c.onVoltageChange = null; };
        },
        read() {
          const st = (c as unknown as { _pendingSensorType?: number })._pendingSensorType;
          if (st !== undefined && st !== phidget22.VoltageSensorType.VOLTAGE) {
            return c.sensorValue;
          }
          return c.voltage;
        },
      };
    }
    case 'VoltageRatioInput': {
      const c = ch as phidget22.VoltageRatioInput;
      return {
        channel: c,
        onValue(listener) {
          c.onSensorChange = (value) => listener(value as number);
          c.onVoltageRatioChange = (ratio) => listener(ratio);
          return () => { c.onSensorChange = null; c.onVoltageRatioChange = null; };
        },
        read() {
          const st = (c as unknown as { _pendingSensorType?: number })._pendingSensorType;
          if (st !== undefined && st !== phidget22.VoltageRatioSensorType.VOLTAGE_RATIO) {
            return c.sensorValue;
          }
          return c.voltageRatio;
        },
      };
    }
    case 'TemperatureSensor': {
      const c = ch as phidget22.TemperatureSensor;
      return {
        channel: c,
        onValue(listener) {
          c.onTemperatureChange = (t) => listener(t);
          return () => { c.onTemperatureChange = null; };
        },
        read() { return c.temperature; },
      };
    }
    case 'HumiditySensor': {
      const c = ch as phidget22.HumiditySensor;
      return {
        channel: c,
        onValue(listener) {
          c.onHumidityChange = (h) => listener(h);
          return () => { c.onHumidityChange = null; };
        },
        read() { return c.humidity; },
      };
    }
    case 'LightSensor': {
      const c = ch as phidget22.LightSensor;
      return {
        channel: c,
        onValue(listener) {
          c.onIlluminanceChange = (lux) => listener(lux);
          return () => { c.onIlluminanceChange = null; };
        },
        read() { return c.illuminance; },
      };
    }
    case 'PressureSensor': {
      const c = ch as phidget22.PressureSensor;
      return {
        channel: c,
        onValue(listener) {
          c.onPressureChange = (p) => listener(p);
          return () => { c.onPressureChange = null; };
        },
        read() { return c.pressure; },
      };
    }
    case 'DistanceSensor': {
      const c = ch as phidget22.DistanceSensor;
      return {
        channel: c,
        onValue(listener) {
          c.onDistanceChange = (d) => listener(d);
          return () => { c.onDistanceChange = null; };
        },
        read() { return c.distance; },
      };
    }
    case 'CurrentInput': {
      const c = ch as phidget22.CurrentInput;
      return {
        channel: c,
        onValue(listener) {
          c.onCurrentChange = (a) => listener(a);
          return () => { c.onCurrentChange = null; };
        },
        read() { return c.current; },
      };
    }
    case 'FrequencyCounter': {
      const c = ch as phidget22.FrequencyCounter;
      return {
        channel: c,
        onValue(listener) {
          c.onFrequencyChange = (hz) => listener(hz);
          return () => { c.onFrequencyChange = null; };
        },
        read() { return c.frequency; },
      };
    }
    case 'DigitalInput': {
      const c = ch as phidget22.DigitalInput;
      const invert = !!opts.invert;
      return {
        channel: c,
        onValue(listener) {
          c.onStateChange = (state) => listener(invert ? (state ? 0 : 1) : (state ? 1 : 0));
          return () => { c.onStateChange = null; };
        },
        read() {
          const s = c.state ? 1 : 0;
          return invert ? (s ? 0 : 1) : s;
        },
      };
    }
    case 'DigitalOutput': {
      const c = ch as phidget22.DigitalOutput;
      return {
        channel: c,
        onValue(listener) {
          // DigitalOutput doesn't emit a change event; we fake one by letting
          // the accessory call read() after each write().
          void listener;
          return () => {};
        },
        read() { return c.state ? 1 : 0; },
        async write(v: number) {
          if (v > 0 && v < 1) {
            await c.setDutyCycle(v);
          } else {
            await c.setState(v >= 0.5);
          }
        },
      };
    }
    case 'CapacitiveTouch': {
      const c = ch as phidget22.CapacitiveTouch;
      return {
        channel: c,
        onValue(listener) {
          c.onTouch = (val) => listener(val);
          c.onTouchEnd = () => listener(0);
          return () => { c.onTouch = null; c.onTouchEnd = null; };
        },
        read() { return c.touchValue; },
      };
    }
  }
}

/**
 * After openWaitForAttachment succeeds, apply post-attach settings
 * (sensor type, data interval). These can't be set before open on many channels.
 */
export async function applyPostAttach(
  channelClass: SupportedChannelClass,
  handle: ChannelHandle,
  opts: ChannelFactoryOptions,
): Promise<void> {
  if (channelClass === 'VoltageInput') {
    const c = handle.channel as phidget22.VoltageInput;
    const st = (c as unknown as { _pendingSensorType?: number })._pendingSensorType;
    if (st !== undefined) await c.setSensorType(st);
  }
  if (channelClass === 'VoltageRatioInput') {
    const c = handle.channel as phidget22.VoltageRatioInput;
    const st = (c as unknown as { _pendingSensorType?: number })._pendingSensorType;
    if (st !== undefined) await c.setSensorType(st);
  }
  if (opts.dataInterval !== undefined) {
    const anyCh = handle.channel as unknown as { setDataInterval?: (ms: number) => Promise<void> };
    if (typeof anyCh.setDataInterval === 'function') {
      await anyCh.setDataInterval(opts.dataInterval);
    }
  }
}

export interface ServiceTransform {
  /** Characteristic constructor name on hap.Characteristic */
  characteristic: string;
  /** Convert the raw Phidget value to a HomeKit characteristic value. */
  toHK(v: number): number | boolean;
  /** Secondary characteristics driven from the same value (optional). */
  secondary?: Array<{ characteristic: string; toHK: (v: number) => number | boolean }>;
  /** For writable services, convert HK value → Phidget value. */
  fromHK?(v: number | boolean): number;
}

export function serviceTransform(service: SupportedService): ServiceTransform {
  switch (service) {
    case 'TemperatureSensor':
      return { characteristic: 'CurrentTemperature', toHK: (v) => clamp(v, -270, 100) };
    case 'HumiditySensor':
      return { characteristic: 'CurrentRelativeHumidity', toHK: (v) => clamp(v, 0, 100) };
    case 'LightSensor':
      return { characteristic: 'CurrentAmbientLightLevel', toHK: (v) => Math.max(0.0001, v) };
    case 'ContactSensor':
      return { characteristic: 'ContactSensorState', toHK: (v) => (v ? 1 : 0) };
    case 'MotionSensor':
      return { characteristic: 'MotionDetected', toHK: (v) => !!v };
    case 'LeakSensor':
      return { characteristic: 'LeakDetected', toHK: (v) => (v ? 1 : 0) };
    case 'SmokeSensor':
      return { characteristic: 'SmokeDetected', toHK: (v) => (v ? 1 : 0) };
    case 'OccupancySensor':
      return { characteristic: 'OccupancyDetected', toHK: (v) => (v ? 1 : 0) };
    case 'CarbonMonoxideSensor':
      return { characteristic: 'CarbonMonoxideLevel', toHK: (v) => Math.max(0, v) };
    case 'CarbonDioxideSensor':
      return {
        characteristic: 'CarbonDioxideLevel',
        toHK: (v) => Math.max(0, v),
        secondary: [{ characteristic: 'CarbonDioxideDetected', toHK: (v) => (v > 1000 ? 1 : 0) }],
      };
    case 'AirQualitySensor':
      return { characteristic: 'AirQuality', toHK: (v) => Math.max(0, Math.min(5, Math.round(v))) };
    case 'Switch':
    case 'Outlet':
      return {
        characteristic: 'On',
        toHK: (v) => !!v,
        fromHK: (v) => (v ? 1 : 0),
      };
    case 'Lightbulb':
      return {
        characteristic: 'On',
        toHK: (v) => v > 0,
        fromHK: (v) => (v ? 1 : 0),
      };
    case 'Fan':
      return {
        characteristic: 'On',
        toHK: (v) => !!v,
        fromHK: (v) => (v ? 1 : 0),
      };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

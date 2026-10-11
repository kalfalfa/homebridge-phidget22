# homebridge-phidget22

A Homebridge dynamic platform plugin that exposes [Phidget22](https://www.phidgets.com/) data to HomeKit.

Two source types are supported per accessory:

1. **Phidget Channel** — opens a Phidget channel directly (via local USB or a
   Phidget Network Server) and binds the live value to a HomeKit characteristic.
   Analog inputs can use the Phidget sensor-type APIs so the value you get is
   already in the sensor's native units (°C, lux, kPa, …) instead of raw volts.
2. **Phidget Dictionary Key** — subscribes to a key in a Phidget Network
   Server dictionary. Any program on your network that writes to the dictionary
   (e.g. `sensorServer`, `WaterMeter`, `fermController`, `hueServer`) gets a
   HomeKit mirror for free.

## Install

```sh
sudo npm install -g homebridge-phidget22
```

Or for development with the repo checked out locally:

```sh
cd ~/homebridge-phidget22
npm install
npm run build
sudo npm install -g .     # or `sudo npm link`
```

Phidget22 USB access requires `libusb` and either the system Phidget drivers
or the optional `usb` npm package.

## Configuration

Add a `Phidget22` platform block to Homebridge's `config.json`.

### Connections

```json
"connections": [
  { "name": "Local", "type": "local" },
  { "name": "Beerchamber", "type": "network", "hostname": "beerchamber.local", "port": 5661 }
]
```

- `local` opens channels over USB.
- `network` opens them against a Phidget Network Server.

If you omit `connections`, a single `Local` USB connection is assumed.

### Channel accessories

```json
{
  "type": "channel",
  "name": "Downstairs Temperature",
  "connection": "Local",
  "channelClass": "VoltageRatioInput",
  "serialNumber": 123456,
  "channel": 3,
  "sensorType": "PN_1125_TEMPERATURE",
  "service": "TemperatureSensor",
  "dataInterval": 1000
}
```

- `channelClass` — any supported Phidget channel class (see schema).
- `service` — the HomeKit service to expose. Supports all common sensor types
  plus `Switch` / `Outlet` / `Lightbulb` / `Fan` for `DigitalOutput`.
- `sensorType` — for `VoltageInput` / `VoltageRatioInput`, the enum name from
  `phidget22.VoltageSensorType` / `phidget22.VoltageRatioSensorType`
  (e.g. `PN_1142`, `PN_1125_TEMPERATURE`). Omit for raw voltage / ratio.
- Addressing — `serialNumber`, `hubPort`, `channel`, `isHubPortDevice`,
  `deviceLabel` are all optional; use the ones you need to disambiguate.
- `invert` on `DigitalInput` flips the characteristic (useful for pull-ups).

### Dictionary accessories

Phidget Dictionaries live on the Phidget Network Server, not on USB — so a
dictionary accessory must reference a `network`-type connection. The server
is usually running on the same host (`localhost:5661`), in which case:

```json
"connections": [
  { "name": "LocalServer", "type": "network", "hostname": "localhost" }
]
```

```json
{
  "type": "dictionary",
  "name": "Cellar Fermentation",
  "connection": "LocalServer",
  "dictionaryLabel": "sensors",
  "key": "CellarFermentationTemperature",
  "service": "TemperatureSensor"
}
```

- One `Dictionary` channel is opened per `(connection, dictionaryLabel)` pair
  and shared across all keys bound to it.
- `parse: "bool"` treats `0 / 1 / true / false / on / off` as a boolean.
- `scale` / `offset` adjust the value (e.g. `scale: 0.001` for mW → W).
- `writable: true` on a `Switch` / `Lightbulb` accessory writes the key back
  to the dictionary when HomeKit toggles it.

### Full example — mapping an existing dictionary into HomeKit

```json
{
  "platform": "Phidget22",
  "connections": [
    { "name": "Local", "type": "local" },
    { "name": "LocalServer", "type": "network", "hostname": "localhost" }
  ],
  "accessories": [
    { "type": "dictionary", "name": "Downstairs Temp", "connection": "LocalServer", "key": "DownstairsTemperature", "service": "TemperatureSensor" },
    { "type": "dictionary", "name": "Downstairs Humidity", "key": "DownstairsHumidity", "service": "HumiditySensor" },
    { "type": "dictionary", "name": "Outside Temp", "key": "OutsideFilterTemperature", "service": "TemperatureSensor" },
    { "type": "dictionary", "name": "Outside Humidity", "key": "OutsideFilterHumidity", "service": "HumiditySensor" },
    { "type": "dictionary", "name": "Garage Temp", "key": "GarageTemperature", "service": "TemperatureSensor" },
    { "type": "dictionary", "name": "Cellar Fermentation", "key": "CellarFermentationTemperature", "service": "TemperatureSensor" },
    { "type": "dictionary", "name": "Cellar Room", "key": "CellarTemperature", "service": "TemperatureSensor" },
    { "type": "dictionary", "name": "Water Flow", "key": "WaterRateMinute", "service": "LightSensor", "scale": 1000000 }
  ]
}
```

(The Water Flow line is an example of using `LightSensor` as a generic
numeric gauge; HomeKit has no "flow rate" characteristic. Scale is applied
so the value falls into the lux range.)

## Supported HomeKit services

`TemperatureSensor`, `HumiditySensor`, `LightSensor`, `ContactSensor`,
`MotionSensor`, `LeakSensor`, `SmokeSensor`, `OccupancySensor`,
`CarbonMonoxideSensor`, `CarbonDioxideSensor`, `AirQualitySensor`,
`Switch`, `Lightbulb`, `Outlet`, `Fan`.

## Supported channel classes

`VoltageInput`, `VoltageRatioInput`, `TemperatureSensor`, `HumiditySensor`,
`LightSensor`, `PressureSensor`, `DistanceSensor`, `CurrentInput`,
`FrequencyCounter`, `DigitalInput`, `DigitalOutput`, `CapacitiveTouch`.

Need another? Open an issue or add a case in `src/mapping.ts`.

## Troubleshooting

- `open failed: ...` — the channel's addressing didn't match a device. Check
  serial number, hub port, channel, and `isHubPortDevice`. The plugin keeps
  trying after an open failure in the sense that the Phidget library's own
  attach watch will fire if the device later appears.
- Network connections retry automatically if the server comes up later.
- Dictionary writes are only attempted when `writable: true`.

## License

ISC.

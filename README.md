# homebridge-phidget22

A Homebridge dynamic platform plugin that exposes [Phidget22](https://www.phidgets.com/) data to HomeKit.

Two source types are supported per accessory:

1. **Phidget Channel** — opens a Phidget channel directly (via local USB or a
   Phidget Network Server) and binds the live value to a HomeKit characteristic.
   Analog inputs can use the Phidget sensor-type APIs so the value you get is
   already in the sensor's native units (°C, lux, kPa, …) instead of raw volts.
2. **Phidget Dictionary Key** — subscribes to a key in a Phidget Network
   Server dictionary. Any program on the network that writes to the dictionary
   gets a HomeKit mirror for free, without the program itself needing to speak
   HomeKit.

## Install

```sh
sudo npm install -g homebridge-phidget22
```

Or for development with the repo checked out locally:

```sh
cd homebridge-phidget22
npm install
npm run build
sudo npm install -g .     # or `sudo npm link`
```

The `phidget22` npm package is self-contained — it does **not** depend on
Phidget's C library or Phidget Control Panel being installed on the system.
For local USB connections it uses the optional `usb` npm package (a native
libusb binding), which npm pulls in automatically when build tools are
available. For `network`-type connections to a Phidget Network Server no
USB stack is needed at all.

## Configuration

Add a `Phidget22` platform block to Homebridge's `config.json`.

### Connections

```json
"connections": [
  { "name": "Local", "type": "local" },
  { "name": "Shed", "type": "network", "hostname": "shed.local", "port": 5661 }
]
```

- `local` opens channels over USB.
- `network` opens them against a Phidget Network Server.

If you omit `connections`, a single `Local` USB connection is assumed.

Both `local` and `network` connects are fire-and-forget. If a network server
isn't up yet, the connection retries forever in the background; Homebridge
startup isn't blocked.

### Channel accessories

```json
{
  "type": "channel",
  "name": "Living Room Temperature",
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
- Addressing — `serialNumber`, `deviceLabel`, `hubPort`, `channel`,
  `isHubPortDevice` are all optional; use the ones you need to disambiguate.
  `deviceLabel` matches the string written into the device's flash via the
  Phidget Control Panel ("writeDeviceLabel") and is an alternative to the
  serial number.
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
  "name": "Greenhouse Temperature",
  "connection": "LocalServer",
  "dictionaryLabel": "sensors",
  "key": "GreenhouseTemperature",
  "service": "TemperatureSensor"
}
```

- One `Dictionary` channel is opened per `(connection, dictionaryLabel)` pair
  and shared across all keys bound to it.
- `parse: "bool"` treats `0 / 1 / true / false / on / off` as a boolean.
- `scale` / `offset` adjust the value (e.g. `scale: 0.001` for mW → W).
- `writable: true` on a `Switch` / `Lightbulb` accessory writes the key back
  to the dictionary when HomeKit toggles it.

### Full example

```json
{
  "platform": "Phidget22",
  "connections": [
    { "name": "Local", "type": "local" },
    { "name": "LocalServer", "type": "network", "hostname": "localhost" }
  ],
  "accessories": [
    { "type": "channel", "name": "Hub LED", "channelClass": "DigitalOutput", "hubPort": 0, "isHubPortDevice": true, "service": "Lightbulb" },
    { "type": "dictionary", "name": "Outside Temp", "connection": "LocalServer", "key": "OutsideTemperature", "service": "TemperatureSensor" },
    { "type": "dictionary", "name": "Outside Humidity", "connection": "LocalServer", "key": "OutsideHumidity", "service": "HumiditySensor" },
    { "type": "dictionary", "name": "Water Flow", "connection": "LocalServer", "key": "WaterRateMinute", "service": "LightSensor", "scale": 1000000 }
  ]
}
```

The Water Flow line is an example of using `LightSensor` as a generic numeric
gauge; HomeKit has no "flow rate" characteristic. The scale shifts the value
into the lux range so the characteristic stays within its allowed bounds.

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

## Logging

The phidget22 library's own log output is routed through Homebridge's logger.
Level is set in config:

```json
"log": { "level": "warning" }
```

Valid levels: `critical`, `error`, `warning` (default), `info`, `debug`,
`verbose`.

## Unresponsive state

Sensor-style accessories (temperature, humidity, contact, motion, etc.)
report **"No Response"** to HomeKit when:

- the device is physically detached or the Phidget Network Server is down,
- the dictionary key referenced by the accessory is missing from the
  dictionary, or
- the dictionary value can't be parsed into a number.

Writable accessories (`Switch`, `Lightbulb`, `Outlet`, `Fan`) keep their
last-known state while detached but fail writes with a communication-failure
error so HomeKit knows the command didn't go through.

A caveat from HAP-NodeJS: erroneous state is **not pushed** to HomeKit
controllers — it's only returned when the controller next polls the
characteristic. The Home app typically polls on tile scroll or detail view,
so a tile may show its last cached value until it comes into view.

## Troubleshooting

- Channels open fire-and-forget — no startup timeout, no "open failed" at
  attach time. If a device isn't present the plugin stays registered and the
  Phidget library attaches whenever the device appears (or reappears after
  an unplug). Watch for `[name] attached` / `[name] detached` log lines.
- If the plugin never logs `attached` for a given accessory, check the
  addressing: `serialNumber`, `deviceLabel`, `hubPort`, `channel`, and
  `isHubPortDevice` must identify exactly one channel.
- `key "..." not present in dictionary` means the dictionary attached but
  the key you configured doesn't exist (yet). Deduped — the message appears
  once per transition.
- `unparseable value for "..."` means the stored string can't be converted
  to a number (or boolean, with `parse: "bool"`).
- Network connections retry automatically if the server comes up later.
- Dictionary writes are only attempted when `writable: true`.
- `LIBUSB_ERROR_BUSY` on a local USB channel means a Phidget Network Server
  on the same host already claimed the device. Either stop the server or
  route the channel through a `network`-type connection to `localhost`.

## License

ISC.

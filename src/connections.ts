import type { Logger } from 'homebridge';
import * as phidget22 from 'phidget22';

export type ConnectionKind = 'local' | 'network';

export interface ConnectionConfig {
  name: string;
  type?: ConnectionKind;
  hostname?: string;
  port?: number;
  password?: string;
}

interface LocalNetworkConnectionOptions {
  hostname?: string;
  port?: number;
  name?: string;
  passwd?: string;
  onConnect?: () => void | Promise<void>;
  onDisconnect?: () => void | Promise<void>;
  onError?: (code: number, msg: string) => void | Promise<void>;
}

/**
 * One ConnectionTarget represents a single Phidget library "location" that
 * channels can be opened against. For a local USB connection it just manages
 * a USBConnection; for a network connection it holds the NetworkConnection
 * and reconnects on disconnect.
 *
 * Channels themselves don't belong to a connection in the Phidget library —
 * when you open a channel, the library picks any attached connection that
 * matches. We model "connection" in config just so the user can address
 * specific servers (serial-number alone is usually enough since each
 * server exposes its own set of serials).
 */
export class ConnectionTarget {
  readonly name: string;
  readonly kind: ConnectionKind;
  readonly hostname?: string;
  readonly port?: number;
  private connection?: phidget22.NetworkConnection | phidget22.USBConnection;
  private connected = false;

  constructor(cfg: ConnectionConfig, private readonly log: Logger) {
    this.name = cfg.name;
    this.kind = cfg.type ?? 'local';
    this.hostname = cfg.hostname;
    this.port = cfg.port;

    if (this.kind === 'network') {
      const opts: LocalNetworkConnectionOptions = {
        hostname: cfg.hostname ?? 'localhost',
        port: cfg.port ?? 5661,
        name: cfg.name,
        passwd: cfg.password ?? '',
        onConnect: () => {
          this.connected = true;
          this.log.info(`[${this.name}] connected to Phidget server ${opts.hostname}:${opts.port}`);
        },
        onDisconnect: () => {
          this.connected = false;
          this.log.warn(`[${this.name}] disconnected from Phidget server`);
        },
        onError: (code: number, msg: string) => {
          this.log.warn(`[${this.name}] server error ${code}: ${msg}`);
        },
      };
      this.connection = new phidget22.NetworkConnection(opts as never);
    } else {
      try {
        this.connection = new phidget22.USBConnection();
      } catch (err) {
        this.log.error(
          `[${this.name}] failed to create USBConnection — is the "usb" npm package installed? ${(err as Error).message}`,
        );
      }
    }
  }

  connect(): void {
    if (!this.connection) {
      return;
    }
    if (this.connection instanceof phidget22.NetworkConnection) {
      // retryOnFail: true — library maintains the retry forever; we don't
      // await the promise so startup isn't blocked by an unreachable server.
      // onConnect / onDisconnect callbacks drive our `connected` flag.
      this.connection.connect(true).catch((err) => {
        this.log.error(`[${this.name}] connect failed: ${(err as Error).message}`);
      });
    } else if (this.connection instanceof phidget22.USBConnection) {
      this.connection.connect().then(() => {
        this.connected = true;
        this.log.info(`[${this.name}] USB connection ready`);
      }).catch((err) => {
        this.log.error(`[${this.name}] connect failed: ${(err as Error).message}`);
      });
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  close(): void {
    try {
      this.connection?.close();
    } catch {
      // ignore
    }
  }
}

export class ConnectionManager {
  private targets = new Map<string, ConnectionTarget>();

  constructor(private readonly log: Logger) {}

  add(cfg: ConnectionConfig): ConnectionTarget {
    if (this.targets.has(cfg.name)) {
      return this.targets.get(cfg.name)!;
    }
    const target = new ConnectionTarget(cfg, this.log);
    this.targets.set(cfg.name, target);
    return target;
  }

  get(name: string): ConnectionTarget | undefined {
    return this.targets.get(name);
  }

  connectAll(): void {
    for (const t of this.targets.values()) t.connect();
  }

  closeAll(): void {
    for (const t of this.targets.values()) t.close();
  }
}

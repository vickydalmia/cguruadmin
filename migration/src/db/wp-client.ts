import mysql from "mysql2/promise";
import ssh2 from "ssh2";
import type { Client as SSHClientType } from "ssh2";

const { Client: SSHClient, utils: sshUtils } = ssh2;
import { createHash } from "crypto";
import { readFileSync, existsSync } from "fs";
import net from "net";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

let pool: mysql.Pool | null = null;
let sshClient: SSHClientType | null = null;
let localServer: net.Server | null = null;
let tunnelPort: number | null = null;

async function createSSHTunnel(): Promise<number> {
  return new Promise((resolve, reject) => {
    const ssh = new SSHClient();
    sshClient = ssh;

    ssh.on("ready", () => {
      logger.info(`SSH tunnel connected to ${config.ssh.host}`);

      const server = net.createServer((sock) => {
        ssh.forwardOut(
          "127.0.0.1",
          0,
          config.wp.host,
          config.wp.port,
          (err, stream) => {
            if (err) {
              sock.destroy();
              return;
            }
            sock.pipe(stream).pipe(sock);
          }
        );
      });

      localServer = server;

      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as net.AddressInfo;
        tunnelPort = addr.port;
        logger.info(
          `SSH tunnel forwarding 127.0.0.1:${tunnelPort} → ${config.wp.host}:${config.wp.port}`
        );
        resolve(tunnelPort);
      });

      server.on("error", reject);
    });

    ssh.on("error", (err) => {
      reject(new Error(`SSH connection failed: ${err.message}`));
    });

    const connectOpts: Record<string, any> = {
      host: config.ssh.host,
      port: config.ssh.port,
      username: config.ssh.user,
      // ssh2 accepts ANY host key by default — a silent MITM risk when the
      // tunnel carries WP DB credentials and the full site dump. Verify the
      // server key against the pinned fingerprint, failing closed. If no
      // fingerprint is configured, log the presented one loudly so the
      // operator can pin it, and refuse to continue rather than trust blindly.
      hostVerifier: (key: Buffer): boolean => {
        const presented = `SHA256:${createHash("sha256")
          .update(key)
          .digest("base64")
          .replace(/=+$/, "")}`;
        const expected = config.ssh.hostFingerprint;
        if (!expected) {
          logger.error(
            `SSH host key not verified. Presented fingerprint: ${presented}. ` +
              `Set SSH_HOST_FINGERPRINT in .env.migration to this value (after ` +
              `confirming it out-of-band) to enable the tunnel.`
          );
          return false;
        }
        if (presented !== expected.trim()) {
          logger.error(
            `SSH host key mismatch — possible MITM. Expected ${expected.trim()}, ` +
              `got ${presented}. Aborting.`
          );
          return false;
        }
        logger.info(`SSH host key verified (${presented})`);
        return true;
      },
    };

    // Offer both auth methods: the agent socket alone is not enough when it
    // has no identities loaded, and an encrypted key file needs a passphrase.
    // ssh2 is non-interactive — an encrypted key with no passphrase is fatal
    // at connect time, so only pass the key when it can actually be used.
    if (process.env.SSH_AUTH_SOCK) {
      connectOpts.agent = process.env.SSH_AUTH_SOCK;
    }
    if (config.ssh.privateKeyPath && existsSync(config.ssh.privateKeyPath)) {
      const keyData = readFileSync(config.ssh.privateKeyPath);
      const parsed = sshUtils.parseKey(keyData, config.ssh.passphrase || undefined);

      if (parsed instanceof Error) {
        logger.warn(
          `Skipping private key ${config.ssh.privateKeyPath} (${parsed.message}). ` +
            `Load it into your agent with "ssh-add ${config.ssh.privateKeyPath}" ` +
            `or set SSH_PRIVATE_KEY_PASSPHRASE in .env.migration.`
        );
      } else {
        connectOpts.privateKey = keyData;
        if (config.ssh.passphrase) {
          connectOpts.passphrase = config.ssh.passphrase;
        }
      }
    }
    if (!connectOpts.agent && !connectOpts.privateKey) {
      logger.warn(
        "No SSH auth available: agent socket missing and no usable private key file"
      );
    }

    ssh.connect(connectOpts);
  });
}

export async function getWpPool(): Promise<mysql.Pool> {
  if (!pool) {
    let host = config.wp.host;
    let port = config.wp.port;

    if (config.ssh.host) {
      port = await createSSHTunnel();
      host = "127.0.0.1";
    }

    pool = mysql.createPool({
      host,
      port,
      user: config.wp.user,
      password: config.wp.password,
      database: config.wp.database,
      waitForConnections: true,
      connectionLimit: 10,
      charset: "utf8mb4",
      dateStrings: true,
    });
  }
  return pool;
}

export async function wpQuery<T = any>(
  sql: string,
  params?: any[]
): Promise<T[]> {
  const p = await getWpPool();
  const [rows] = await p.execute(sql, params);
  return rows as T[];
}

export async function closeWp(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
  if (localServer) {
    localServer.close();
    localServer = null;
  }
  if (sshClient) {
    sshClient.end();
    sshClient = null;
  }
}

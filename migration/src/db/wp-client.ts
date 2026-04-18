import mysql from "mysql2/promise";
import { Client as SSHClient } from "ssh2";
import { readFileSync, existsSync } from "fs";
import net from "net";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

let pool: mysql.Pool | null = null;
let sshClient: SSHClient | null = null;
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
    };

    // Prefer ssh-agent, fall back to private key file
    if (process.env.SSH_AUTH_SOCK) {
      connectOpts.agent = process.env.SSH_AUTH_SOCK;
    } else if (config.ssh.privateKeyPath && existsSync(config.ssh.privateKeyPath)) {
      connectOpts.privateKey = readFileSync(config.ssh.privateKeyPath);
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

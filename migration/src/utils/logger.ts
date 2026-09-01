import winston from "winston";
import { config } from "../config.js";

export const logger = winston.createLogger({
  level: config.logLevel,
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.printf(
      ({ timestamp, level, message }) => `${timestamp} [${level}] ${message}`
    )
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: "HH:mm:ss" }),
        winston.format.printf(
          ({ timestamp, level, message }) => `${timestamp} ${level}: ${message}`
        )
      ),
    }),
    new winston.transports.File({
      filename: "migration.log",
      dirname: config.stateDir,
    }),
    new winston.transports.File({
      filename: "migration-errors.log",
      dirname: config.stateDir,
      level: "error",
    }),
  ],
});

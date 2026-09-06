"use strict";

// Durable history + job queue for automatic and manual database backups
// (src/database-backup/). One row per backup attempt; the runner in the
// maintenance container claims pending rows with a lease (lock_token /
// heartbeat_at), and the admin settings page reads the same table.
const RUNS = "database_backup_runs";

function isPostgres(knex) {
  return ["pg", "postgres", "postgresql"].includes(
    String(knex.client.config.client || "").toLowerCase(),
  );
}

module.exports = {
  async up(knex) {
    if (await knex.schema.hasTable(RUNS)) return;
    const postgres = isPostgres(knex);

    await knex.schema.createTable(RUNS, (table) => {
      table.uuid("id").primary();
      table.string("trigger", 16).notNullable(); // scheduled | manual
      table.timestamp("schedule_slot", { useTz: true }).nullable();
      table.integer("requested_by_id").nullable();
      table.string("requested_by_label", 255).nullable();
      table.string("note", 200).nullable();
      table.string("status", 16).notNullable().defaultTo("pending");
      table.integer("attempt_count").notNullable().defaultTo(0);
      table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
      table.timestamp("started_at", { useTz: true }).nullable();
      table.timestamp("finished_at", { useTz: true }).nullable();
      table.timestamp("heartbeat_at", { useTz: true }).nullable();
      table.timestamp("locked_at", { useTz: true }).nullable();
      table.string("lock_token", 64).nullable();
      table.string("worker_id", 64).nullable();
      table.timestamp("cancel_requested_at", { useTz: true }).nullable();
      table.string("s3_bucket", 255).nullable();
      table.text("s3_key").nullable();
      table.bigInteger("size_bytes").nullable();
      table.string("sha256", 64).nullable();
      table.string("etag", 255).nullable();
      table.integer("duration_ms").nullable();
      table.string("pg_dump_version", 32).nullable();
      table.string("server_version", 32).nullable();
      table.text("error").nullable();
      table.text("stderr_tail").nullable();
      table.string("verify_state", 16).nullable(); // pending | running | ok | failed
      table.timestamp("verify_requested_at", { useTz: true }).nullable();
      table.timestamp("verified_at", { useTz: true }).nullable();
      table.integer("verify_toc_entries").nullable();
      table.text("verify_error").nullable();
      table.timestamp("deleted_at", { useTz: true }).nullable();
      table.string("deleted_reason", 32).nullable();
      table.index(["status", "created_at"], "database_backup_runs_status_idx");
      table.index(["created_at"], "database_backup_runs_created_idx");
    });

    if (postgres) {
      // Exactly one backup may be pending or running at a time.
      await knex.raw(
        `CREATE UNIQUE INDEX IF NOT EXISTS database_backup_one_active_idx ON ${RUNS} ((1)) ` +
          `WHERE status IN ('pending', 'running')`,
      );
      // A schedule slot is enqueued once; a retry reuses the row.
      await knex.raw(
        `CREATE UNIQUE INDEX IF NOT EXISTS database_backup_slot_idx ON ${RUNS} (schedule_slot) ` +
          `WHERE trigger = 'scheduled' AND schedule_slot IS NOT NULL AND status <> 'cancelled'`,
      );
      await knex.raw(
        `CREATE INDEX IF NOT EXISTS database_backup_verify_idx ON ${RUNS} (verify_state) ` +
          `WHERE verify_state IN ('pending', 'running')`,
      );
    }
  },
};

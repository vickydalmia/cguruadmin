"use strict";

// Verification lease for database_backup_runs (src/database-backup/): the
// verifier heartbeats this column while `pg_restore --list` runs, and the
// runner tick fails a verification whose worker stopped heartbeating (SIGKILL,
// OOM) so the backup can be verified again from the admin. The create
// migration returns early when the table exists, so the column is added here.
const RUNS = "database_backup_runs";
const COLUMN = "verify_heartbeat_at";

module.exports = {
  async up(knex) {
    if (!(await knex.schema.hasTable(RUNS))) return;
    if (await knex.schema.hasColumn(RUNS, COLUMN)) return;
    await knex.schema.alterTable(RUNS, (table) => {
      table.timestamp(COLUMN, { useTz: true }).nullable();
    });
  },
};

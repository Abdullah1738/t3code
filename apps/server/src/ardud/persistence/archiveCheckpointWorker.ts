// Kept in an evaluated worker so bundled builds need no worker file on disk.
// A complete PASSIVE checkpoint (checkpointed === log) syncs the WAL, copies every
// frame into the database file and syncs that file, all with F_FULLFSYNC here, off
// the event loop and off the writer connection.
export const archiveCheckpointWorkerSource = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { statSync } = require('node:fs');
let archive;
parentPort.on('message', ({ id, operation }) => {
  let main;
  let ok = false;
  let failure;
  let checkpoint;
  let truncate;
  try {
    const db = operation === 'flush-main'
      ? (main = new DatabaseSync(workerData.filename))
      : (archive ??= new DatabaseSync(workerData.archiveFilename));
    db.exec('PRAGMA busy_timeout=0; PRAGMA fullfsync=ON; PRAGMA checkpoint_fullfsync=ON;');
    checkpoint = db.prepare('PRAGMA main.wal_checkpoint(PASSIVE)').get();
    ok = checkpoint.busy === 0 && checkpoint.log >= 0 && checkpoint.checkpointed === checkpoint.log;
    // Barriers only need the durable PASSIVE result. Maintenance may also reclaim
    // the high-water file; busy_timeout=0 never waits for readers or an archive copy.
    if (operation === 'maintenance' && ok) {
      truncate = db.prepare('PRAGMA main.wal_checkpoint(TRUNCATE)').get();
    }
  } catch (error) {
    failure = { errcode: error && error.errcode, errstr: error && error.errstr, code: error && error.code };
    ok = false;
  } finally {
    try { main?.close(); } catch { ok = false; }
  }
  const file = operation === "flush-main" ? workerData.filename : workerData.archiveFilename;
  let walBytes;
  try { walBytes = statSync(file + '-wal').size; } catch {}
  parentPort.postMessage({ id, ok, failure, file, checkpoint, truncate, walBytes });
});`;

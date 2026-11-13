// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeZlib from "node:zlib";

interface Backup {
  index: number;
  compressed: boolean;
  bytes: number;
}

/** One compressor at a time; only rotation/maintenance waits for it, never ordinary appends. */
export class CompressedFileSink {
  private readonly backups = new Map<number, Backup>();
  private currentSize = 0;
  private pending: Promise<void> = Promise.resolve();
  private compressing: number | undefined;
  private reservedBytes = 0;
  private appendingBytes = 0;
  private orphanedBytes = 0;
  private warned = false;
  private fileChanges: Promise<void> = Promise.resolve();

  private readonly options: {
    filePath: string;
    maxBytes: number;
    maxFiles: number;
    maxTotalBytes: number;
    platform: NodeJS.Platform;
  };

  constructor(options: CompressedFileSink["options"]) {
    this.options = options;
  }

  private filename(index: number, compressed = false) {
    return `${this.options.filePath}.${index}${compressed ? ".gz" : ""}`;
  }

  async initialize() {
    const directory = NodePath.dirname(this.options.filePath);
    const prefix = `${NodePath.basename(this.options.filePath)}.`;
    await NodeFSP.mkdir(directory, { recursive: true });
    for (const entry of await NodeFSP.readdir(directory)) {
      if (!entry.startsWith(prefix)) continue;
      const match = /^(\d+)(\.gz)?(\.tmp)?$/.exec(entry.slice(prefix.length));
      if (!match || Number(match[1]) < 1) continue;
      const index = Number(match[1]);
      const file = NodePath.join(directory, entry);
      if (match[3] || index > this.options.maxFiles) {
        await NodeFSP.rm(file, { force: true });
        continue;
      }
      const compressed = Boolean(match[2]);
      // A plain source survives until gzip is durable. After a crash it is authoritative.
      if (
        compressed &&
        (await NodeFSP.stat(this.filename(index)).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return false;
            throw error;
          },
        ))
      ) {
        await NodeFSP.rm(file, { force: true });
        continue;
      }
      this.backups.set(index, { index, compressed, bytes: (await NodeFSP.stat(file)).size });
    }
    this.currentSize = await NodeFSP.stat(this.options.filePath).then(
      (s) => s.size,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return 0;
        throw error;
      },
    );
    if (this.currentSize > this.options.maxBytes) await this.rotate();
    await this.prune(0);
    this.pending = this.compress(
      [...this.backups.values()].filter((b) => !b.compressed).map((b) => b.index),
    );
  }

  // Keep each archive's filename and accounting entry together across filesystem awaits.
  private withFileChanges<A>(operation: () => Promise<A>): Promise<A> {
    const result = this.fileChanges.then(operation);
    this.fileChanges = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private prune(additionalBytes: number) {
    return this.withFileChanges(() => this.pruneUnlocked(additionalBytes));
  }

  private async pruneUnlocked(additionalBytes: number) {
    const total = () =>
      this.currentSize +
      this.appendingBytes +
      this.reservedBytes +
      this.orphanedBytes +
      additionalBytes +
      [...this.backups.values()].reduce((sum, b) => sum + b.bytes, 0);
    for (const backup of [...this.backups.values()].sort((a, b) => b.index - a.index)) {
      if (total() <= this.options.maxTotalBytes) return;
      if (backup.index === this.compressing) continue;
      await NodeFSP.rm(this.filename(backup.index, backup.compressed), { force: true });
      this.backups.delete(backup.index);
    }
    if (total() > this.options.maxTotalBytes) throw new Error("Trace byte budget exhausted");
  }

  private async compress(indices: number[]) {
    for (const index of indices) {
      const source = this.filename(index);
      const target = this.filename(index, true);
      const temporary = `${target}.tmp`;
      try {
        const present = await this.withFileChanges(async () => {
          const backup = this.backups.get(index);
          if (!backup || backup.compressed) return false;
          this.compressing = index;
          // gzip can expand incompressible input. Reserve before creating scratch bytes.
          this.reservedBytes = backup.bytes + Math.ceil(backup.bytes / 100) + 1024;
          await this.pruneUnlocked(0);
          return true;
        });
        if (!present) continue;
        const gzip = NodeZlib.createGzip({ level: 6 });
        await NodeStreamPromises.pipeline(
          NodeFS.createReadStream(source),
          gzip,
          NodeFS.createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
        );
        const handle = await NodeFSP.open(temporary, "r+");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        const bytes = (await NodeFSP.stat(temporary)).size;
        await this.withFileChanges(async () => {
          await NodeFSP.rename(temporary, target);
          // Persist the directory entry before removing the only other copy.
          if (this.options.platform !== "win32") {
            const directory = await NodeFSP.open(NodePath.dirname(source), "r");
            try {
              await directory.sync();
            } finally {
              await directory.close();
            }
          }
          await NodeFSP.rm(source);
          this.backups.set(index, { index, compressed: true, bytes });
          this.compressing = undefined;
          this.reservedBytes = 0;
        });
      } catch {
        await this.withFileChanges(async () => {
          const removedScratch = await NodeFSP.rm(temporary, { force: true }).then(
            () => true,
            () => false,
          );
          // A failed gzip never replaces its plain source.
          const removedTarget = await NodeFSP.rm(target, { force: true }).then(
            () => true,
            () => false,
          );
          if (!removedScratch || !removedTarget) this.orphanedBytes += this.reservedBytes;
          this.compressing = undefined;
          this.reservedBytes = 0;
          if (!this.warned) {
            this.warned = true;
            process.stderr.write(
              `Trace backup compression failed; keeping plain backup: ${source}\n`,
            );
          }
        });
      }
    }
  }

  private async rotate() {
    await this.pending;
    const oldest = this.backups.get(this.options.maxFiles);
    if (oldest) {
      await NodeFSP.rm(this.filename(oldest.index, oldest.compressed), { force: true });
      this.backups.delete(oldest.index);
    }
    for (const backup of [...this.backups.values()].sort((a, b) => b.index - a.index)) {
      await NodeFSP.rename(
        this.filename(backup.index, backup.compressed),
        this.filename(backup.index + 1, backup.compressed),
      );
      this.backups.delete(backup.index);
      this.backups.set(backup.index + 1, { ...backup, index: backup.index + 1 });
    }
    await NodeFSP.rename(this.options.filePath, this.filename(1));
    this.backups.set(1, { index: 1, compressed: false, bytes: this.currentSize });
    this.currentSize = 0;
  }

  async write(buffer: Buffer) {
    if (buffer.length === 0) return;
    if (buffer.length > this.options.maxBytes) throw new Error("Trace chunk exceeds rotation size");
    if (this.currentSize > 0 && this.currentSize + buffer.length > this.options.maxBytes) {
      await this.rotate();
      this.pending = this.compress([1]);
    }
    // Startup can compress several sources while an append is in flight.
    this.appendingBytes = buffer.length;
    try {
      await this.prune(0);
      await NodeFSP.appendFile(this.options.filePath, buffer);
      this.currentSize += buffer.length;
    } catch (error) {
      this.currentSize = (await NodeFSP.stat(this.options.filePath)).size;
      throw error;
    } finally {
      this.appendingBytes = 0;
    }
  }

  async flush() {
    await this.pending;
  }
}

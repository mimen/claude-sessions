import { chmodSync, renameSync, rmSync, writeFileSync } from "node:fs";

let atomicWriteSequence = 0;

/** Write through a private temporary file so a reader never sees a half-written artifact. */
export function atomicWriteFile(path: string, contents: string | Uint8Array, mode: number): void {
  const temporary = `${path}.tmp-${process.pid}-${atomicWriteSequence++}`;
  try {
    writeFileSync(temporary, contents, { mode, flag: "wx" });
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

import {
  mkdir,
  writeFile,
  readFile,
  rename,
  link,
  unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { canonical, sha256, normalizePath } from "./integrity.js";
export interface ArtifactRef {
  id: string;
  sha256: string;
  media_type: string;
}
export class EvidenceStore {
  constructor(readonly root: string) {}
  private async publish(path: string, data: Uint8Array | string) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, data, { flag: "wx", mode: 0o600 });
      // Publish only complete bytes, without replacing any immutable identity.
      await link(temporary, path);
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
  async put(
    data: Uint8Array | string,
    media_type = "application/octet-stream",
  ): Promise<ArtifactRef> {
    const hash = sha256(data);
    const path = join(this.root, "objects", hash);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      await this.publish(path, data);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (sha256(await readFile(path)) !== hash)
        throw new Error("Existing evidence integrity failure");
    }
    return { id: hash, sha256: hash, media_type };
  }
  async putJson(data: unknown): Promise<ArtifactRef> {
    return this.put(canonical(data), "application/json");
  }
  async read(ref: ArtifactRef): Promise<Buffer> {
    if (!/^[a-f0-9]{64}$/.test(ref.id))
      throw new Error("Invalid artifact identity");
    const bytes = await readFile(join(this.root, "objects", ref.id));
    if (sha256(bytes) !== ref.sha256)
      throw new Error("Artifact integrity failure");
    return bytes;
  }
  async readJson<T = unknown>(ref: ArtifactRef): Promise<T> {
    return JSON.parse((await this.read(ref)).toString()) as T;
  }
  async immutable(name: string, value: unknown): Promise<void> {
    normalizePath(name);
    const path = join(this.root, name);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const body = canonical(value);
    try {
      await this.publish(path, body);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if ((await readFile(path, "utf8")) !== body)
        throw new Error(`Refusing to overwrite immutable evidence: ${name}`);
    }
  }
  async state<T>(name: string): Promise<T | null> {
    normalizePath(name);
    try {
      return JSON.parse(await readFile(join(this.root, name), "utf8")) as T;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  async saveState(name: string, value: unknown): Promise<void> {
    normalizePath(name);
    const path = join(this.root, name);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, canonical(value), { mode: 0o600 });
    await rename(tmp, path);
  }
}

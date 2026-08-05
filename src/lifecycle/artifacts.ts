import fs from "node:fs";
import path from "node:path";

import { sanitizeWorkSlug, type FabricArtifactName } from "./store.js";

const ALLOWED_ARTIFACTS = new Set<FabricArtifactName>(["research", "spec", "plan", "progress", "impact"]);
const MAX_ARTIFACT_BYTES = 256 * 1024;

export interface ArtifactAdapter {
  write(slug: string, name: FabricArtifactName, content: string): string;
  read(slug: string, name: FabricArtifactName): string | undefined;
  resolve(slug: string, name: FabricArtifactName): string;
}

export class FileArtifactAdapter implements ArtifactAdapter {
  readonly #root: string;

  constructor(root: string) {
    this.#root = path.resolve(root);
  }

  resolve(slug: string, name: FabricArtifactName): string {
    const cleanSlug = sanitizeWorkSlug(slug);
    if (!ALLOWED_ARTIFACTS.has(name)) {
      throw new Error(`Unsupported artifact name: ${name}`);
    }
    const dir = path.resolve(this.#root, cleanSlug);
    if (!dir.startsWith(this.#root + path.sep) && dir !== this.#root) {
      throw new Error(`Artifact directory escapes the artifact root`);
    }
    return path.join(dir, `${name}.md`);
  }

  write(slug: string, name: FabricArtifactName, content: string): string {
    const filePath = this.resolve(slug, name);
    const bounded = content.length > MAX_ARTIFACT_BYTES
      ? content.slice(0, MAX_ARTIFACT_BYTES)
      : content;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, bounded, { encoding: "utf8" });
    return filePath;
  }

  read(slug: string, name: FabricArtifactName): string | undefined {
    const filePath = this.resolve(slug, name);
    if (!fs.existsSync(filePath)) return undefined;
    return fs.readFileSync(filePath, "utf8");
  }
}
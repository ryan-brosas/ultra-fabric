import fs from "node:fs";
import path from "node:path";

export const assertNewOutputPath = (target) => {
  if (!path.isAbsolute(target)) throw new Error("--output path must be absolute");
  if (fs.existsSync(target)) throw new Error(`output already exists: ${target}`);
  const parent = path.dirname(target);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    throw new Error(`output directory does not exist: ${parent}`);
  }
};

export const writeNewOutput = (target, content) => {
  assertNewOutputPath(target);
  const parent = path.dirname(target);
  const temporary = path.join(
    parent,
    `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.linkSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
};

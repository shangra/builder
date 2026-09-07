import fs from 'node:fs/promises';
import path from 'node:path';
import { pathExists } from './fs-utils.js';

export async function assembleArtifacts(packages, outputRoot, { dryRun = false } = {}) {
  const copied = [];
  const missing = [];

  if (!dryRun) {
    await fs.mkdir(outputRoot, { recursive: true });
  }

  for (const pkg of packages) {
    if (!pkg.ok) {
      continue;
    }

    let copiedForPkg = false;
    for (const artifact of pkg.artifacts || []) {
      const from = path.resolve(pkg.absDir, artifact);
      if (!(await pathExists(from))) {
        continue;
      }
      const to = path.join(outputRoot, pkg.id, artifact);
      if (!dryRun) {
        await fs.cp(from, to, { recursive: true, force: true });
      }
      copied.push({ id: pkg.id, from, to });
      copiedForPkg = true;
    }

    if (!copiedForPkg && (pkg.artifacts || []).length > 0) {
      missing.push({
        id: pkg.id,
        artifacts: pkg.artifacts,
      });
    }
  }

  return { copied, missing };
}

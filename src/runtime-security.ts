// Imported first by the CLI entry point: refuse an unpatched Node.js before any other module runs.
import { isSecureNodeVersion, nodeVersionError } from './security-versions.js';
if (!isSecureNodeVersion(process.versions.node)) {
  process.stderr.write(`${nodeVersionError(process.versions.node)}\n`);
  process.exit(1);
}

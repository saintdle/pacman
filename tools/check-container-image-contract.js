import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function validateContainerImageContract({
  dockerfile = fs.readFileSync(path.join(repoRoot, 'docker/Dockerfile'), 'utf8'),
  compose = fs.readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8'),
} = {}) {
  const issues = [];
  const failUnless = (condition, message) => {
    if (!condition) issues.push(message);
  };

  const fromMatches = [...dockerfile.matchAll(/^FROM\s+(\S+)(?:\s+AS\s+\S+)?\s*$/gm)];
  const finalFrom = fromMatches.at(-1)?.[1] ?? '';
  const runtimeStart = fromMatches.at(-1)?.index ?? -1;
  const runtime = runtimeStart < 0 ? '' : dockerfile.slice(runtimeStart);
  const buildBases = fromMatches.slice(0, -1).map((match) => match[1]);
  const entrypointMatch = runtime.match(/^ENTRYPOINT\s+(\[[^\n]+\])$/m);
  const commandMatch = runtime.match(/^CMD\s+(\[[^\n]+\])$/m);
  const healthcheckMatch = runtime.match(/^HEALTHCHECK\b[^\n]*$/m);
  const entrypoint = entrypointMatch ? JSON.parse(entrypointMatch[1]) : [];
  const command = commandMatch ? JSON.parse(commandMatch[1]) : [];
  const healthcheckCommand = healthcheckMatch?.[0].match(/\bCMD\s+(\[[^\n]+\])$/)?.[1];
  const healthcheck = healthcheckCommand ? JSON.parse(healthcheckCommand) : [];

  failUnless(buildBases.some((base) => /^node:22-trixie-slim(?:@|$)/.test(base)), 'the build must use Node 22 on Debian 13 so native dependencies share glibc with the runtime');
  failUnless(/^gcr\.io\/distroless\/nodejs22-debian13(?::\S+)?$/.test(finalFrom), 'the final image must use the Debian 13 distroless Node runtime');
  failUnless(/:nonroot$/.test(finalFrom), 'the final distroless image must select its nonroot variant');
  failUnless(/PATH=["']?\/nodejs\/bin:/.test(runtime), 'the runtime PATH must resolve the distroless Node binary by name');
  failUnless(entrypoint.length > 0 && /(?:^|\/)node$/.test(entrypoint[0]), 'the runtime entrypoint must invoke Node directly');
  failUnless(command.some((arg) => /(?:^|\/)src\/server\.js$/.test(arg)), 'the default command must launch the application server');
  failUnless(healthcheck.length > 0 && /(?:^|\/)node$/.test(healthcheck[0]) && healthcheck.some((arg) => /healthcheck\.js$/.test(arg)), 'the healthcheck must use an exec-form Node command');
  failUnless(!/\bCMD-SHELL\b/i.test(healthcheckMatch?.[0] ?? ''), 'the healthcheck must not invoke a shell');
  failUnless(!/^RUN\b/m.test(runtime), 'the distroless runtime must not run installation or shell commands');
  failUnless(!/\b(?:npm|npx|wget|curl|bash|sh)\b/i.test(runtime), 'the distroless runtime must not reference shell, package, or network tools');
  const user = runtime.match(/^USER\s+(\d+)(?::\d+)?$/m)?.[1];
  failUnless(Number(user) > 0, 'the image must default to a nonroot numeric UID');
  failUnless(fs.existsSync(path.join(repoRoot, 'demo-fixtures/synthetic-secret.txt')), 'the synthetic secret fixture must exist in the build context');
  failUnless(fs.existsSync(path.join(repoRoot, 'tools/demo-exec-probe.js')), 'the fixed exec probe script must exist in the build context');
  const migrationService = compose.match(/^\x20{2}postgres-migrate:\n((?:^\x20{4}.*\n|^\s*\n)*)/m)?.[1] ?? '';
  failUnless(/entrypoint:\s*\[[^\]]*node[^\]]*\]/.test(migrationService), 'the Compose migration service must invoke Node directly');
  failUnless(/command:\s*\[[^\]]*src\/db\/migrate\.js[^\]]*\]/.test(migrationService), 'the Compose migration service must launch the migration script');

  return issues;
}

function main() {
  const issues = validateContainerImageContract();
  if (issues.length > 0) {
    console.error(`Container image contract failed:\n${issues.map((issue) => `- ${issue}`).join('\n')}`);
    process.exitCode = 1;
    return;
  }
  console.log('Container image contract passed.');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main();

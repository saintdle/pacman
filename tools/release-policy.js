import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const requiredGates = ['lint', 'unit', 'mongo', 'postgres'];
const versionPattern = /^(\d+)\.(\d+)\.(\d+)$/;

function parseVersion(value, source) {
  const match = versionPattern.exec(value ?? '');
  if (!match) throw new Error(`${source} must use MAJOR.MINOR.PATCH format: ${value}`);
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export function verifyReleaseDigest(recordedDigest, imageDigest) {
  const digestPattern = /^sha256:[a-f0-9]{64}$/;
  if (!digestPattern.test(recordedDigest ?? '') || !digestPattern.test(imageDigest ?? '')
    || recordedDigest !== imageDigest) {
    throw new Error(`Immutable release digest mismatch: recorded ${recordedDigest}, found ${imageDigest}`);
  }
  return imageDigest;
}

function validationPassed(validation) {
  if (typeof validation === 'string') return validation === 'success';
  return requiredGates.every((gate) => validation?.[gate] === 'success');
}

function parseExistingRelease(value) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error(`existing release flag must be true or false: ${value}`);
}

function parseAppReleaseEligibility(value) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error(`app release eligibility must be true or false: ${value}`);
}

function releasePolicy(input) {
  const noEffects = { verifyImage: false, publish: false, createRelease: false, dispatch: false };
  if (!validationPassed(input.validation)) return noEffects;
  if (!parseAppReleaseEligibility(input.appReleaseEligible)) return noEffects;

  const existingRelease = parseExistingRelease(input.existingRelease);
  const version = parseVersion(input.version, 'release version');

  if (!existingRelease) {
    return { verifyImage: true, publish: true, createRelease: true, dispatch: true };
  }

  const latestRelease = parseVersion(input.latestRelease, 'latest release');
  if (input.recordedDigest !== undefined || input.imageDigest !== undefined) {
    verifyReleaseDigest(input.recordedDigest, input.imageDigest);
  }

  return {
    verifyImage: true,
    publish: false,
    createRelease: false,
    dispatch: compareVersions(version, latestRelease) >= 0,
  };
}

export async function executeReleasePolicy(input, effects = {}) {
  const plan = releasePolicy(input);
  if (!plan.verifyImage) return plan;

  if (plan.publish) await effects.publish?.();
  if (plan.verifyImage) await effects.verifyImage?.();
  if (plan.createRelease) await effects.createRelease?.();
  if (plan.dispatch) await effects.dispatch?.();

  return plan;
}

async function main() {
  if (process.argv[2] === 'verify-digest') {
    verifyReleaseDigest(process.argv[3], process.argv[4]);
    return;
  }

  const requestedEffects = [];
  const plan = await executeReleasePolicy({
    validation: process.env.RELEASE_VALIDATION_RESULT,
    appReleaseEligible: process.env.APP_RELEASE_ELIGIBLE,
    existingRelease: process.env.EXISTING_RELEASE,
    version: process.env.RELEASE_VERSION,
    latestRelease: process.env.LATEST_RELEASE,
  }, {
    verifyImage: () => requestedEffects.push('verify-image'),
    publish: () => requestedEffects.push('publish'),
    createRelease: () => requestedEffects.push('create-release'),
    dispatch: () => requestedEffects.push('dispatch'),
  });

  const output = {
    verify_image: String(requestedEffects.includes('verify-image')),
    publish: String(requestedEffects.includes('publish')),
    create_release: String(requestedEffects.includes('create-release')),
    dispatch: String(requestedEffects.includes('dispatch')),
  };

  for (const [name, value] of Object.entries(output)) {
    if (process.env.GITHUB_OUTPUT) {
      await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
    } else {
      console.log(`${name}=${value}`);
    }
  }

  if (!validationPassed(process.env.RELEASE_VALIDATION_RESULT)) {
    console.log('Release effects are blocked because same-SHA validation did not succeed.');
  }
  if (plan.verifyImage && !plan.dispatch && process.env.EXISTING_RELEASE === 'true') {
    console.log(`Skipping chart dispatch for older replay ${process.env.RELEASE_VERSION}; latest is ${process.env.LATEST_RELEASE}.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();

import { pathToFileURL } from 'node:url';

const repositoryPattern = /^docker\.io\/([a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+)$/;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const acceptedManifestTypes = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

function failClosed(message) {
  return new Error(`${message}; refusing release publication`);
}

function parseReleaseImage(imageName, version) {
  const repositoryMatch = repositoryPattern.exec(imageName ?? '');
  if (!repositoryMatch) {
    throw failClosed('IMAGE_NAME must be a Docker Hub image such as docker.io/owner/repository');
  }
  if (!versionPattern.test(version ?? '')) {
    throw failClosed(`VERSION_TAG must be canonical MAJOR.MINOR.PATCH: ${version}`);
  }
  return repositoryMatch[1];
}

async function request(fetchImpl, url, options, description) {
  try {
    return await fetchImpl(url, options);
  } catch {
    throw failClosed(`Docker Hub ${description} request failed`);
  }
}

async function getPullToken(repository, username, password, fetchImpl) {
  if (!username || !password) {
    throw failClosed('Docker Hub pull credentials are unavailable');
  }

  const tokenUrl = new URL('https://auth.docker.io/token');
  tokenUrl.searchParams.set('service', 'registry.docker.io');
  tokenUrl.searchParams.set('scope', `repository:${repository}:pull`);
  const basicAuth = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
  const response = await request(fetchImpl, tokenUrl, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Basic ${basicAuth}`,
    },
    redirect: 'error',
  }, 'token');

  if (response.status !== 200) {
    throw failClosed(`Docker Hub token request returned HTTP ${response.status}`);
  }

  let tokenResponse;
  try {
    tokenResponse = await response.json();
  } catch {
    throw failClosed('Docker Hub token response was not valid JSON');
  }

  const token = tokenResponse?.token ?? tokenResponse?.access_token;
  if (typeof token !== 'string' || token.length === 0) {
    throw failClosed('Docker Hub token response did not contain a bearer token');
  }
  return token;
}

export async function inspectDockerHubReleaseTag({
  imageName,
  version,
  username,
  password,
  fetchImpl = globalThis.fetch,
} = {}) {
  const repository = parseReleaseImage(imageName, version);
  if (typeof fetchImpl !== 'function') throw failClosed('Fetch is unavailable for Docker Hub verification');

  const token = await getPullToken(repository, username, password, fetchImpl);
  const encodedRepository = repository.split('/').map(encodeURIComponent).join('/');
  const manifestUrl = new URL(
    `https://registry-1.docker.io/v2/${encodedRepository}/manifests/${encodeURIComponent(version)}`,
  );
  const response = await request(fetchImpl, manifestUrl, {
    method: 'HEAD',
    headers: {
      Accept: acceptedManifestTypes,
      Authorization: `Bearer ${token}`,
    },
    redirect: 'manual',
  }, 'manifest');

  if (response.status === 404) return { exists: false };
  if (response.status === 200) return { exists: true };
  throw failClosed(`Docker Hub manifest request returned HTTP ${response.status}; tag availability is unknown`);
}

export async function assertReleaseImageTagAbsent(options) {
  const { imageName, version } = options ?? {};
  const result = await inspectDockerHubReleaseTag(options);
  if (result.exists) {
    throw failClosed(`Docker Hub already contains ${imageName}:${version}`);
  }
  return result;
}

async function main() {
  const imageName = process.env.IMAGE_NAME;
  const version = process.env.VERSION_TAG;
  await assertReleaseImageTagAbsent({
    imageName,
    version,
    username: process.env.DOCKERHUB_USERNAME,
    password: process.env.DOCKERHUB_TOKEN,
  });
  console.log(`Verified Docker Hub image tag ${imageName}:${version} is absent.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

const validAuthorities = new Set(['helm-charts', 'pacman']);
const variableName = 'PACMAN_CHART_PUBLISHER_AUTHORITY';

function fail(message) {
  throw new Error(message);
}

export function normalizeChartPublisherAuthority(value) {
  const authority = value === undefined || value === null || value === '' ? 'helm-charts' : value;
  if (!validAuthorities.has(authority)) fail(`${variableName} must be either helm-charts or pacman`);
  return authority;
}

export async function readDistributionChartPublisherAuthority({ token, fetch: fetchRequest = fetch }) {
  if (!token) fail('RELEASE_AUTOMATION_TOKEN is required to read helm-charts publisher authority');
  const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    };
  const capability = await fetchRequest('https://api.github.com/repos/saintdle/helm-charts/actions/variables?per_page=1', { headers });
  if (!capability.ok) fail(`could not verify helm-charts Actions variables read access: HTTP ${capability.status}`);
  const response = await fetchRequest(`https://api.github.com/repos/saintdle/helm-charts/actions/variables/${variableName}`, { headers });
  if (response.status === 404) return 'helm-charts';
  if (!response.ok) fail(`could not read helm-charts ${variableName}: HTTP ${response.status}`);
  return normalizeChartPublisherAuthority((await response.json()).value);
}

async function main() {
  const token = process.env.RELEASE_AUTOMATION_TOKEN;
  const authority = await readDistributionChartPublisherAuthority({ token });
  const active = authority === 'pacman';
  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(output, `active=${active}\n`);
  }
  console.log(active ? 'Pac-Man chart source is active.' : 'helm-charts remains the active chart source.');
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

import { Router } from 'express';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { logger } from '../logger.js';

const REQUEST_TIMEOUT_MS = 1500;
const SERVICE_ACCOUNT_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

function request(client, options, { body } = {}) {
  return new Promise((resolve, reject) => {
    const req = client.request(options, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`status ${res.statusCode}`));
        return;
      }
      res.setEncoding('utf8');
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(chunks.join('')));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}

async function getAWS() {
  const text = await request(http, {
    hostname: '169.254.169.254',
    port: 80,
    path: '/latest/meta-data/placement/availability-zone',
    method: 'GET',
    timeout: REQUEST_TIMEOUT_MS,
  });
  const parts = text.split('/');
  return { cloud: 'AWS', zone: parts[parts.length - 1].toLowerCase() };
}

async function getAzure() {
  const text = await request(http, {
    hostname: '169.254.169.254',
    port: 80,
    path: '/metadata/instance/compute/location?api-version=2017-04-02&format=text',
    method: 'GET',
    timeout: REQUEST_TIMEOUT_MS,
    headers: { Metadata: 'true' },
  });
  return { cloud: 'Azure', zone: text.toLowerCase() };
}

async function getGCP() {
  const text = await request(http, {
    hostname: 'metadata.google.internal',
    port: 80,
    path: '/computeMetadata/v1/instance/zone',
    method: 'GET',
    timeout: REQUEST_TIMEOUT_MS,
    headers: { 'Metadata-Flavor': 'Google' },
  });
  const parts = text.split('/');
  return { cloud: 'GCP', zone: parts[parts.length - 1].toLowerCase() };
}

async function getOpenStack() {
  const text = await request(http, {
    hostname: '169.254.169.254',
    port: 80,
    path: '/openstack/latest/meta_data.json',
    method: 'GET',
    timeout: REQUEST_TIMEOUT_MS,
  });
  const meta = JSON.parse(text);
  let cloud = 'OpenStack';
  if (meta.meta?.clusterid) cloud += ` - ${meta.meta.clusterid.split('.')[0]}`;
  return { cloud, zone: meta.availability_zone ?? 'unknown' };
}

function serviceSelectsPod(service, podLabels) {
  const selector = service.spec?.selector;
  if (!selector || Object.keys(selector).length === 0) return false;
  return Object.entries(selector).every(([key, value]) => podLabels?.[key] === value);
}

function topologyModeForService(service) {
  const annotations = service.metadata?.annotations ?? {};
  return annotations['service.kubernetes.io/topology-mode'] ?? annotations['service.kubernetes.io/topology-aware-hints'];
}

function topologyZonesForEndpointSlices(endpointSlices) {
  const zones = new Set();
  for (const slice of endpointSlices.items ?? []) {
    for (const endpoint of slice.endpoints ?? []) {
      for (const zone of endpoint.hints?.forZones ?? []) {
        if (zone.name) zones.add(zone.name);
      }
    }
  }
  return [...zones].sort();
}

async function k8sGet(path, credentials) {
  const text = await request(https, {
    host: 'kubernetes.default.svc',
    port: 443,
    path,
    method: 'GET',
    timeout: REQUEST_TIMEOUT_MS,
    ca: credentials.ca,
    headers: { Authorization: `Bearer ${credentials.token.trim()}` },
  });
  return JSON.parse(text);
}

async function getK8sCredentials() {
  const [token, ca, namespace] = await Promise.all([
    readFile(`${SERVICE_ACCOUNT_DIR}/token`, 'utf8'),
    readFile(`${SERVICE_ACCOUNT_DIR}/ca.crt`),
    readFile(`${SERVICE_ACCOUNT_DIR}/namespace`, 'utf8'),
  ]);
  return { token, ca, namespace: namespace.trim() };
}

async function getTopologyAwareRoutingZone(credentials, nodeZone) {
  const podName = process.env.HOSTNAME;
  if (!podName) return null;

  try {
    const namespace = credentials.namespace;
    const pod = await k8sGet(`/api/v1/namespaces/${namespace}/pods/${podName}`, credentials);
    const podLabels = pod.metadata?.labels ?? {};
    const services = await k8sGet(`/api/v1/namespaces/${namespace}/services`, credentials);
    const selectedServices = (services.items ?? []).filter((service) => serviceSelectsPod(service, podLabels));

    for (const service of selectedServices) {
      const mode = topologyModeForService(service);
      if (mode) {
        return `topology-aware ${mode.toLowerCase()} (${nodeZone})`;
      }
    }

    for (const service of selectedServices) {
      const serviceName = service.metadata?.name;
      if (!serviceName) continue;
      const endpointSlices = await k8sGet(
        `/apis/discovery.k8s.io/v1/namespaces/${namespace}/endpointslices?labelSelector=kubernetes.io%2Fservice-name%3D${encodeURIComponent(serviceName)}`,
        credentials,
      );
      const zones = topologyZonesForEndpointSlices(endpointSlices);
      if (zones.length > 0) {
        return `topology-aware zones: ${zones.join(', ')}`;
      }
    }
  } catch (err) {
    logger.debug({ err: err.message }, 'kubernetes topology-aware routing probe failed');
  }

  return null;
}

async function getK8s() {
  const nodeName = process.env.MY_NODE_NAME;
  if (!nodeName) throw new Error('MY_NODE_NAME not set');
  const credentials = await getK8sCredentials();
  const meta = await k8sGet(`/api/v1/nodes/${nodeName}`, credentials);
  const providerID = meta.spec?.providerID ?? '';
  const nodeZone =
    meta.metadata?.labels?.['topology.kubernetes.io/zone'] ??
    meta.metadata?.labels?.['failure-domain.beta.kubernetes.io/zone'] ??
    'unknown';
  const zone = (await getTopologyAwareRoutingZone(credentials, nodeZone)) ?? nodeZone;
  const cloud = providerID.split(':')[0] || 'kubernetes';
  return { cloud, zone };
}

async function detectCloud() {
  const probes = [getK8s, getAWS, getAzure, getGCP, getOpenStack];
  for (const probe of probes) {
    try {
      return await probe();
    } catch (err) {
      logger.debug({ probe: probe.name, err: err.message }, 'cloud probe failed');
    }
  }
  return { cloud: 'unknown', zone: 'unknown' };
}

export function locationRouter() {
  const router = Router();

  router.get('/metadata', async (_req, res, next) => {
    try {
      const { cloud, zone } = await detectCloud();
      res.json({ cloud, zone, host: os.hostname() });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export default locationRouter;

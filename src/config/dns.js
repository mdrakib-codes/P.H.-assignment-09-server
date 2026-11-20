import dns from 'node:dns';
import { env } from './env.js';
import { redactSecrets } from '../utils/redact.js';

export const configureDns = ({
  dnsModule = dns,
  servers = env.mongodbDnsServers
} = {}) => {
  if (servers.length === 0) {
    return false;
  }

  try {
    dnsModule.setServers(servers);
  } catch (error) {
    throw new Error(
      `Failed to configure MongoDB DNS resolvers: ${redactSecrets(error?.message || error)}`
    );
  }

  return true;
};

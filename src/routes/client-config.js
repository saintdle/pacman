import { config } from '../config/index.js';

export function getClientConfig() {
  return {
    maxLevel: config.MAX_LEVEL,
    allowClientOverride: config.ALLOW_CLIENT_CONFIG_OVERRIDE,
    ebeeMode: config.EBEE_MODE,
    allowEbeeModeOverride: config.ALLOW_CLIENT_EBEE_MODE_OVERRIDE,
    appRole: config.APP_ROLE,
    appVersion: config.APP_VERSION,
    appVariant: config.APP_VARIANT,
    appColor: config.APP_COLOR,
    liveStatsPageSize: config.LIVE_STATS_PAGE_SIZE,
    simulatedUsersEnabled: config.SIMULATED_USERS_ENABLED,
  };
}

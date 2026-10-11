import { API } from 'homebridge';
import { PLATFORM_NAME } from './settings';
import { Phidget22Platform } from './platform';

export default (api: API) => {
  api.registerPlatform(PLATFORM_NAME, Phidget22Platform);
};

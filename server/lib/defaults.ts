/* Default settings for an empty workspace (same values as the client's T.defaultSettings()). */
import vm from 'node:vm';
import { STORE_SRC } from './generated/client';

function compute() {
  const ctx = vm.createContext({ window: {}, console });
  vm.runInContext(STORE_SRC, ctx);
  return JSON.parse(vm.runInContext('JSON.stringify(window.T360.defaultSettings())', ctx));
}
export const SETTINGS_DEFAULT = compute();

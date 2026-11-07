import path from 'node:path';
import os from 'node:os';
export function helperHome(env = process.env) {
  if (env.SHIYE_HOME) return path.resolve(env.SHIYE_HOME);
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Shiye');
  if (process.platform === 'win32') return path.join(env.LOCALAPPDATA || os.homedir(), 'Shiye');
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'shiye');
}

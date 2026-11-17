// @ts-check

const { homedir } = require('node:os');
const { isAbsolute, join } = require('node:path');

const getConfigDir = () =>
  process.env.CODIFF_CONFIG_DIR ||
  (process.env.XDG_CONFIG_HOME && isAbsolute(process.env.XDG_CONFIG_HOME)
    ? join(process.env.XDG_CONFIG_HOME, 'codiff')
    : join(homedir(), '.codiff'));

module.exports = { getConfigDir };

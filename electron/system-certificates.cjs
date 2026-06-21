// @ts-check

const tls = require('node:tls');

/**
 * @typedef {{reason?: string; status: 'applied' | 'empty-system' | 'failed' | 'unavailable'}} CertificateTrustStatus
 */

/** @param {unknown} error */
const getErrorMessage = (error) => (error instanceof Error ? error.message : String(error));

/**
 * @param {{
 *   getCACertificates?: (source?: string) => Array<string>;
 *   setDefaultCACertificates?: (certificates: Array<string>) => void;
 * }} tlsImpl
 */
const createSystemCertificateTrust = (tlsImpl = tls) => {
  let initialized = false;

  /** @param {'default' | 'extra' | 'system'} source */
  const readCertificates = (source) => {
    try {
      return {
        certificates:
          typeof tlsImpl.getCACertificates === 'function' ? tlsImpl.getCACertificates(source) : [],
        error: '',
      };
    } catch (error) {
      return { certificates: [], error: getErrorMessage(error) };
    }
  };

  /** @returns {CertificateTrustStatus} */
  return () => {
    if (initialized) {
      return { status: 'applied' };
    }

    if (
      typeof tlsImpl.getCACertificates !== 'function' ||
      typeof tlsImpl.setDefaultCACertificates !== 'function'
    ) {
      return {
        reason: 'this Node/Electron runtime does not expose system certificate APIs',
        status: 'unavailable',
      };
    }

    const defaultCertificates = readCertificates('default');
    const extraCertificates = readCertificates('extra');
    const systemCertificates = readCertificates('system');
    const readError = [defaultCertificates, extraCertificates, systemCertificates].find(
      ({ error }) => error,
    )?.error;
    if (readError) {
      return { reason: readError, status: 'failed' };
    }

    if (systemCertificates.certificates.length === 0) {
      return { reason: 'the system certificate store was empty', status: 'empty-system' };
    }

    try {
      tlsImpl.setDefaultCACertificates([
        ...new Set([
          ...defaultCertificates.certificates,
          ...extraCertificates.certificates,
          ...systemCertificates.certificates,
        ]),
      ]);
    } catch (error) {
      return { reason: getErrorMessage(error), status: 'failed' };
    }

    initialized = true;
    return { status: 'applied' };
  };
};

const trustSystemCertificates = createSystemCertificateTrust();

module.exports = {
  createSystemCertificateTrust,
  trustSystemCertificates,
};

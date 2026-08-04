// @ts-check

const namedEntities = new Map([
  ['amp', '&'],
  ['apos', "'"],
  ['gt', '>'],
  ['lt', '<'],
  ['nbsp', '\u00a0'],
  ['quot', '"'],
]);

/** Decode ordinary entity references as text without interpreting HTML. @param {string} value */
const decodeHtmlEntities = (value) =>
  value.replaceAll(
    /&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z][a-z0-9]+));/gi,
    (match, decimal, hex, name) => {
      const codePoint = decimal
        ? Number.parseInt(decimal, 10)
        : hex
          ? Number.parseInt(hex, 16)
          : null;
      if (codePoint != null) {
        try {
          return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
        } catch {
          return match;
        }
      }
      return namedEntities.get(String(name).toLowerCase()) ?? match;
    },
  );

module.exports = { decodeHtmlEntities };

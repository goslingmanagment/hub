/** Characters removed by ECMAScript String.prototype.trim(). Keep SQL
 * eligibility checks aligned with the gateway's runtime empty-output guard,
 * including Unicode space separators and the byte-order mark. */
export const ECMASCRIPT_TRIM_CHARACTERS =
  "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680" +
  "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a" +
  "\u2028\u2029\u202f\u205f\u3000\ufeff";

// Pure copies of two text helpers the gap code needs, so the Worker bundle can
// use them:
//   stripQuoted  from src/voice.js (not exported there; src/voice.js stays
//                unchanged)
//   normalize    from scripts/verify-cases.js, which imports node:child_process
//                and so can't be bundled
// test/gaps-text.test.js holds each copy equal in behavior to its original
// over a shared corpus. Change the original and this copy together.

/** Remove what is quoted rather than asserted: code spans and blocks, quoted strings, block quotes. */
export function stripQuoted(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    // A quotation opens at the start or after space/brackets, so an inch mark
    // (6") can't swallow the sentences that follow it.
    .replace(/(^|[\s(\[])"[^"\n]*"(?=$|[\s.,;:!?)\]])/g, '$1 ')
    .replace(/“[^”\n]*”/g, ' ')
    .replace(/^>.*$/gm, ' ');
}

/** verify-cases' comparison form: entities and typographic marks folded, whitespace collapsed, lowercased. */
export function normalize(s) {
  return display(s).toLowerCase();
}

/** The same cleanup without lowercasing, for quoting text back. */
export function display(s) {
  return String(s)
    .replace(/­/g, '')
    .replace(/[‘’′]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/&nbsp;| /g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;|&rsquo;|&lsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/\s+/g, ' ');
}

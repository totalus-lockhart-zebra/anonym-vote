// Drop a tiny `{"type":"module"}` package.json next to the ESM build
// output so Node and bundlers treat the `.js` files as ES modules.
//
// We do this instead of renaming the output files to `.mjs` because
// tsc's `--outFile` and emit pipeline don't natively support `.mjs`,
// and a sidecar package.json is the officially-recommended pattern
// for dual-format packages — the ESM output inherits its module
// format from the nearest package.json, not from the top-level one.
import { writeFileSync, mkdirSync } from 'node:fs';

mkdirSync('dist/esm', { recursive: true });
writeFileSync('dist/esm/package.json', '{"type":"module"}\n');

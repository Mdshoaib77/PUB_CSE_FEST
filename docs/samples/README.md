# Certificate samples

`individual`, `winner`, `runner-up`, `team-of-6`, `team-of-20` (PDF) + PNG previews of the two team samples.

**These were rendered with `scripts/pdfkit-stub` (an offline stand-in), not with real pdfkit**: gradients are solid, images are
skipped, text metrics are the real Helvetica/Times AFM widths. After `npm install`, regenerate with the real library:

    npx tsx --tsconfig scripts/samples.tsconfig.json scripts/samples.ts   # remove the "pdfkit" path entry from that tsconfig first

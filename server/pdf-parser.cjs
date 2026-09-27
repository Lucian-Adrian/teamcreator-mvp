const pdfParse = require('pdf-parse');

const maxPages = Math.max(1, Math.min(500, Number.parseInt(process.argv[2] || '500', 10) || 500));
const maxChars = Math.max(1_000, Math.min(2_000_000, Number.parseInt(process.argv[3] || '2000000', 10) || 2_000_000));
const chunks = [];
let inputBytes = 0;
let failed = false;

process.stdin.on('data', (chunk) => {
  inputBytes += chunk.length;
  if (inputBytes > 16 * 1024 * 1024) {
    failed = true;
    process.stderr.write('PDF input exceeds the 16 MB per-file limit.');
    process.exitCode = 2;
    process.stdin.destroy();
    return;
  }
  chunks.push(chunk);
});

process.stdin.on('end', async () => {
  if (failed) return;
  try {
    const result = await pdfParse(Buffer.concat(chunks), { max: maxPages });
    const text = typeof result.text === 'string' ? result.text : '';
    process.stdout.write(JSON.stringify({
      text: text.slice(0, maxChars),
      pages: Number.isInteger(result.numpages) ? result.numpages : 0,
      clipped: text.length > maxChars,
    }));
  } catch (error) {
    process.stderr.write(error instanceof Error ? error.message.slice(0, 1_000) : 'PDF parsing failed.');
    process.exitCode = 1;
  }
});

import { FLIGHTBOX_VERSION } from '../dump/serializer';
import { openCommand } from './open';
import { doctorCommand } from './doctor';

const USAGE = `flightbox v${FLIGHTBOX_VERSION}

Usage:
  flightbox open <source> [--port N] [--no-open]
      Open an incident in the bundled local viewer (fully offline).
      <source>: a local .fbox file, s3://bucket/key, or an https:// URL
      (remote sources are downloaded with THIS machine's credentials —
       works inside air-gapped VPCs and over SSH tunnels).

  flightbox doctor
      Verify config, staging dir, disk headroom, S3 credentials chain,
      sink connectivity, and bucket CORS for magic links.

  flightbox --version
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  switch (command) {
    case 'open': {
      const source = argv[1];
      if (!source) {
        process.stderr.write('flightbox open: missing <source>\n');
        process.exit(1);
      }
      const portIdx = argv.indexOf('--port');
      const port = portIdx !== -1 ? Number(argv[portIdx + 1]) : 4560;
      const openBrowser = !argv.includes('--no-open');
      try {
        await openCommand(source, { port, openBrowser });
        // Keeps serving until Ctrl-C.
      } catch (err) {
        process.stderr.write(`flightbox open: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }
    case 'doctor':
      process.exit(await doctorCommand());
      break;
    case '--version':
    case '-v':
      process.stdout.write(`${FLIGHTBOX_VERSION}\n`);
      break;
    case undefined:
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      break;
    default:
      process.stdout.write(USAGE);
      process.exit(1);
  }
}

void main();

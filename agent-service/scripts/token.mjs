// Prints a signed widget token for testing the deployed API without the playground.
// Usage (after `npm run build`):  npm run -s token -w agent-service -- [uid] [name]
import { signUserToken } from '../dist/auth/userToken.js';

try {
  process.loadEnvFile();
} catch {
  // Use the real environment.
}

const secret = process.env.WIDGET_TOKEN_SECRET;
if (!secret) {
  console.error('WIDGET_TOKEN_SECRET is not set in agent-service/.env');
  process.exit(1);
}

const [uid = 'deploy-test', name] = process.argv.slice(2);
console.log(signUserToken({ uid, ...(name && { name }), exp: Math.floor(Date.now() / 1000) + 3600 }, secret));

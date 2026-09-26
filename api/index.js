// Vercel Function: the whole chat backend (Gemini agent + in-process MCP data server).
// Uses the output of `npm run build`; routing and static files are configured in /vercel.json.
// Not used on a VPS, where `npm start` / PM2 runs agent-service/dist/index.js instead.
export { default } from '../agent-service/dist/vercel.js';

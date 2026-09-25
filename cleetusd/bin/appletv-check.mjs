// Read-only connection check; never presses a remote button.
import { appleTVStatus, appleTVCatalog, closeAppleTV } from '../src/appletv.mjs';
try {
  const state = await appleTVStatus();
  console.log(JSON.stringify(state, null, 2));
  if (state.ok) console.log(JSON.stringify(await appleTVCatalog(), null, 2));
  if (!state.ok) process.exitCode = 1;
} finally { closeAppleTV(); }

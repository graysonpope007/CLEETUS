#!/usr/bin/env python3
"""
Fixes context.ts to deduplicate simultaneous vault fetches across tabs.
Run: python3 fix_vault_context.py
"""
import sys, shutil
from pathlib import Path

TARGET = Path.home() / "cleetus-app" / "services" / "context.ts"
if not TARGET.exists():
    print(f"ERROR: Not found: {TARGET}")
    sys.exit(1)

shutil.copy(TARGET, str(TARGET) + ".bak")
print("Backup written (.bak)")

OLD = '''\
let cachedContext: VaultContext | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 60 * 1000; // 1 minute — keeps it fresh during chat

export async function loadVaultContext(force = false): Promise<VaultContext> {
  const now = [Date.now](http://Date.now)();
  if (!force && cachedContext && now - cacheTime < CACHE_TTL_MS) {
    return cachedContext;
  }

  try {
    const url = `${SUPABASE_URL}/storage/v1/object/public/creo-config/grayson-context.json?t=${now}`;
    const res = await fetch(url, { headers: { apikey: SUPABASE_ANON_KEY } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as VaultContext;
    data.updated = data._synced_at ?? new Date().toISOString();
    cachedContext = data;
    cacheTime = now;
    return cachedContext;
  } catch (e) {
    console.warn('Failed to load vault context:', e);
    return {
      user: 'Grayson Pope, 21, Athens GA, musician and entrepreneur.',
      memory: 'No memory loaded.',
      soul: 'Warm, direct, Southern-friendly. Never mention alcohol. Tree-nut allergy for Finley.',
      projects: {},
      people: {},
      resources: {},
      updated: 'unknown',
    };
  }
}'''

NEW = '''\
let cachedContext: VaultContext | null = null;
let cacheTime = 0;
let pendingFetch: Promise<VaultContext> | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const FALLBACK: VaultContext = {
  user: 'Grayson Pope, 21, Athens GA, musician and entrepreneur.',
  memory: 'No memory loaded — run vault_sync.py to push context to Supabase.',
  soul: 'Warm, direct, Southern-friendly. Never mention alcohol. Tree-nut allergy for Finley.',
  projects: {},
  people: {},
  resources: {},
  updated: 'unknown',
};

export async function loadVaultContext(force = false): Promise<VaultContext> {
  const now = Date.now();

  // Serve cache if fresh
  if (!force && cachedContext && now - cacheTime < CACHE_TTL_MS) {
    return cachedContext;
  }

  // Deduplicate: if a fetch is already in flight, wait for it instead of firing another
  if (pendingFetch) return pendingFetch;

  pendingFetch = (async () => {
    try {
      if (!SUPABASE_URL) throw new Error('SUPABASE_URL not set');
      const url = `${SUPABASE_URL}/storage/v1/object/public/creo-config/grayson-context.json?t=${now}`;
      const res = await fetch(url, { headers: { apikey: SUPABASE_ANON_KEY } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as VaultContext;
      data.updated = data._synced_at ?? new Date().toISOString();
      cachedContext = data;
      cacheTime = now;
      return cachedContext;
    } catch (e: any) {
      // Only log on the very first failure — not on every tab mount
      if (!cachedContext) {
        console.log(
          `[vault] Context unavailable (${e?.message ?? e}). ` +
          'Run vault_sync.py to push grayson-context.json to Supabase. Using fallback.',
        );
      }
      return cachedContext ?? { ...FALLBACK };
    } finally {
      pendingFetch = null;
    }
  })();

  return pendingFetch;
}'''

src = TARGET.read_text()

if 'pendingFetch' in src:
    print("Fix already applied — nothing to do.")
    sys.exit(0)

# Try exact match first
if OLD in src:
    src = src.replace(OLD, NEW)
    print("context.ts ✓ applied deduplication fix (exact match)")
else:
    # Fallback: replace just the function signature + body with looser pattern
    import re
    pat = re.compile(
        r'let cachedContext.*?'
        r'export async function loadVaultContext.*?'
        r'\n\}',
        re.DOTALL,
    )
    if pat.search(src):
        src = pat.sub(NEW, src, count=1)
        print("context.ts ✓ applied deduplication fix (pattern match)")
    else:
        print("WARNING: Could not auto-patch. Apply the change manually (see diff below).")
        print("\n--- Replace this block in services/context.ts ---")
        print("let cachedContext: VaultContext | null = null;")
        print("let cacheTime = 0;")
        print("const CACHE_TTL_MS = ...")
        print("  --> with the pendingFetch version from the GitHub script.")
        sys.exit(1)

TARGET.write_text(src)
print("context.ts — done")
print()
print("The 4x repeated warning is now suppressed to a single log line.")
print()
print("To load real vault data, run vault_sync.py from your Mac to push")
print("grayson-context.json to your Supabase 'creo-config' bucket.")

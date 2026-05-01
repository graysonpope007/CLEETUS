#!/usr/bin/env python3
"""
Applies the Schwab OAuth fix to ~/cleetus-app.
Run: python3 fix_schwab.py
"""
import re, shutil, sys
from pathlib import Path

APP    = Path.home() / "cleetus-app"
SCHWAB = APP / "services" / "schwab.ts"
MONEY  = APP / "app" / "(tabs)" / "money.tsx"

def bail(msg):
    print(f"ERROR: {msg}")
    sys.exit(1)

if not SCHWAB.exists(): bail(f"Not found: {SCHWAB}")
if not MONEY.exists():  bail(f"Not found: {MONEY}")

shutil.copy(SCHWAB, str(SCHWAB) + ".bak")
shutil.copy(MONEY,  str(MONEY)  + ".bak")
print("Backups written (.bak)\n")

# ── SCHWAB.TS ────────────────────────────────────────────────────────────────

s = SCHWAB.read_text()

# Remove AuthSession import
s = s.replace("import * as AuthSession from 'expo-auth-session';\n", "")

# Remove maybeCompleteAuthSession (only needed for Expo proxy flow)
s = s.replace("\nWebBrowser.maybeCompleteAuthSession();\n", "\n")

# Replace the discovery export block with startSchwabAuth
START_AUTH = """\
// ─── Auth ────────────────────────────────────────────────────────────────────

/**
 * Opens Schwab login in-app and returns the OAuth code.
 * Plain code flow — no PKCE (Schwab does not support PKCE).
 * The browser closes automatically when Schwab redirects to REDIRECT_URI.
 */
export async function startSchwabAuth(): Promise<string | null> {
  const state = Math.random().toString(36).substring(2, 18);

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'readonly',
    state,
  });

  const result = await WebBrowser.openAuthSessionAsync(
    `${AUTH_URL}?${params.toString()}`,
    REDIRECT_URI,
  );

  if (result.type !== 'success') return null;

  try {
    const url = new URL(result.url);
    const code = url.searchParams.get('code');
    const returnedState = url.searchParams.get('state');
    if (!code || returnedState !== state) return null;
    return code;
  } catch {
    return null;
  }
}
"""

# Find and replace the discovery block
disc_pat = re.compile(
    r"// ─+ Auth discovery ─+\r?\n\r?\nexport const discovery = \{.*?\};\r?\n",
    re.DOTALL,
)
if disc_pat.search(s):
    s = disc_pat.sub(START_AUTH, s)
    print("schwab.ts ✓ replaced discovery block with startSchwabAuth")
else:
    # Fallback: insert after REDIRECT_URI line
    s = re.sub(
        r"(export const REDIRECT_URI = '[^']+';)\r?\n",
        r"\1\n\n" + START_AUTH,
        s,
    )
    print("schwab.ts ✓ appended startSchwabAuth after REDIRECT_URI")

SCHWAB.write_text(s)
print("schwab.ts — done\n")

# ── MONEY.TSX ────────────────────────────────────────────────────────────────

m = MONEY.read_text()

# 1. Remove AuthSession import
m = m.replace("import * as AuthSession from 'expo-auth-session';\n", "")
print("money.tsx ✓ removed AuthSession import")

# 2. Remove maybeCompleteAuthSession
m = m.replace("\nWebBrowser.maybeCompleteAuthSession();\n", "\n")

# 3. Remove local CLIENT_ID const (only used by useAuthRequest)
m = re.sub(
    r"\nconst CLIENT_ID = process\.env\.EXPO_PUBLIC_SCHWAB_CLIENT_ID \?\? '';\n",
    "\n",
    m,
)

# 4. Update schwab service import — remove 'discovery', add 'startSchwabAuth'
def fix_schwab_import(text):
    pat = re.compile(
        r"import \{([^}]+)\} from '../../services/schwab';",
        re.DOTALL,
    )
    match = pat.search(text)
    if not match:
        print("WARNING: schwab import block not found — skipping")
        return text
    inner = match.group(1)
    fields = [f.strip() for f in re.split(r",\s*", inner) if f.strip()]
    fields = [f for f in fields if f != "discovery"]
    if "startSchwabAuth" not in fields:
        try:
            idx = fields.index("exchangeCodeForTokens")
            fields.insert(idx + 1, "startSchwabAuth")
        except ValueError:
            fields.append("startSchwabAuth")
    joined = ",\n  ".join(fields)
    replacement = f"import {{\n  {joined},\n}} from '../../services/schwab';"
    result = pat.sub(replacement, text)
    print("money.tsx ✓ updated schwab import")
    return result

m = fix_schwab_import(m)

# 5. Replace useAuthRequest hook + response useEffect
HANDLE_CONNECT = """\
  // ── Schwab OAuth
  const [schwabAuthLoading, setSchwabAuthLoading] = useState(false);

  const handleConnectSchwab = useCallback(async () => {
    setSchwabAuthLoading(true);
    setError(null);
    try {
      const code = await startSchwabAuth();
      if (!code) {
        setError('Schwab connection was cancelled.');
        return;
      }
      const tokens = await exchangeCodeForTokens(code);
      if (tokens) {
        setSchwabConnected(true);
        await loadAll(yearMonth);
      } else {
        setError(
          'Schwab token exchange failed. Verify EXPO_PUBLIC_SCHWAB_CLIENT_ID and ' +
          'EXPO_PUBLIC_SCHWAB_CLIENT_SECRET in .env, and confirm the redirect URI ' +
          'in the Schwab developer portal is exactly: ' +
          'https://graysonpope007.github.io/cleetus-auth/',
        );
      }
    } catch (e: any) {
      setError(`Schwab error: ${e.message}`);
    } finally {
      setSchwabAuthLoading(false);
    }
  }, [yearMonth, loadAll]);\
"""

# Try to find and replace the useAuthRequest block
hook_pat = re.compile(
    r"// ── Schwab OAuth\r?\n\s*const \[request, response, promptAsync\]"
    r" = AuthSession\.useAuthRequest\(.*?\);\r?\n"
    r".*?"
    r"  \}, \[response\]\);",
    re.DOTALL,
)
if hook_pat.search(m):
    m = hook_pat.sub(HANDLE_CONNECT, m)
    print("money.tsx ✓ replaced useAuthRequest + useEffect")
else:
    # Looser: just find from const [request to }, [response]);
    hook_loose = re.compile(
        r"  const \[request, response, promptAsync\] = AuthSession\.useAuthRequest\(.*?"
        r"  \}, \[response\]\);",
        re.DOTALL,
    )
    if hook_loose.search(m):
        m = hook_loose.sub(HANDLE_CONNECT, m)
        print("money.tsx ✓ replaced useAuthRequest block (loose match)")
    else:
        print("WARNING: could not auto-replace useAuthRequest — apply step 5 manually")

# 6. Update the onConnectSchwab prop
before = m
m = re.sub(r"onConnectSchwab=\{\(\) => promptAsync\(\)\}", "onConnectSchwab={handleConnectSchwab}", m)
if m != before:
    print("money.tsx ✓ updated onConnectSchwab prop")
else:
    m = re.sub(r"onConnectSchwab=\{[^}]*promptAsync[^}]*\}", "onConnectSchwab={handleConnectSchwab}", m)
    print("money.tsx ✓ updated onConnectSchwab prop (pattern 2)")

MONEY.write_text(m)
print("money.tsx — done\n")

print("=" * 52)
print("All changes applied.")
print("Next: npx expo start --clear")
print()
print("Also verify in Schwab developer portal that the")
print("registered redirect URI is exactly:")
print("  https://graysonpope007.github.io/cleetus-auth/")
print("=" * 52)

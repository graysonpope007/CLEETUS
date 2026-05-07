# CLEETUS — Deployment Guide

## 1. Web App (Render.com)

### One-time setup
1. Go to [render.com](https://render.com) and sign in
2. Click **New → Web Service**
3. Connect your GitHub repo: `graysonpope007/CLEETUS`
4. Render will auto-detect `render.yaml` — click **Apply**
5. Add the secret environment variable: `ANTHROPIC_API_KEY` = your key
6. Click **Create Web Service**
7. Your URL: `https://cleetus.onrender.com` (or similar)

> Free tier spins down after inactivity — first request takes ~30s to wake.
> Upgrade to $7/mo Starter plan for always-on.

---

## 2. Live Preview (GitHub Pages)

### One-time setup
1. Go to your repo → **Settings → Pages**
2. Under **Source**, select **GitHub Actions**
3. Push to `main` branch — the workflow auto-deploys
4. Your URL: `https://graysonpope007.github.io/CLEETUS/`

This hosts the preview (mock data, no backend needed).

---

## 3. iOS App (App Store)

### Prerequisites
- Apple Developer account ($99/yr): [developer.apple.com](https://developer.apple.com)
- Node.js 18+ installed
- EAS CLI: `npm install -g eas-cli`

### Setup
```bash
cd mobile
npm install
eas login          # log in with your Apple ID
eas build:configure  # links to your Apple Developer account
```

### Update eas.json
Fill in your Apple credentials in `mobile/eas.json`:
- `appleId`: your Apple ID email
- `ascAppId`: App Store Connect app ID (create at appstoreconnect.apple.com)
- `appleTeamId`: found at developer.apple.com/account

### Update API URL
```bash
cp .env.example .env
# Edit .env and set EXPO_PUBLIC_API_URL to your Render URL
```

### Build for App Store
```bash
npm run build:ios        # builds production IPA
```

### Submit to App Store
```bash
npm run submit:ios       # uploads to App Store Connect
```

Then go to [appstoreconnect.apple.com](https://appstoreconnect.apple.com):
- Fill in app metadata (description, screenshots, category)
- Submit for review (~24-48hr review time)

---

## App Structure

```
mobile/
  App.js                    — entry point, fonts, tab navigation
  app.json                  — Expo config (bundle ID, version)
  eas.json                  — Build + submission config
  src/
    api.js                  — All API calls to backend
    theme.js                — Colors, fonts, radii
    screens/
      DashboardScreen.js    — Home: stats, recent chats, quick actions
      ChatScreen.js         — Chat with SSE streaming
      ChatsScreen.js        — Conversation list
      MemoryScreen.js       — Searchable memory browser
      SMSScreen.js          — SMS list + send modal
    components/
      Message.js            — Chat bubble component
```

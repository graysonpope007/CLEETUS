# 🍋 Sweet Tea Pedigree — Shopify Theme

Official Shopify theme for **Sweet Tea Pedigree**, built on [Dawn](https://github.com/Shopify/dawn).

---

## 🚀 Quick Setup

### Step 1 — Push to GitHub

```bash
cd sweet-tea-pedigree-shopify
git init
git add .
git commit -m "Initial Sweet Tea Pedigree theme"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/sweet-tea-pedigree-shopify.git
git push -u origin main
```
> Replace `YOUR_USERNAME` with your actual GitHub username.

### Step 2 — Connect to Shopify

1. Shopify Admin → **Online Store → Themes**
2. Click **Add theme → Connect from GitHub**
3. Install the Shopify GitHub app
4. Select this repo and the `main` branch
5. Shopify installs the theme automatically ✅

### Step 3 — Go live

1. Click **Customize** on the new theme
2. Upload band photo + logo in the Hero Banner section
3. Fill in tour dates, music links, video URLs
4. Click **Publish**

---

## 📁 Key Files

```
sections/
  stp-hero-banner.liquid    ← Band photo + CTA buttons
  stp-music.liquid          ← Music releases grid
  stp-tour.liquid           ← Tour dates (edit these!)
  stp-videos.liquid         ← YouTube videos grid
  stp-newsletter.liquid     ← Email signup

snippets/
  stp-global-styles.liquid  ← All colors, fonts & brand styles

assets/
  stp_logo_transparent.png  ← Band logo
  stp-banner-photo.jpeg     ← Header band photo

templates/
  index.json                ← Homepage (STP sections pre-configured)
```

---

## ✏️ Common Updates

### Add a tour date
Open `sections/stp-tour.liquid` and copy one of the `<div class="stp-show">` blocks. Update the date, venue, city, and ticket link.

### Add a music release
Open `sections/stp-music.liquid` and copy one of the music card blocks. Update the title and streaming link.

### Change a color
Open `snippets/stp-global-styles.liquid` and edit the `:root` variables:
```css
--yellow:     #EDD835;   /* Accent */
--green-deep: #1A5C45;   /* Nav + footer */
--sky-light:  #C4DDE8;   /* Page background */
```

### Add Brim Narrow font
1. Buy from [yellowdesignstudio.com](https://yellowdesignstudio.com)
2. Drop `brim-narrow.woff2` + `brim-narrow.woff` into `assets/`
3. Uncomment the `@font-face` block in `snippets/stp-global-styles.liquid`

---

## 🔄 Deploying Changes

Every push to `main` auto-updates your Shopify store:
```bash
git add .
git commit -m "describe your change here"
git push
```

---

## 🎨 Brand Colors

| Color | Hex |
|---|---|
| Yellow | `#EDD835` |
| Sky Blue | `#A8CEDE` |
| Green | `#4BAE8A` |
| Green Dark | `#2D7A5F` |
| Green Deep | `#1A5C45` |

---

Built on [Shopify Dawn](https://github.com/Shopify/dawn) — MIT License.

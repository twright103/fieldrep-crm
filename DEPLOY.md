# Putting the App Online (GitHub Pages) — First-Time Walkthrough

This publishes the app's code (and only the code — no customer data, no
secrets; those stay in your Google Sheet and on your devices) to a free
public web address you can open on any device. About 15 minutes.

## Part 1 — One-time GitHub setup

1. Go to https://github.com/signup and create a free account
   (use your normal email; pick any username — it becomes part of the
   app's web address, e.g. `toddwright.github.io/fieldrep-crm`).

2. Once signed in, click the **+** in the top-right corner → **New repository**.

3. Fill in:
   - **Repository name:** `fieldrep-crm`
   - **Public** (required for free GitHub Pages — remember, code only)
   - Check **"Add a README file"** (this matters — it lets you upload
     files through the browser right away)

4. Click **Create repository**.

## Part 2 — Upload the app

5. On your new repository's page, click **Add file → Upload files**.

6. In Finder, open `Documents/Claude/fieldrep-crm/app` and select
   **everything inside it** (Cmd+A) — `index.html`, `manifest.json`,
   `sw.js`, and the `css`, `js`, `icons` folders — and drag it all onto
   the GitHub upload page. (Drag the *contents* of the `app` folder, not
   the `app` folder itself — `index.html` must end up at the top level.)
   You can skip `DEPLOY.md`; it doesn't matter if it comes along.

7. Wait for the file list to finish, then click **Commit changes**.

## Part 3 — Turn on the website

8. In the repository, go to **Settings** (tab at the top) → **Pages**
   (left sidebar).

9. Under **Build and deployment → Source**, choose **Deploy from a
   branch**; set **Branch** to `main` and the folder to `/ (root)`.
   Click **Save**.

10. Wait 1–2 minutes, refresh the page, and a banner appears:
    *"Your site is live at `https://YOURNAME.github.io/fieldrep-crm/`"*.
    That address is your app. Bookmark it.

## Part 4 — Install it on your devices

11. **iPhone / iPad:** open the address in **Safari** → tap the Share
    button → **Add to Home Screen** → Add. A FieldRep icon appears like
    a real app.
12. **Desktop Chrome:** open the address → click the install icon at the
    right end of the address bar ("Install FieldRep CRM").
13. Open the app. The first-run screen asks for your **Web App URL** and
    **API token** (the two secrets from the backend setup). Paste them,
    tap **Connect & download data**, and after the one-time download
    (~2,700 companies takes a few seconds) you're in.
    Repeat on each device — the secrets are typed once per device.

## Updating the app later

When the code changes (Phase 3 adds the map, etc.): repeat Part 2 —
upload the changed files over the old ones and commit. The live site
updates in about a minute; installed apps pick it up on next launch.
(If you'd rather never do manual uploads, ask Claude to set up `git`
so updates publish with one command.)

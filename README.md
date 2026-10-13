# 🏡 Cosy Chores

A cosy, installable web app for sharing housework with your family.

- **Chore board**: drag chores between family members (works with touch: press and hold, then drag). Tap the dots to tick a chore off. Each dot shows who did it.
- **Default plan + weekly copies**: each new week starts as a copy of the default plan. Changing one week doesn't touch the plan. Changing the plan updates any upcoming weeks nobody has edited yet. From a week's `⋯` menu you can make that week the default plan, or start the week over from the plan.
- **Time tracking**: give each chore a rough time per go, per day, per week or per month. The Time tab shows each person's planned and done minutes for the week, plus past weeks.
- **Notes board**: pin notes for today or a future day. Everyone gets a notification: straight away for today's notes, and at 8am on the day for future ones.
- **Reminders**: one-off or repeating (daily, weekdays, weekly, monthly), for one person or everyone, sent as push notifications.

Built with React + Vite. It runs on Cloudflare Workers with a D1 (SQLite) database, which fits in Cloudflare's free plan.

## Run it locally

```sh
npm install
npm run vapid -- mailto:you@example.com   # makes push keys in .dev.vars
npm run db:migrate:local
npm run dev                                # http://localhost:5173
```

To trigger the reminder scheduler by hand during development, open `http://localhost:5173/cdn-cgi/handler/scheduled`.

`npm test` runs the unit tests: time maths, timezone and repeat handling, and push encryption (checked against an independent decryptor).

## Put it online for the family

1. Sign in to Cloudflare: `npx wrangler login`
2. Create the database: `npx wrangler d1 create cosy-chores`. Paste the `database_id` it prints into `wrangler.jsonc`.
3. Apply the schema: `npm run db:migrate:remote`
4. Add the push keys as secrets. Use the same values as `.dev.vars`, or run `npm run vapid` again:
   ```sh
   npx wrangler secret put VAPID_PUBLIC_KEY
   npx wrangler secret put VAPID_PRIVATE_KEY
   npx wrangler secret put VAPID_SUBJECT
   ```
5. Deploy: `npm run deploy`. You'll get a `https://cosy-chores.<you>.workers.dev` URL.

### Automatic deploys

`.github/workflows/deploy.yml` deploys every push to `master`. It runs the tests, applies any new migrations, then deploys. It needs two repository secrets (Settings → Secrets and variables → Actions):

- `CLOUDFLARE_ACCOUNT_ID`: shown by `npx wrangler whoami`
- `CLOUDFLARE_API_TOKEN`: create one at dash.cloudflare.com → My Profile → API Tokens → **Edit Cloudflare Workers** template, plus the permission **Account → D1 → Edit**

Then on each phone, open the URL:

- **iPhone/iPad (iOS 16.4+)**: Safari → Share → **Add to Home Screen**, then open it from the Home Screen and turn on notifications under **Family**. iOS only allows push for installed web apps.
- **Android / desktop Chrome or Edge**: use **Install app** from the browser menu (or the button under Family), then turn on notifications.

The first person creates the household. Everyone else picks **Join with an invite code**, using the code shown under **Family**.

## How it fits together

| Path | What's there |
|---|---|
| `src/` | The app: `ChoresBoard.tsx` (drag & drop), `Today.tsx` (notes), `Reminders.tsx`, `TimeStats.tsx`, `Family.tsx` |
| `worker/index.ts` | JSON API under `/api/*`, plus the every-minute cron for reminders and day-ahead notes |
| `worker/push.ts` | Web Push (VAPID + aes128gcm encryption) using only WebCrypto |
| `shared/core.ts` | Types, time-estimate maths and timezone helpers used by both |
| `migrations/` | D1 schema |
| `public/sw.js` | Service worker: offline shell, notifications |

**Privacy note:** anyone with the invite code can join the household. Each device gets its own sign-in token, and the server stores only a hash of it. There are no per-person passwords, because it's built for a family that trusts each other.
